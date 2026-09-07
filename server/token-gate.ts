import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import { getAgentWalletAddress as getCdpWalletAddress } from "./providers/cdp-solana.js";
import { getAgentWalletAddress as getCrossmintWalletAddress } from "./providers/crossmint-wallets.js";
import { isSupabaseConfigured, supabaseAdmin } from "./supabase.js";
import type { AgentManager } from "./manager.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const TOKEN_MINT = "CxThkADKK4DDYqB8GBPaEAgRBzwxyPyUhFcBUmiAzN6N";
export const GATE_ROOM_ID = "holders-lounge";
export const MIN_BALANCE = 10_000;
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const NONCE_MAX_AGE_MS = 5 * 60 * 1000;

// Ed25519 SPKI prefix (DER encoding for raw 32-byte public key)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VerificationRecord {
  walletAddress: string;
  method: string;
  expiresAt: Date;
}

export interface TokenCheckResult {
  holds: boolean;
  balance: bigint;
  decimals: number;
}

// ── Nonce ─────────────────────────────────────────────────────────────────────

export function generateNonce(): string {
  return randomUUID();
}

export function buildSignMessage(nonce: string): string {
  const ts = Date.now();
  return `Agent Heights Token Gate\nNonce: ${nonce}\nTimestamp: ${ts}\nRoom: holders-lounge`;
}

export function validateNonceFreshness(message: string): boolean {
  const match = message.match(/Timestamp: (\d+)/);
  if (!match) return false;
  const ts = parseInt(match[1], 10);
  return Date.now() - ts < NONCE_MAX_AGE_MS;
}

// ── Signature Verification ────────────────────────────────────────────────────

export function verifyEd25519Signature(
  message: string,
  signatureBase64: string,
  publicKeyBase58: string,
): boolean {
  try {
    const pubKeyBytes = bs58.decode(publicKeyBase58);
    if (pubKeyBytes.length !== 32) return false;

    const spkiKey = Buffer.concat([ED25519_SPKI_PREFIX, pubKeyBytes]);
    const keyObj = createPublicKey({ key: spkiKey, format: "der", type: "spki" });

    const msgBytes = Buffer.from(message, "utf-8");
    const sigBytes = Buffer.from(signatureBase64, "base64");

    return cryptoVerify(null, msgBytes, keyObj, sigBytes);
  } catch (err) {
    console.error("[token-gate] Signature verification failed:", err);
    return false;
  }
}

// ── Token Balance Check ───────────────────────────────────────────────────────

function getTokenGateRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  return "https://api.mainnet-beta.solana.com";
}

export async function checkTokenHolding(
  walletAddress: string,
  tokenMint: string = TOKEN_MINT,
): Promise<TokenCheckResult> {
  const conn = new Connection(getTokenGateRpcUrl(), "confirmed");
  const owner = new PublicKey(walletAddress);

  // Use getParsedTokenAccountsByOwner (like cdp-solana.ts) — getTokenAccountsByOwner
  // with jsonParsed encoding can fail depending on @solana/web3.js version.
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  const [splAccounts, t2022Accounts] = await Promise.allSettled([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const allAccounts: { account: { data: any } }[] = [];
  if (splAccounts.status === "fulfilled") allAccounts.push(...splAccounts.value.value);
  if (t2022Accounts.status === "fulfilled") allAccounts.push(...t2022Accounts.value.value);

  console.log(`[token-gate] getParsedTokenAccountsByOwner for ${walletAddress} — found ${allAccounts.length} total token accounts`);

  let totalBalance = 0n;
  let decimals = 0;

  for (const account of allAccounts) {
    const parsed = (account.account.data as any)?.parsed;
    if (!parsed || parsed.type !== "account") continue;
    const info = parsed.info;
    if (!info) continue;
    // Filter by mint
    if (info.mint !== tokenMint) continue;
    const amountStr = info.tokenAmount?.amount;
    if (amountStr) {
      totalBalance += BigInt(amountStr);
    }
    if (info.tokenAmount?.decimals) {
      decimals = info.tokenAmount.decimals;
    }
  }

  const minRaw = BigInt(MIN_BALANCE) * BigInt(10) ** BigInt(decimals);
  console.log(`[token-gate] balance=${totalBalance} decimals=${decimals} minRaw=${minRaw} holds=${totalBalance >= minRaw}`);
  return { holds: totalBalance >= minRaw, balance: totalBalance, decimals };
}

// ── Agent Wallet Check ────────────────────────────────────────────────────────

export async function checkAgentWalletsForToken(
  manager: AgentManager,
  tokenMint: string = TOKEN_MINT,
): Promise<{ holds: boolean; walletAddress: string } | null> {
  const agents = manager["agents"] as Map<string, { info: { cdpSolana?: boolean; crossmintWallet?: boolean; id: string } }>;
  if (!agents) return null;

  const checks: Promise<{ address: string } | null>[] = [];

  for (const rt of agents.values()) {
    if (rt.info.cdpSolana) {
      checks.push(
        getCdpWalletAddress(rt.info.id).then((addr) => (addr ? { address: addr } : null)),
      );
    }
    if (rt.info.crossmintWallet) {
      checks.push(
        getCrossmintWalletAddress(rt.info.id).then((addr) => (addr ? { address: addr } : null)),
      );
    }
  }

  const results = await Promise.allSettled(checks);
  const addresses = results
    .filter((r): r is PromiseFulfilledResult<{ address: string }> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value.address);

  for (const addr of addresses) {
    try {
      const result = await checkTokenHolding(addr, tokenMint);
      if (result.holds) {
        return { holds: true, walletAddress: addr };
      }
    } catch (err) {
      console.error(`[token-gate] Failed to check token holding for ${addr}:`, err);
    }
  }

  return null;
}

// ── DB Persistence ────────────────────────────────────────────────────────────

export async function getVerificationFromDB(
  userId: string,
  tokenMint: string = TOKEN_MINT,
): Promise<VerificationRecord | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("heights_cloud_token_gate_verifications")
      .select("wallet_address, verification_method, expires_at")
      .eq("user_id", userId)
      .eq("token_mint", tokenMint)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (error || !data) return null;
    return {
      walletAddress: data.wallet_address,
      method: data.verification_method,
      expiresAt: new Date(data.expires_at),
    };
  } catch (err) {
    console.error("[token-gate] Failed to read verification from DB:", err);
    return null;
  }
}

export async function saveVerificationToDB(
  userId: string,
  walletAddress: string,
  method: string,
  balance: bigint,
  tokenMint: string = TOKEN_MINT,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
    await supabaseAdmin
      .from("heights_cloud_token_gate_verifications")
      .upsert({
        user_id: userId,
        wallet_address: walletAddress,
        verification_method: method,
        token_mint: tokenMint,
        balance_at_verification: balance.toString(),
        verified_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
  } catch (err) {
    console.error("[token-gate] Failed to save verification to DB:", err);
  }
}

// ── Full Verification (Phantom path) ──────────────────────────────────────────

export async function verifyTokenGate(
  userId: string,
  walletAddress: string,
  signature: string,
  message: string,
  manager: AgentManager,
): Promise<{ success: boolean; error?: string; method?: string }> {
  // 1. Validate nonce freshness
  if (!validateNonceFreshness(message)) {
    return { success: false, error: "Message signature has expired. Please try again." };
  }

  // 2. Verify Ed25519 signature
  if (!verifyEd25519Signature(message, signature, walletAddress)) {
    return { success: false, error: "Invalid signature. Wallet ownership could not be verified." };
  }

  // 3. Check token holding on-chain
  let tokenResult: TokenCheckResult;
  try {
    tokenResult = await checkTokenHolding(walletAddress);
  } catch (err) {
    console.error("[token-gate] RPC error checking token balance:", err);
    return { success: false, error: "Failed to check token balance. Please try again later." };
  }

  if (!tokenResult.holds) {
    const humanBalance = Number(tokenResult.balance) / Math.pow(10, tokenResult.decimals);
    return {
      success: false,
      error: `Insufficient token balance. You need ${MIN_BALANCE.toLocaleString()}+ tokens. Your balance: ${humanBalance.toLocaleString()}.`,
    };
  }

  // 4. Persist verification to DB (24h TTL)
  await saveVerificationToDB(userId, walletAddress, "phantom", tokenResult.balance);

  return { success: true, method: "phantom" };
}
