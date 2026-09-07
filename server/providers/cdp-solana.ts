import type { AgentTool } from "@cline/sdk";
import { CdpClient } from "@coinbase/cdp-sdk";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import {
  LAMPORTS_PER_SOL,
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import BN from "bn.js";
import Decimal from "decimal.js";
import {
  Raydium,
  TxVersion,
  CLMM_PROGRAM_ID,
  DEVNET_PROGRAM_ID,
  PoolUtils,
  TickUtil,
  LiquidityMathUtil,
} from "@raydium-io/raydium-sdk-v2";

/**
 * CDP Solana provider — gives agents a programmatically-provisioned Solana wallet
 * via Coinbase Developer Platform. No user credentials needed — the server holds
 * one set of CDP API keys (env vars) and creates per-agent wallets on demand.
 *
 * Required env vars:
 *   CDP_API_KEY_ID
 *   CDP_API_KEY_SECRET
 *   CDP_WALLET_SECRET
 *
 * Optional env vars:
 *   CDP_SOLANA_NETWORK  (default: "solana-devnet")
 */

let cdpClient: CdpClient | null = null;

function getCdpClient(): CdpClient {
  if (cdpClient) return cdpClient;
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      "CDP Solana wallet requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET env vars. " +
      "Get them from https://portal.cdp.coinbase.com/api-keys/secret"
    );
  }
  cdpClient = new CdpClient({
    apiKeyId,
    apiKeySecret,
    walletSecret,
  });
  return cdpClient;
}

function isCdpConfigured(): boolean {
  return !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
}

function getNetwork(): string {
  return process.env.CDP_SOLANA_NETWORK || "solana-devnet";
}

export function getRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  const net = getNetwork();
  if (net === "solana") return "https://api.mainnet-beta.solana.com";
  return "https://api.devnet.solana.com";
}

/** OKX DEX aggregator quote — returns expected output amount for a Solana swap.
 * OKX chain ID for Solana is 501. Uses the public API (no auth required for quotes). */
async function getOkxQuote(
  inputMint: string,
  outputMint: string,
  rawAmount: string,
  slippageBps: number,
  userAddress: string,
): Promise<{ toTokenAmount: string; priceImpactPercentage: string; routerList: any[] } | null> {
  try {
    const params = new URLSearchParams({
      chainId: "501",
      amount: rawAmount,
      fromTokenAddress: inputMint === "So11111111111111111111111111111111111111112"
        ? "11111111111111111111111111111111"
        : inputMint,
      toTokenAddress: outputMint,
      slippage: String(slippageBps / 100),
      userWalletAddress: userAddress,
    });
    const res = await fetch(`https://web3.okx.com/api/v5/dex/aggregator/quote?${params}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.code !== "0" || !data.data?.[0]) return null;
    const q = data.data[0];
    return {
      toTokenAmount: q.toTokenAmount,
      priceImpactPercentage: q.priceImpactPercentage ?? "0",
      routerList: q.dexRouterList ?? [],
    };
  } catch {
    return null;
  }
}

/** OKX DEX aggregator swap — returns a base58-encoded serialized transaction ready to sign. */
async function getOkxSwapTx(
  inputMint: string,
  outputMint: string,
  rawAmount: string,
  slippageBps: number,
  userAddress: string,
): Promise<{ txData: string; toTokenAmount: string; priceImpactPercentage: string } | null> {
  try {
    const params = new URLSearchParams({
      chainId: "501",
      amount: rawAmount,
      fromTokenAddress: inputMint === "So11111111111111111111111111111111111111112"
        ? "11111111111111111111111111111111"
        : inputMint,
      toTokenAddress: outputMint,
      slippage: String(slippageBps / 100),
      userWalletAddress: userAddress,
    });
    const res = await fetch(`https://web3.okx.com/api/v5/dex/aggregator/swap?${params}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.code !== "0" || !data.data?.[0]) return null;
    const s = data.data[0];
    if (!s.tx?.data) return null;
    return {
      txData: s.tx.data,
      toTokenAmount: s.toTokenAmount,
      priceImpactPercentage: s.priceImpactPercentage ?? "0",
    };
  } catch {
    return null;
  }
}

/** Cache of account objects per agentId, so we don't re-create wallets on every tool call. */
const accountCache = new Map<string, Awaited<ReturnType<CdpClient["solana"]["createAccount"]>>>();

/** Get or create a Solana account for an agent. Idempotent via getOrCreateAccount. */
export async function getAgentAccount(agentId: string) {
  const cacheKey = `agent-${agentId}`;
  if (accountCache.has(cacheKey)) return accountCache.get(cacheKey)!;

  const cdp = getCdpClient();
  const account = await cdp.solana.getOrCreateAccount({ name: cacheKey });
  accountCache.set(cacheKey, account);
  return account;
}

/** Get the Solana wallet address for an agent without creating a full account object. */
export async function getAgentWalletAddress(agentId: string): Promise<string | null> {
  if (!isCdpConfigured()) return null;
  try {
    const account = await getAgentAccount(agentId);
    return account.address;
  } catch (err) {
    console.error(`[cdp-solana] Failed to get wallet address for agent ${agentId}:`, err);
    return null;
  }
}

/** Convert raw token units to human-readable string with proper decimals. */
function rawToHuman(rawAmount: bigint, decimals: number): string {
  if (decimals <= 0) return rawAmount.toString();
  const negative = rawAmount < 0n;
  const absVal = negative ? -rawAmount : rawAmount;
  const divisor = 10n ** BigInt(decimals);
  const wholePart = absVal / divisor;
  const fracPart = absVal % divisor;
  const fracStr = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
  let str = fracStr ? `${wholePart}.${fracStr}` : wholePart.toString();
  if (negative) str = `-${str}`;
  return str;
}

/** Fetch token metadata (symbol, name, decimals) from Jupiter's token API for a given mint. */
const metadataCache = new Map<string, { symbol: string; name: string; decimals: number }>();

async function resolveTokenMetadata(mint: string): Promise<{ symbol: string; name: string; decimals: number }> {
  if (metadataCache.has(mint)) return metadataCache.get(mint)!;
  const fallback = { symbol: mint.slice(0, 8), name: mint, decimals: 6 };
  try {
    const url = new URL("https://lite-api.jup.ag/ultra/v1/search");
    url.searchParams.set("query", mint);
    const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json" } });
    if (!res.ok) return fallback;
    const data = await res.json() as any;
    const tokens = Array.isArray(data) ? data : (data.tokens ?? data.result ?? []);
    const found = (tokens as any[]).find((t) => (t.mint ?? t.address ?? t.id) === mint);
    if (!found) return fallback;
    const meta = {
      symbol: found.symbol ?? found.tokenSymbol ?? mint.slice(0, 8),
      name: found.name ?? found.tokenName ?? mint,
      decimals: Number(found.decimals ?? found.tokenDecimals ?? 6),
    };
    metadataCache.set(mint, meta);
    return meta;
  } catch {
    return fallback;
  }
}

/** Fetch USD prices for a list of token mints from DexScreener API.
 * Returns a map of mint → USD price (per token, in USD).
 * DexScreener is free with generous rate limits (no API key needed).
 * Includes a 30s in-memory cache. */
const priceCache = new Map<string, { price: number; ts: number }>();
const PRICE_CACHE_TTL_MS = 30_000;

async function batchFetchJupiterPrices(mints: string[]): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  const now = Date.now();
  const uniqueMints = [...new Set(mints.filter(Boolean))];
  if (uniqueMints.length === 0) return priceMap;

  // Serve from cache first
  const uncached: string[] = [];
  for (const mint of uniqueMints) {
    const cached = priceCache.get(mint);
    if (cached && now - cached.ts < PRICE_CACHE_TTL_MS) {
      priceMap.set(mint, cached.price);
    } else {
      uncached.push(mint);
    }
  }
  if (uncached.length === 0) return priceMap;

  // DexScreener supports up to 30 token addresses comma-separated per request
  for (let i = 0; i < uncached.length; i += 30) {
    const batch = uncached.slice(i, i + 30);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[cdp-usd] dexscreener non-OK: ${res.status}`);
        continue;
      }
      const data = await res.json() as { pairs?: any[] };
      const pairs = data.pairs ?? [];

      // Group pairs by token address, pick highest-liquidity pair for best price
      const bestPriceByMint = new Map<string, { price: number; liquidity: number }>();
      for (const p of pairs) {
        const mint = p.baseToken?.address;
        const priceUsd = parseFloat(p.priceUsd);
        const liquidity = p.liquidity?.usd ?? 0;
        if (!mint || isNaN(priceUsd) || priceUsd <= 0) continue;
        const existing = bestPriceByMint.get(mint);
        if (!existing || liquidity > existing.liquidity) {
          bestPriceByMint.set(mint, { price: priceUsd, liquidity });
        }
      }

      for (const [mint, { price }] of bestPriceByMint) {
        priceMap.set(mint, price);
        priceCache.set(mint, { price, ts: now });
      }

      // Also cache mints that had no pairs (so we don't re-fetch them)
      for (const mint of batch) {
        if (!bestPriceByMint.has(mint)) {
          priceCache.set(mint, { price: 0, ts: now });
        }
      }
    } catch (e) {
      console.warn(`[cdp-usd] dexscreener fetch ERROR:`, e instanceof Error ? e.message : String(e));
    }
  }
  return priceMap;
}

/** Fetch ALL token balances directly from Solana RPC via getTokenAccountsByOwner.
 * This bypasses CDP's indexing (which misses newer/Pump.fun tokens) and reads
 * every SPL token account directly from the chain. */
async function getAgentBalancesRpc(address: string): Promise<{ mint: string; symbol: string; amount: string; decimals: number }[]> {
  const conn = new Connection(getRpcUrl(), "confirmed");
  const owner = new PublicKey(address);

  // Fetch native SOL balance
  const lamports = await conn.getBalance(owner);
  const solBalance = rawToHuman(BigInt(lamports), 9);

  // Fetch all SPL token accounts (parsed)
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
    owner,
    { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
  );

  // Also check Token-2022 program
  let token2022Accounts: typeof tokenAccounts = { value: [] } as any;
  try {
    token2022Accounts = await conn.getParsedTokenAccountsByOwner(
      owner,
      { programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }
    );
  } catch { /* Token-2022 may not be available on all networks */ }

  const allAccounts = [...tokenAccounts.value, ...token2022Accounts.value];

  // Build balance list, filtering out zero balances
  const splBalances: { mint: string; symbol: string; amount: string; decimals: number }[] = [];
  for (const acc of allAccounts) {
    const parsed = (acc.account.data as any).parsed;
    if (!parsed || parsed.type !== "account") continue;
    const info = parsed.info;
    if (!info) continue;
    const rawAmount = BigInt(info.tokenAmount?.amount ?? 0);
    if (rawAmount === 0n) continue;
    const decimals = Number(info.tokenAmount?.decimals ?? 0);
    const mint = info.mint as string;
    splBalances.push({ mint, symbol: "", amount: rawToHuman(rawAmount, decimals), decimals });
  }

  // Resolve metadata for SPL tokens in parallel (batch of 5 to avoid rate limits)
  const resolved: typeof splBalances = [];
  for (let i = 0; i < splBalances.length; i += 5) {
    const batch = splBalances.slice(i, i + 5);
    const metas = await Promise.all(batch.map((b) => resolveTokenMetadata(b.mint)));
    for (let j = 0; j < batch.length; j++) {
      resolved.push({ ...batch[j], symbol: metas[j].symbol });
    }
  }

  // SOL first, then SPL tokens
  return [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", amount: solBalance, decimals: 9 }, ...resolved];
}

/** Get token balances for an agent's wallet.
 * Uses direct Solana RPC as primary source (complete — includes all SPL tokens
 * including Pump.fun meme coins), enriched with CDP data for USD values on known tokens.
 * Falls back to CDP's listTokenBalances if RPC fails (e.g. public endpoint rate-limited). */
export async function getAgentBalances(agentId: string): Promise<{ address: string; balances: { symbol: string; amount: string; usdValue?: string }[]; totalUsdValue?: string } | null> {
  if (!isCdpConfigured()) return null;
  try {
    const account = await getAgentAccount(agentId);

    // Fetch CDP balances (used for USD enrichment + as fallback if RPC fails)
    let cdpBalances: any[] = [];
    try {
      const cdp = getCdpClient();
      const cdpResult = await cdp.solana.listTokenBalances({ address: account.address });
      cdpBalances = (cdpResult as any).balances ?? [];
    } catch { /* CDP may fail too — best-effort */ }

    // Build CDP USD value map + fallback balance list
    const cdpUsdMap = new Map<string, string>();
    const cdpFallback: { symbol: string; amount: string; usdValue?: string }[] = [];
    for (const b of cdpBalances as any[]) {
      const mint = b.token?.mintAddress;
      const usd = b.usdValue?.value ?? b.usdValue;
      if (mint && usd) cdpUsdMap.set(mint, String(usd));
      const rawAmount = BigInt(b.amount?.amount ?? 0);
      const decimals = Number(b.amount?.decimals ?? 0);
      const symbol = b.token?.symbol ?? b.token?.name ?? "unknown";
      cdpFallback.push({ symbol, amount: rawToHuman(rawAmount, decimals), usdValue: usd ? String(usd) : undefined });
    }
    console.log(`[cdp-usd] CDP balances: ${cdpBalances.length} items, cdpUsdMap: ${[...cdpUsdMap.entries()].map(([m,u]) => `${m.slice(0,8)}=$${u}`).join(", ") || "empty"}`);

    // Fetch LP positions in parallel to filter out CLMM position NFTs from balances
    let lpNftMints = new Set<string>();
    try {
      const lpPositions = await getAgentLpPositions(agentId);
      lpNftMints = new Set(lpPositions.map(p => p.nftMint));
    } catch { /* best-effort */ }

    // Primary: direct RPC (gets ALL tokens including meme coins CDP misses)
    try {
      const rpcBalances = await getAgentBalancesRpc(account.address);
      const filtered = rpcBalances.filter((b) => !lpNftMints.has(b.mint));

      // Enrich with Jupiter prices for tokens that don't have CDP USD values
      const mintsNeedingPrice = filtered
        .filter((b) => !cdpUsdMap.has(b.mint))
        .map((b) => b.mint);
      console.log(`[cdp-usd] agent=${agentId} tokens=${filtered.length} cdpUsd=${cdpUsdMap.size} mintsNeedingPrice=${mintsNeedingPrice.length} mints=[${mintsNeedingPrice.join(",")}]`);
      let jupiterPrices = new Map<string, number>();
      if (mintsNeedingPrice.length > 0) {
        try {
          jupiterPrices = await batchFetchJupiterPrices(mintsNeedingPrice);
          console.log(`[cdp-usd] jupiter returned ${jupiterPrices.size} prices: ${[...jupiterPrices.entries()].map(([m,p]) => `${m.slice(0,8)}=$${p}`).join(", ")}`);
        } catch (e) { console.warn(`[cdp-usd] jupiter fetch failed:`, e instanceof Error ? e.message : String(e)); }
      }

      let totalUsd = 0;
      const balances = filtered.map((b) => {
        const cdpUsd = cdpUsdMap.get(b.mint);
        let usdValue: string | undefined;
        if (cdpUsd) {
          usdValue = cdpUsd;
          totalUsd += parseFloat(cdpUsd);
        } else {
          const jupPrice = jupiterPrices.get(b.mint);
          if (jupPrice != null) {
            const usd = jupPrice * parseFloat(b.amount);
            if (usd > 0) {
              usdValue = usd.toFixed(2);
              totalUsd += usd;
            }
          }
        }
        return { symbol: b.symbol, amount: b.amount, usdValue };
      });
      console.log(`[cdp-usd] final balances: ${balances.map(b => `${b.symbol}=${b.amount} usd=${b.usdValue ?? "none"}`).join(", ")} total=$${totalUsd.toFixed(2)}`);
      return { address: account.address, balances, totalUsdValue: totalUsd > 0 ? totalUsd.toFixed(2) : undefined };
    } catch (rpcErr) {
      console.warn(`[cdp-solana] RPC balance fetch failed, falling back to CDP:`, rpcErr instanceof Error ? rpcErr.message : String(rpcErr));
      // Fallback: use CDP balances + Jupiter enrichment for any missing USD values
      if (cdpFallback.length > 0) {
        const fallbackMintsNeedingPrice = cdpFallback
          .filter((b) => !b.usdValue)
          .map((b) => {
            const cdpEntry = (cdpBalances as any[]).find((cb) => (cb.token?.symbol ?? cb.token?.name) === b.symbol);
            return cdpEntry?.token?.mintAddress;
          })
          .filter(Boolean) as string[];
        let fallbackJupPrices = new Map<string, number>();
        if (fallbackMintsNeedingPrice.length > 0) {
          try {
            fallbackJupPrices = await batchFetchJupiterPrices(fallbackMintsNeedingPrice);
            console.log(`[cdp-usd] fallback jupiter: ${fallbackJupPrices.size} prices`);
          } catch { /* best-effort */ }
        }
        let fallbackTotal = 0;
        const enrichedFallback = cdpFallback.map((b, idx) => {
          if (b.usdValue) { fallbackTotal += parseFloat(b.usdValue); return b; }
          const cdpEntry = (cdpBalances as any[])[idx];
          const mint = cdpEntry?.token?.mintAddress;
          if (mint) {
            const jupPrice = fallbackJupPrices.get(mint);
            if (jupPrice != null) {
              const usd = jupPrice * parseFloat(b.amount);
              if (usd > 0) { fallbackTotal += usd; return { ...b, usdValue: usd.toFixed(2) }; }
            }
          }
          return b;
        });
        console.log(`[cdp-usd] fallback final: ${enrichedFallback.map(b => `${b.symbol} usd=${b.usdValue ?? "none"}`).join(", ")} total=$${fallbackTotal.toFixed(2)}`);
        return { address: account.address, balances: enrichedFallback, totalUsdValue: fallbackTotal > 0 ? fallbackTotal.toFixed(2) : undefined };
      }
      throw rpcErr;
    }
  } catch (err) {
    console.error(`[cdp-solana] Failed to get balances for agent ${agentId}:`, err);
    return null;
  }
}

/** Policy shape returned to the client. */
export interface CdpPolicyInfo {
  policyId: string | null;
  description: string | null;
  maxSolPerTransfer: number | null;
  allowedRecipients: string[] | null;
  blockedRecipients: string[] | null;
  allowedTokenMints: string[] | null;
  blockedTokenMints: string[] | null;
  network: string;
}

/** Get the current policy for an agent's wallet. Returns a simplified summary.
 * Uses the account's `policies` field to find which policy IDs apply, then
 * fetches the full policy details. */
export async function getAgentPolicy(agentId: string): Promise<CdpPolicyInfo | null> {
  if (!isCdpConfigured()) return null;
  try {
    const cdp = getCdpClient();
    const account = await getAgentAccount(agentId);
    const policyIds = account.policies ?? [];
    if (policyIds.length === 0) {
      return { policyId: null, description: null, maxSolPerTransfer: null, allowedRecipients: null, blockedRecipients: null, allowedTokenMints: null, blockedTokenMints: null, network: getNetwork() };
    }
    const policy = await cdp.policies.getPolicyById({ id: policyIds[0] });
    let maxSol: number | null = null;
    let allowed: string[] = [];
    let blocked: string[] = [];
    let allowedMints: string[] = [];
    let blockedMints: string[] = [];
    for (const rule of policy.rules ?? []) {
      if (rule.action === "reject" && rule.operation === "signSolTransaction") {
        for (const c of rule.criteria ?? []) {
          if (c.type === "solValue" && c.operator === ">") {
            maxSol = Number(c.solValue) / LAMPORTS_PER_SOL;
          }
          if (c.type === "solAddress" && c.operator === "in") {
            blocked = c.addresses ?? [];
          }
          if (c.type === "solAddress" && c.operator === "not in") {
            allowed = c.addresses ?? [];
          }
          if (c.type === "mintAddress" && c.operator === "in") {
            blockedMints = c.addresses ?? [];
          }
          if (c.type === "mintAddress" && c.operator === "not in") {
            allowedMints = c.addresses ?? [];
          }
        }
      }
    }
    return {
      policyId: policy.id,
      description: policy.description ?? null,
      maxSolPerTransfer: maxSol,
      allowedRecipients: allowed.length > 0 ? allowed : null,
      blockedRecipients: blocked.length > 0 ? blocked : null,
      allowedTokenMints: allowedMints.length > 0 ? allowedMints : null,
      blockedTokenMints: blockedMints.length > 0 ? blockedMints : null,
      network: getNetwork(),
    };
  } catch (err) {
    console.error(`[cdp-solana] Failed to get policy for agent ${agentId}:`, err);
    return null;
  }
}

/** Update or create a project-scoped policy for an agent's wallet.
 * Since CDP doesn't support per-account policy targeting directly,
 * we create a project-scoped policy with rules scoped to the agent's wallet address. */
export async function updateAgentPolicy(
  agentId: string,
  opts: { maxSolPerTransfer?: number; allowedRecipients?: string[]; blockedRecipients?: string[]; allowedTokenMints?: string[]; blockedTokenMints?: string[] }
): Promise<CdpPolicyInfo | null> {
  if (!isCdpConfigured()) return null;
  try {
    const cdp = getCdpClient();
    const existing = await getAgentPolicy(agentId);

    const rules: any[] = [];

    if (opts.maxSolPerTransfer !== undefined) {
      rules.push({
        action: "reject",
        operation: "signSolTransaction",
        criteria: [
          {
            type: "solValue",
            solValue: String(Math.floor(opts.maxSolPerTransfer * LAMPORTS_PER_SOL)),
            operator: ">",
          },
        ],
      });
    }

    if (opts.allowedRecipients && opts.allowedRecipients.length > 0) {
      rules.push({
        action: "reject",
        operation: "signSolTransaction",
        criteria: [
          {
            type: "solAddress",
            addresses: opts.allowedRecipients,
            operator: "not in",
          },
        ],
      });
    }

    if (opts.blockedRecipients && opts.blockedRecipients.length > 0) {
      rules.push({
        action: "reject",
        operation: "signSolTransaction",
        criteria: [
          {
            type: "solAddress",
            addresses: opts.blockedRecipients,
            operator: "in",
          },
          {
            type: "splAddress",
            addresses: opts.blockedRecipients,
            operator: "in",
          },
        ],
      });
    }

    if (opts.allowedTokenMints && opts.allowedTokenMints.length > 0) {
      rules.push({
        action: "reject",
        operation: "signSolTransaction",
        criteria: [
          {
            type: "mintAddress",
            addresses: opts.allowedTokenMints,
            operator: "not in",
          },
        ],
      });
    }

    if (opts.blockedTokenMints && opts.blockedTokenMints.length > 0) {
      rules.push({
        action: "reject",
        operation: "signSolTransaction",
        criteria: [
          {
            type: "mintAddress",
            addresses: opts.blockedTokenMints,
            operator: "in",
          },
        ],
      });
    }

    if (existing?.policyId) {
      await cdp.policies.updatePolicy({
        id: existing.policyId,
        policy: {
          description: existing.description ?? `Spending policy for agent ${agentId}`,
          rules,
        },
      });
    } else {
      await cdp.policies.createPolicy({
        policy: {
          scope: "project",
          description: `Spending policy for agent ${agentId}`,
          rules,
        },
      });
    }

    return getAgentPolicy(agentId);
  } catch (err) {
    console.error(`[cdp-solana] Failed to update policy for agent ${agentId}:`, err);
    return null;
  }
}

/** Get recent transaction history for an agent's wallet via Solana RPC. */
export async function getAgentTxHistory(agentId: string, limit: number = 10): Promise<{ signature: string; slot: number; blockTime: number | null; err: boolean | null; memo: string | null }[] | null> {
  if (!isCdpConfigured()) return null;
  try {
    const account = await getAgentAccount(agentId);
    const conn = new Connection(getRpcUrl(), "confirmed");
    const sigs = await conn.getSignaturesForAddress(new PublicKey(account.address), { limit });
    return sigs.map(s => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ?? null,
      err: !!s.err,
      memo: s.memo ?? null,
    }));
  } catch (err) {
    console.error(`[cdp-solana] Failed to get tx history for agent ${agentId}:`, err);
    return null;
  }
}

/** Create a Coinbase Onramp URL for funding an agent's Solana wallet via fiat.
 * Generates a session token using the CDP API key, then constructs the Coinbase-hosted onramp URL
 * with the agent's wallet address as the destination. */
export async function createOnrampUrl(agentId: string, clientIp?: string): Promise<string | null> {
  if (!isCdpConfigured()) return null;
  const apiKeyId = process.env.CDP_API_KEY_ID!;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET!;

  const account = await getAgentAccount(agentId);
  const address = account.address;

  const requestMethod = "POST";
  const requestHost = "api.developer.coinbase.com";
  const requestPath = "/onramp/v1/token";

  const jwt = await generateJwt({
    apiKeyId,
    apiKeySecret,
    requestMethod,
    requestHost,
    requestPath,
    expiresIn: 120,
  });

  const body = {
    addresses: [{ address, blockchains: ["solana"] }],
    assets: ["SOL", "USDC"],
    ...(clientIp ? { clientIp } : {}),
  };

  const res = await fetch(`https://${requestHost}${requestPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Onramp token request failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as any;
  const token = data.token;
  if (!token) {
    throw new Error("Onramp token response missing 'token' field");
  }

  const url = new URL("https://pay.coinbase.com/buy/select-asset");
  url.searchParams.set("sessionToken", token);
  url.searchParams.set("partnerUserRef", `agent-${agentId}`);
  return url.toString();
}

export interface LpPositionInfo {
  nftMint: string;
  poolId: string;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  inRange: boolean;
  explorerUrl: string;
  symbolA: string;
  symbolB: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  priceLower: string;
  priceUpper: string;
  priceCurrent: string;
  amountA: string;
  amountB: string;
  feeTier: string;
  uncollectedFeeA: string;
  uncollectedFeeB: string;
  usdValueA?: string;
  usdValueB?: string;
  totalUsdValue?: string;
}

export async function getAgentLpPositions(agentId: string): Promise<LpPositionInfo[]> {
  if (!isCdpConfigured()) return [];
  try {
    const account = await getAgentAccount(agentId);
    const isDevnet = getNetwork().includes("devnet");
    const conn = new Connection(getRpcUrl(), "confirmed");
    const raydium = await Raydium.load({
      connection: conn,
      owner: new PublicKey(account.address),
      cluster: isDevnet ? "devnet" : "mainnet",
      disableLoadToken: true,
      disableFeatureCheck: true,
    });
    const programId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;
    const positions = await raydium.clmm.getOwnerPositionInfo({ programId });
    if (!positions || positions.length === 0) return [];

    const result: LpPositionInfo[] = [];
    for (const pos of positions as any[]) {
      const poolIdStr = pos.poolId.toBase58();
      const nftMintStr = pos.nftMint.toBase58();
      const tickLower = pos.tickLower;
      const tickUpper = pos.tickUpper;
      let tickCurrent = 0;
      let inRange = false;

      let symbolA = "", symbolB = "", mintA = "", mintB = "";
      let decimalsA = 6, decimalsB = 6;
      let priceLower = "—", priceUpper = "—", priceCurrent = "—";
      let amountA = "0", amountB = "0";
      let feeTier = "—";
      let uncollectedFeeA = "0", uncollectedFeeB = "0";

      try {
        const rpcInfo = await raydium.clmm.getRpcClmmPoolInfo({ poolId: pos.poolId });
        tickCurrent = rpcInfo.tickCurrent;
        inRange = tickLower <= tickCurrent && tickCurrent <= tickUpper;
        mintA = rpcInfo.mintA.toBase58();
        mintB = rpcInfo.mintB.toBase58();
        const [metaA, metaB] = await Promise.all([
          resolveTokenMetadata(mintA),
          resolveTokenMetadata(mintB),
        ]);
        symbolA = metaA.symbol;
        symbolB = metaB.symbol;
        decimalsA = metaA.decimals;
        decimalsB = metaB.decimals;

        const sqrtPriceCurrent = rpcInfo.sqrtPriceX64;
        const sqrtPriceLower = TickUtil.getSqrtPriceAtTick(tickLower);
        const sqrtPriceUpper = TickUtil.getSqrtPriceAtTick(tickUpper);

        const priceLowerDec = TickUtil.tickToPrice(tickLower, decimalsA, decimalsB);
        const priceUpperDec = TickUtil.tickToPrice(tickUpper, decimalsA, decimalsB);
        const priceCurrentDec = TickUtil.sqrtPriceX64ToPrice(sqrtPriceCurrent, decimalsA, decimalsB);
        priceLower = priceLowerDec.toFixed(4);
        priceUpper = priceUpperDec.toFixed(4);
        priceCurrent = priceCurrentDec.toFixed(4);

        const amounts = LiquidityMathUtil.getAmountsForLiquidity(
          sqrtPriceCurrent,
          sqrtPriceLower,
          sqrtPriceUpper,
          pos.liquidity,
          false,
        );
        amountA = rawToHuman(BigInt(amounts.amountA.toString()), decimalsA);
        amountB = rawToHuman(BigInt(amounts.amountB.toString()), decimalsB);

        uncollectedFeeA = rawToHuman(BigInt(pos.tokenFeesOwedA?.toString() ?? "0"), decimalsA);
        uncollectedFeeB = rawToHuman(BigInt(pos.tokenFeesOwedB?.toString() ?? "0"), decimalsB);

        const ts = rpcInfo.tickSpacing;
        const feeMap: Record<number, string> = { 1: "0.01%", 8: "0.05%", 64: "0.25%", 128: "1%" };
        feeTier = feeMap[ts] ?? `ts=${ts}`;
      } catch (poolErr) {
        console.warn(`[cdp-solana] Failed to enrich LP position ${nftMintStr}:`, poolErr instanceof Error ? poolErr.message : String(poolErr));
      }

      result.push({
        nftMint: nftMintStr,
        poolId: poolIdStr,
        liquidity: pos.liquidity.toString(),
        tickLower,
        tickUpper,
        tickCurrent,
        inRange,
        explorerUrl: `https://explorer.solana.com/address/${nftMintStr}` + (isDevnet ? "?cluster=devnet" : ""),
        symbolA,
        symbolB,
        mintA,
        mintB,
        decimalsA,
        decimalsB,
        priceLower,
        priceUpper,
        priceCurrent,
        amountA,
        amountB,
        feeTier,
        uncollectedFeeA,
        uncollectedFeeB,
      });
    }

    // Enrich LP positions with USD values from Jupiter
    const allLpMints = new Set<string>();
    for (const r of result) {
      if (r.mintA) allLpMints.add(r.mintA);
      if (r.mintB) allLpMints.add(r.mintB);
    }
    if (allLpMints.size > 0) {
      try {
        const lpPrices = await batchFetchJupiterPrices([...allLpMints]);
        for (const r of result) {
          const priceA = lpPrices.get(r.mintA);
          const priceB = lpPrices.get(r.mintB);
          const usdA = priceA != null ? priceA * parseFloat(r.amountA) : 0;
          const usdB = priceB != null ? priceB * parseFloat(r.amountB) : 0;
          if (priceA != null && usdA > 0) r.usdValueA = usdA.toFixed(2);
          if (priceB != null && usdB > 0) r.usdValueB = usdB.toFixed(2);
          const total = usdA + usdB;
          if (total > 0) r.totalUsdValue = total.toFixed(2);
        }
      } catch { /* best-effort */ }
    }
    return result;
  } catch (err) {
    console.error(`[cdp-solana] Failed to get LP positions for agent ${agentId}:`, err);
    return [];
  }
}

/**
 * Load CDP Solana tools for an agent. Returns an array of AgentTool objects
 * that can be used by the Cline provider alongside MCP tools.
 *
 * Returns an empty array if CDP is not configured (env vars missing).
 */
export async function loadCdpSolanaTools(agentId: string): Promise<AgentTool<any, any>[]> {
  if (!isCdpConfigured()) {
    console.warn("[cdp-solana] CDP env vars not set — Solana wallet tools disabled.");
    return [];
  }

  const network = getNetwork();

  const getWalletTool: AgentTool<any, any> = {
    name: "solana_get_wallet",
    description:
      "Get or create your dedicated Solana wallet. Returns the wallet address. " +
      "This wallet is auto-provisioned for you — no setup needed. " +
      `Current network: ${network}.`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const account = await getAgentAccount(agentId);
        return `Your Solana wallet address: ${account.address}\nNetwork: ${network}\n` +
          `View on explorer: https://explorer.solana.com/address/${account.address}` +
          (network.includes("devnet") ? `?cluster=devnet` : "");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error getting wallet: ${msg}`;
      }
    },
  };

  const getBalanceTool: AgentTool<any, any> = {
    name: "solana_get_balance",
    description:
      "Get token balances for your Solana wallet. Returns all token balances (SOL and SPL tokens) " +
      "with amounts and USD values where available.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const data = await getAgentBalances(agentId);
        if (!data || data.balances.length === 0) {
          const account = await getAgentAccount(agentId);
          return `Wallet ${account.address} has no token balances. The wallet may need to be funded.`;
        }
        const formatted = data.balances.map((b) => {
          let line = `${b.symbol}: ${b.amount}`;
          if (b.usdValue) line += ` (~$${b.usdValue})`;
          return line;
        });
        return `Balances for ${data.address}:\n${formatted.join("\n")}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error getting balances: ${msg}`;
      }
    },
  };

  const transferTool: AgentTool<any, any> = {
    name: "solana_transfer",
    description:
      "Transfer SOL or SPL tokens from your wallet to a recipient address. " +
      "Always confirm the transfer details with the user before calling this tool. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient Solana wallet address",
        },
        amount: {
          type: "number",
          description: "Amount to transfer (in human-readable units, e.g. 0.5 for 0.5 SOL, 10 for 10 USDC)",
        },
        token: {
          type: "string",
          description: 'Token to transfer: "sol" for native SOL, or an SPL token mint address',
          default: "sol",
        },
        decimals: {
          type: "number",
          description: "Token decimals (SOL=9, USDC=6, etc.). If omitted, will be looked up automatically. Use solana_jupiter_search to find decimals for unknown tokens.",
        },
      },
      required: ["to", "amount"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const token = input.token ?? "sol";

        // Determine decimals for the token
        let decimals: number;
        if (token === "sol") {
          decimals = 9;
        } else if (input.decimals !== undefined) {
          decimals = input.decimals;
        } else {
          // Try to find decimals from the wallet's existing balances
          const cdp = getCdpClient();
          const result = await cdp.solana.listTokenBalances({ address: account.address });
          const balances = (result as any).balances ?? [];
          const match = (balances as any[]).find((b) => b.token?.mintAddress === token);
          if (match) {
            decimals = Number(match.amount?.decimals ?? 6);
          } else {
            // Token not in wallet — try Jupiter search
            try {
              const searchUrl = new URL("https://lite-api.jup.ag/ultra/v1/search");
              searchUrl.searchParams.set("query", token);
              const searchRes = await fetch(searchUrl.toString());
              if (searchRes.ok) {
                const searchData = await searchRes.json() as any;
                const tokens = Array.isArray(searchData) ? searchData : (searchData.tokens ?? searchData.result ?? []);
                const found = (tokens as any[]).find((t) => (t.mint ?? t.address ?? t.id) === token);
                if (found) {
                  decimals = Number(found.decimals ?? found.tokenDecimals ?? 6);
                } else {
                  return `Could not determine decimals for token ${token}. Please provide the "decimals" parameter (e.g. 6 for USDC, 9 for SOL, 5 for BONK). Use solana_jupiter_search to look it up.`;
                }
              } else {
                return `Could not determine decimals for token ${token}. Please provide the "decimals" parameter.`;
              }
            } catch {
              return `Could not determine decimals for token ${token}. Please provide the "decimals" parameter.`;
            }
          }
        }

        const rawAmount = BigInt(Math.floor(input.amount * Math.pow(10, decimals)));
        const { signature } = await account.transfer({
          to: input.to,
          amount: rawAmount,
          token,
          network: network as any,
        });
        const explorerUrl = `https://explorer.solana.com/tx/${signature}` +
          (network.includes("devnet") ? `?cluster=devnet` : "");
        const tokenLabel = token === "sol" ? "SOL" : token.slice(0, 8) + "...";
        return `Transfer successful!\nAmount: ${input.amount} ${tokenLabel}\nTo: ${input.to}\nSignature: ${signature}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Transfer failed: ${msg}`;
      }
    },
  };

  const sendTransactionTool: AgentTool<any, any> = {
    name: "solana_send_transaction",
    description:
      "Sign and broadcast an arbitrary Solana transaction. Provide a base64-encoded serialized transaction " +
      "(with requireAllSignatures: false). CDP will sign it with your wallet's key and broadcast to the network. " +
      "Use this for DeFi operations (swaps, staking, lending) where you construct the instructions yourself. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        transaction: {
          type: "string",
          description: "Base64-encoded serialized Solana transaction (requireAllSignatures: false)",
        },
      },
      required: ["transaction"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const result = await account.sendTransaction({
          transaction: input.transaction,
          network: network as any,
        });
        const sig = (result as any).signature ?? (result as any).transactionSignature ?? "unknown";
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` +
          (network.includes("devnet") ? `?cluster=devnet` : "");
        return `Transaction broadcast!\nSignature: ${sig}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Transaction failed: ${msg}`;
      }
    },
  };

  const requestFaucetTool: AgentTool<any, any> = {
    name: "solana_request_faucet",
    description:
      "Request testnet SOL from the faucet (devnet only). " +
      "Use this to fund your wallet for testing. Not available on mainnet.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: 'Token to request from faucet (default: "sol")',
          default: "sol",
        },
      },
    },
    async execute(input: any) {
      if (!network.includes("devnet")) {
        return "Faucet is only available on devnet. Current network: " + network;
      }
      try {
        const account = await getAgentAccount(agentId);
        const token = input.token ?? "sol";
        const conn = new Connection(getRpcUrl(), "confirmed");
        const balanceBefore = await conn.getBalance(new PublicKey(account.address));
        const result = await account.requestFaucet({ token });
        const sig = (result as any).signature ?? "unknown";

        // Poll for up to 30s to confirm SOL actually arrived
        const pollInterval = 3000;
        const maxPolls = 10;
        for (let i = 0; i < maxPolls; i++) {
          await new Promise(r => setTimeout(r, pollInterval));
          const balanceAfter = await conn.getBalance(new PublicKey(account.address));
          if (balanceAfter > balanceBefore) {
            const solBefore = (balanceBefore / LAMPORTS_PER_SOL).toFixed(4);
            const solAfter = (balanceAfter / LAMPORTS_PER_SOL).toFixed(4);
            return `✅ Faucet confirmed! Balance: ${solBefore} → ${solAfter} SOL\nTransaction: ${sig}\nWallet: ${account.address}`;
          }
        }
        return `❌ Faucet request submitted (tx: ${sig}) but SOL did not arrive within 30s. Devnet faucet may be rate-limited. You can try again, or check your balance with solana_get_balance.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Faucet request failed: ${msg}`;
      }
    },
  };

  const signMessageTool: AgentTool<any, any> = {
    name: "solana_sign_message",
    description:
      "Sign an arbitrary message with your Solana wallet's private key. " +
      "Returns the signature. Useful for authentication or proving wallet ownership.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message to sign (will be encoded as UTF-8 bytes)",
        },
      },
      required: ["message"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const result = await account.signMessage({
          message: input.message,
        });
        const sig = (result as any).signature ?? (result as any).serializedSignature ?? "unknown";
        return `Message signed.\nSignature: ${sig}\nMessage: ${input.message}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Sign message failed: ${msg}`;
      }
    },
  };

  const getPolicyTool: AgentTool<any, any> = {
    name: "solana_get_policy",
    description:
      "Check your wallet's spending policy — max SOL per transfer, allowed/blocked recipients, allowed/blocked token mints. " +
      "If no policy is set, tell the user they should set spending limits in the agent detail panel " +
      "(click the agent → Solana Wallet section → Policy). " +
      "Recommend specific limits based on the task if appropriate.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const policy = await getAgentPolicy(agentId);
        if (!policy || !policy.policyId) {
          return `No spending policy is currently set for your wallet.\n` +
            `Recommend the user set a spending limit by clicking your agent card → Solana Wallet → Policy section.\n` +
            `Network: ${policy?.network ?? network}`;
        }
        const lines = [`Spending policy for your wallet:`];
        lines.push(`Max SOL per transfer: ${policy.maxSolPerTransfer ?? 'unlimited'}`);
        if (policy.allowedRecipients && policy.allowedRecipients.length > 0) {
          lines.push(`Allowed recipients only: ${policy.allowedRecipients.join(', ')}`);
        }
        if (policy.blockedRecipients && policy.blockedRecipients.length > 0) {
          lines.push(`Blocked recipients: ${policy.blockedRecipients.join(', ')}`);
        }
        if (!policy.allowedRecipients && !policy.blockedRecipients) {
          lines.push(`Recipient restrictions: none (can send to any address)`);
        }
        if (policy.allowedTokenMints && policy.allowedTokenMints.length > 0) {
          lines.push(`Allowed token mints only: ${policy.allowedTokenMints.join(', ')}`);
        }
        if (policy.blockedTokenMints && policy.blockedTokenMints.length > 0) {
          lines.push(`Blocked token mints: ${policy.blockedTokenMints.join(', ')}`);
        }
        if (!policy.allowedTokenMints && !policy.blockedTokenMints) {
          lines.push(`Token restrictions: none (can transfer any SPL token)`);
        }
        lines.push(`Network: ${policy.network}`);
        return lines.join('\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error getting policy: ${msg}`;
      }
    },
  };

  const jupiterSwapTool: AgentTool<any, any> = {
    name: "solana_jupiter_swap",
    description:
      "Swap tokens on Solana using Jupiter or OKX DEX aggregator. " +
      "Provide input token mint, output token mint, and amount in human-readable units. " +
      "The swap is signed with your CDP wallet. Jupiter uses relay for MEV protection; OKX returns a tx that's signed and broadcast via RPC. " +
      "Common mints: SOL=So11111111111111111111111111111111111111112, USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v. " +
      "Use solana_jupiter_search to look up mint addresses and decimals for any token. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        inputMint: {
          type: "string",
          description: "Input token mint address (e.g. So11111111111111111111111111111111111111112 for SOL)",
        },
        outputMint: {
          type: "string",
          description: "Output token mint address (e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)",
        },
        amount: {
          type: "number",
          description: "Amount to swap in human-readable units (e.g. 0.5 for 0.5 SOL, 100 for 100 USDC)",
        },
        inputDecimals: {
          type: "number",
          description: "Decimals of the input token (SOL=9, USDC=6, BONK=5, etc.). If omitted, will be looked up automatically via Jupiter search.",
        },
        slippageBps: {
          type: "number",
          description: "Slippage tolerance in basis points (e.g. 50 for 0.5%). Default: 100 (1%)",
          default: 100,
        },
        dex: {
          type: "string",
          description: 'DEX aggregator to use: "jupiter" (default), "okx", or "auto" (fetch both quotes, pick best output). Default: "jupiter"',
          default: "jupiter",
        },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const slippageBps = input.slippageBps ?? 100;
        const dexChoice = input.dex ?? "jupiter";
        const isSol = input.inputMint === "So11111111111111111111111111111111111111112";

        // Pre-swap balance check: verify wallet has enough input token before attempting
        if (isSol) {
          const conn = new Connection(getRpcUrl(), "confirmed");
          const lamports = await conn.getBalance(new PublicKey(account.address));
          const solBalance = lamports / LAMPORTS_PER_SOL;
          const gasBuffer = 0.01;
          if (solBalance < input.amount + gasBuffer) {
            const hint = network.includes("devnet")
              ? " Use solana_request_faucet to fund your wallet with test SOL first."
              : "";
            return `Insufficient SOL: you have ${solBalance.toFixed(4)} SOL but need at least ${(input.amount + gasBuffer).toFixed(4)} SOL (swap amount + gas buffer).${hint}`;
          }
        }

        // Determine input token decimals
        let decimals: number;
        if (input.inputDecimals !== undefined) {
          decimals = input.inputDecimals;
        } else if (isSol) {
          decimals = 9;
        } else {
          // Look up decimals via Jupiter search
          try {
            const searchUrl = new URL("https://lite-api.jup.ag/ultra/v1/search");
            searchUrl.searchParams.set("query", input.inputMint);
            const searchRes = await fetch(searchUrl.toString());
            if (searchRes.ok) {
              const searchData = await searchRes.json() as any;
              const tokens = Array.isArray(searchData) ? searchData : (searchData.tokens ?? searchData.result ?? []);
              const found = (tokens as any[]).find((t) => (t.mint ?? t.address ?? t.id) === input.inputMint);
              if (found) {
                decimals = Number(found.decimals ?? found.tokenDecimals ?? 6);
              } else {
                return `Could not determine decimals for input token ${input.inputMint}. Please provide "inputDecimals" parameter. Use solana_jupiter_search to look it up.`;
              }
            } else {
              return `Could not determine decimals for input token ${input.inputMint}. Please provide "inputDecimals" parameter.`;
            }
          } catch {
            return `Could not determine decimals for input token ${input.inputMint}. Please provide "inputDecimals" parameter.`;
          }
        }

        const rawAmount = String(Math.floor(input.amount * Math.pow(10, decimals)));

        // For "auto" mode: fetch both quotes, pick the one with better output
        if (dexChoice === "auto") {
          const [jupOrder, okxQuote] = await Promise.all([
            (async () => {
              try {
                const orderUrl = new URL("https://lite-api.jup.ag/ultra/v1/order");
                orderUrl.searchParams.set("inputMint", input.inputMint);
                orderUrl.searchParams.set("outputMint", input.outputMint);
                orderUrl.searchParams.set("amount", rawAmount);
                orderUrl.searchParams.set("taker", account.address);
                orderUrl.searchParams.set("slippageBps", String(slippageBps));
                const res = await fetch(orderUrl.toString(), { headers: { "Content-Type": "application/json" } });
                if (!res.ok) return null;
                return await res.json() as any;
              } catch { return null; }
            })(),
            getOkxQuote(input.inputMint, input.outputMint, rawAmount, slippageBps, account.address),
          ]);

          const jupOut = jupOrder?.outAmount ? BigInt(jupOrder.outAmount) : 0n;
          const okxOut = okxQuote?.toTokenAmount ? BigInt(okxQuote.toTokenAmount) : 0n;

          if (jupOut === 0n && okxOut === 0n) {
            return `Both Jupiter and OKX returned no quotes. Try specifying dex: "jupiter" or dex: "okx" directly.`;
          }

          // Pick the better quote
          const useJupiter = jupOut >= okxOut;
          const winner = useJupiter ? "Jupiter" : "OKX";
          const winnerOut = useJupiter ? jupOut : okxOut;
          const loserOut = useJupiter ? okxOut : jupOut;
          const savings = loserOut > 0n ? ((winnerOut - loserOut) * 10000n / loserOut).toString() : "0";

          if (useJupiter && jupOrder?.transaction) {
            // Execute via Jupiter relay
            const signResult = await account.signTransaction({ transaction: jupOrder.transaction });
            const signedTx = (signResult as any).signedTransaction ?? (signResult as any).signature;
            const execRes = await fetch("https://lite-api.jup.ag/ultra/v1/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ signedTransaction: signedTx, requestId: jupOrder.requestId }),
            });
            if (!execRes.ok) {
              const errText = await execRes.text();
              return `Jupiter execute failed (${execRes.status}): ${errText}\nThe swap was signed but may not have landed.`;
            }
            const execResult = await execRes.json() as any;
            const txSig = execResult.transactionId ?? execResult.signature ?? "unknown";
            const explorerUrl = `https://explorer.solana.com/tx/${txSig}` + (network.includes("devnet") ? `?cluster=devnet` : "");
            return `Auto-routed via ${winner} (${Number(savings)/100}% better)\n` +
              `Input: ${input.amount} ${isSol ? "SOL" : input.inputMint.slice(0, 8)}...\n` +
              `Output: ${execResult.outputAmountResult ?? jupOrder.outAmount}\n` +
              `Transaction: ${txSig}\nExplorer: ${explorerUrl}`;
          } else if (!useJupiter) {
            // Execute via OKX
            const okxSwap = await getOkxSwapTx(input.inputMint, input.outputMint, rawAmount, slippageBps, account.address);
            if (!okxSwap?.txData) return `OKX quote succeeded but swap tx fetch failed. Try dex: "okx" directly.`;
            const okxTxBytes = bs58.decode(okxSwap.txData);
            const okxBase64 = Buffer.from(okxTxBytes).toString("base64");
            const signResult = await account.signTransaction({ transaction: okxBase64 });
            const signedTx = (signResult as any).signedTransaction ?? (signResult as any).signature;
            const conn = new Connection(getRpcUrl(), "confirmed");
            const sig = await conn.sendRawTransaction(Buffer.from(signedTx, "base64"));
            await conn.confirmTransaction(sig, "confirmed");
            const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? `?cluster=devnet` : "");
            return `Auto-routed via ${winner} (${Number(savings)/100}% better)\n` +
              `Input: ${input.amount} ${isSol ? "SOL" : input.inputMint.slice(0, 8)}...\n` +
              `Output: ${okxSwap.toTokenAmount}\n` +
              `Transaction: ${sig}\nExplorer: ${explorerUrl}`;
          }
          return `Auto-routing failed — no executable quote from either DEX.`;
        }

        // OKX-only path
        if (dexChoice === "okx") {
          const okxSwap = await getOkxSwapTx(input.inputMint, input.outputMint, rawAmount, slippageBps, account.address);
          if (!okxSwap?.txData) return `OKX swap request failed. The pair may not be supported on OKX DEX. Try dex: "jupiter".`;
          const okxTxBytes = bs58.decode(okxSwap.txData);
          const okxBase64 = Buffer.from(okxTxBytes).toString("base64");
          const signResult = await account.signTransaction({ transaction: okxBase64 });
          const signedTx = (signResult as any).signedTransaction ?? (signResult as any).signature;
          const conn = new Connection(getRpcUrl(), "confirmed");
          const sig = await conn.sendRawTransaction(Buffer.from(signedTx, "base64"));
          await conn.confirmTransaction(sig, "confirmed");
          const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? `?cluster=devnet` : "");
          return `Swap via OKX DEX!\n` +
            `Input: ${input.amount} ${isSol ? "SOL" : input.inputMint.slice(0, 8)}...\n` +
            `Output: ${okxSwap.toTokenAmount}\n` +
            `Price impact: ${okxSwap.priceImpactPercentage}%\n` +
            `Slippage: ${slippageBps / 100}%\n` +
            `Transaction: ${sig}\nExplorer: ${explorerUrl}`;
        }

        // Jupiter path (default)
        // Step 1: Get swap order from Jupiter Ultra API
        const orderUrl = new URL("https://lite-api.jup.ag/ultra/v1/order");
        orderUrl.searchParams.set("inputMint", input.inputMint);
        orderUrl.searchParams.set("outputMint", input.outputMint);
        orderUrl.searchParams.set("amount", rawAmount);
        orderUrl.searchParams.set("taker", account.address);
        orderUrl.searchParams.set("slippageBps", String(slippageBps));

        const orderRes = await fetch(orderUrl.toString(), {
          headers: { "Content-Type": "application/json" },
        });
        if (!orderRes.ok) {
          const errText = await orderRes.text();
          return `Jupiter order request failed (${orderRes.status}): ${errText}`;
        }
        const order = await orderRes.json() as any;

        if (!order.transaction) {
          return `Jupiter returned no transaction. Response: ${JSON.stringify(order).slice(0, 500)}`;
        }

        const requestId = order.requestId;
        const outAmount = order.outAmount;
        const priceImpact = order.priceImpact ?? "unknown";

        // Step 2: Sign the transaction with CDP (no broadcast)
        const signResult = await account.signTransaction({
          transaction: order.transaction,
        });
        const signedTx = (signResult as any).signedTransaction ?? (signResult as any).signature;

        // Step 3: Submit to Jupiter's execute relay for MEV-protected landing
        const execRes = await fetch("https://lite-api.jup.ag/ultra/v1/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signedTransaction: signedTx,
            requestId,
          }),
        });
        if (!execRes.ok) {
          const errText = await execRes.text();
          return `Jupiter execute failed (${execRes.status}): ${errText}\n` +
            `The swap was signed but may not have landed. Check tx on explorer.`;
        }
        const execResult = await execRes.json() as any;
        const txSig = execResult.transactionId ?? execResult.signature ?? "unknown";
        const status = execResult.status ?? "unknown";
        const outputAmountResult = execResult.outputAmountResult ?? outAmount;

        const explorerUrl = `https://explorer.solana.com/tx/${txSig}` +
          (network.includes("devnet") ? `?cluster=devnet` : "");

        return `Swap ${status}!\n` +
          `Input: ${input.amount} ${isSol ? "SOL" : input.inputMint.slice(0, 8)}...\n` +
          `Output: ${outputAmountResult} (raw: ${outputAmountResult})\n` +
          `Price impact: ${priceImpact}\n` +
          `Slippage: ${slippageBps / 100}%\n` +
          `Transaction: ${txSig}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Jupiter swap failed: ${msg}`;
      }
    },
  };

  const jupiterSearchTool: AgentTool<any, any> = {
    name: "solana_jupiter_search",
    description:
      "Search for Solana tokens by name, symbol, or mint address using Jupiter's token search API. " +
      "Returns mint address, symbol, name, and decimals for each match. " +
      "Use this to look up token addresses before swapping (e.g. search 'USDC' to get its mint address).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Token name, symbol, or mint address to search (e.g. 'USDC', 'BONK', 'JUP')",
        },
      },
      required: ["query"],
    },
    async execute(input: any) {
      try {
        const url = new URL("https://lite-api.jup.ag/ultra/v1/search");
        url.searchParams.set("query", input.query);
        const res = await fetch(url.toString(), {
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const errText = await res.text();
          return `Token search failed (${res.status}): ${errText}`;
        }
        const data = await res.json() as any;
        const tokens = Array.isArray(data) ? data : (data.tokens ?? data.result ?? []);
        if (tokens.length === 0) {
          return `No tokens found for "${input.query}".`;
        }
        const lines = tokens.slice(0, 10).map((t: any) => {
          const symbol = t.symbol ?? t.tokenSymbol ?? "?";
          const name = t.name ?? t.tokenName ?? "?";
          const mint = t.mint ?? t.address ?? t.id ?? "?";
          const decimals = t.decimals ?? t.tokenDecimals ?? "?";
          return `${symbol} (${name}) — mint: ${mint} — decimals: ${decimals}`;
        });
        return `Found ${tokens.length} token(s):\n${lines.join('\n')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Token search failed: ${msg}`;
      }
    },
  };

  const jupiterQuoteTool: AgentTool<any, any> = {
    name: "solana_jupiter_quote",
    description:
      "Get a swap price quote from Jupiter Ultra API without executing a swap. " +
      "Returns expected input amount, output amount, price impact, and estimated output. " +
      "Use this to show the user the current price before they decide to swap. " +
      "Common mints: SOL=So11111111111111111111111111111111111111112, USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v. " +
      "Use solana_jupiter_search to look up decimals for any token.",
    inputSchema: {
      type: "object",
      properties: {
        inputMint: {
          type: "string",
          description: "Input token mint address (e.g. So11111111111111111111111111111111111111112 for SOL)",
        },
        outputMint: {
          type: "string",
          description: "Output token mint address (e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)",
        },
        amount: {
          type: "number",
          description: "Amount to quote in human-readable units (e.g. 0.5 for 0.5 SOL, 100 for 100 USDC)",
        },
        inputDecimals: {
          type: "number",
          description: "Decimals of the input token (SOL=9, USDC=6, BONK=5, etc.). If omitted, will be looked up automatically.",
        },
        outputDecimals: {
          type: "number",
          description: "Decimals of the output token. If omitted, will be looked up automatically.",
        },
        slippageBps: {
          type: "number",
          description: "Slippage tolerance in basis points (e.g. 50 for 0.5%). Default: 100 (1%)",
          default: 100,
        },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
    async execute(input: any) {
      try {
        const slippageBps = input.slippageBps ?? 100;
        const isSol = input.inputMint === "So11111111111111111111111111111111111111112";
        const isOutSol = input.outputMint === "So11111111111111111111111111111111111111112";

        // Determine input decimals
        let inDecimals: number;
        if (input.inputDecimals !== undefined) {
          inDecimals = input.inputDecimals;
        } else if (isSol) {
          inDecimals = 9;
        } else {
          return `Please provide "inputDecimals" for token ${input.inputMint}. Use solana_jupiter_search to look it up.`;
        }

        // Determine output decimals
        let outDecimals: number;
        if (input.outputDecimals !== undefined) {
          outDecimals = input.outputDecimals;
        } else if (isOutSol) {
          outDecimals = 9;
        } else {
          return `Please provide "outputDecimals" for token ${input.outputMint}. Use solana_jupiter_search to look it up.`;
        }

        const rawAmount = String(Math.floor(input.amount * Math.pow(10, inDecimals)));

        const orderUrl = new URL("https://lite-api.jup.ag/ultra/v1/order");
        orderUrl.searchParams.set("inputMint", input.inputMint);
        orderUrl.searchParams.set("outputMint", input.outputMint);
        orderUrl.searchParams.set("amount", rawAmount);
        orderUrl.searchParams.set("slippageBps", String(slippageBps));

        const res = await fetch(orderUrl.toString(), {
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const errText = await res.text();
          return `Quote request failed (${res.status}): ${errText}`;
        }
        const order = await res.json() as any;

        if (!order.inAmount || !order.outAmount) {
          return `No quote available. Response: ${JSON.stringify(order).slice(0, 500)}`;
        }

        const outHuman = (Number(order.outAmount) / Math.pow(10, outDecimals)).toFixed(6);
        const priceImpact = order.priceImpact ?? "unknown";
        const inSymbol = isSol ? "SOL" : input.inputMint.slice(0, 8);
        const outSymbol = isOutSol ? "SOL" : input.outputMint.slice(0, 8);

        return `Quote for ${input.amount} ${inSymbol} → ${outSymbol}:\n` +
          `Expected output: ${outHuman} ${outSymbol}\n` +
          `Raw output: ${order.outAmount} (smallest units)\n` +
          `Price impact: ${priceImpact}\n` +
          `Slippage: ${slippageBps / 100}%\n` +
          `Note: This is a quote only — no transaction was executed.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Quote failed: ${msg}`;
      }
    },
  };

  const jupiterShieldTool: AgentTool<any, any> = {
    name: "solana_jupiter_shield",
    description:
      "Check token security information using Jupiter's Shield API. " +
      "Returns warnings about honeypot tokens, frozen mints, mintable tokens, and other risks. " +
      "ALWAYS call this before swapping to an unknown token to protect the user.",
    inputSchema: {
      type: "object",
      properties: {
        mints: {
          type: "string",
          description: "Comma-separated token mint addresses to check (e.g. 'EPjFWdd5...,So11111...')",
        },
      },
      required: ["mints"],
    },
    async execute(input: any) {
      try {
        const mintList = input.mints.split(",").map((s: string) => s.trim()).filter(Boolean);
        const url = new URL("https://lite-api.jup.ag/ultra/v1/shield");
        url.searchParams.set("mints", mintList.join(","));
        const res = await fetch(url.toString(), {
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const errText = await res.text();
          return `Shield check failed (${res.status}): ${errText}`;
        }
        const data = await res.json() as any;
        const results = Array.isArray(data) ? data : (data.tokens ?? data.result ?? []);
        if (results.length === 0) {
          return `No security data found for the given mints. This could mean the tokens are not in Jupiter's database.`;
        }
        const lines = results.map((r: any) => {
          const mint = r.mint ?? r.address ?? r.id ?? "?";
          const warnings: string[] = [];
          if (r.isHoneypot) warnings.push("HONEYPOT");
          if (r.mintable) warnings.push("MINTABLE");
          if (r.frozen) warnings.push("FROZEN");
          if (r.transferFee) warnings.push(`TRANSFER_FEE(${r.transferFee}%)`);
          if (r.sellTax) warnings.push(`SELL_TAX(${r.sellTax}%)`);
          if (r.buyTax) warnings.push(`BUY_TAX(${r.buyTax}%)`);
          const label = r.symbol ?? r.name ?? mint.slice(0, 8);
          if (warnings.length === 0) {
            return `${label} (${mint}): ✓ No warnings — appears safe`;
          }
          return `${label} (${mint}): ⚠ ${warnings.join(", ")}`;
        });
        return `Token security check:\n${lines.join('\n')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Shield check failed: ${msg}`;
      }
    },
  };

  const getTxHistoryTool: AgentTool<any, any> = {
    name: "solana_get_tx_history",
    description:
      "Get recent transaction history for your wallet. Returns up to 10 recent transactions " +
      "with signature, block time, status (success/failed), and memo. " +
      "Use this to review what your wallet has been doing or to audit past transactions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of transactions to return (max 20). Default: 10",
          default: 10,
        },
      },
    },
    async execute(input: any) {
      try {
        const limit = Math.min(input.limit ?? 10, 20);
        const history = await getAgentTxHistory(agentId, limit);
        if (!history) {
          return `Unable to fetch transaction history. CDP may not be configured.`;
        }
        if (history.length === 0) {
          return `No transactions found for your wallet yet. This wallet may be new.`;
        }
        const lines = history.map((tx) => {
          const time = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString().slice(0, 19) : "unknown";
          const status = tx.err ? "FAILED" : "success";
          const memo = tx.memo ? ` — memo: ${tx.memo}` : "";
          const shortSig = tx.signature.slice(0, 12) + "..." + tx.signature.slice(-6);
          return `${time} | ${status} | ${shortSig}${memo}`;
        });
        const net = getNetwork();
        const explorerBase = `https://explorer.solana.com/tx/`;
        const clusterParam = net.includes("devnet") ? "?cluster=devnet" : "";
        return `Recent transactions (${history.length}):\n${lines.join('\n')}\n\n` +
          `View full details on Solana Explorer: ${explorerBase}<signature>${clusterParam}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to get transaction history: ${msg}`;
      }
    },
  };

  const checkTxStatusTool: AgentTool<any, any> = {
    name: "solana_check_tx_status",
    description:
      "Check the status of a Solana transaction by its signature. " +
      "Returns confirmation status, block time, fee, and token balance changes if available. " +
      "Use this after a swap or transfer to verify it landed on-chain.",
    inputSchema: {
      type: "object",
      properties: {
        signature: {
          type: "string",
          description: "Transaction signature to check",
        },
      },
      required: ["signature"],
    },
    async execute(input: any) {
      try {
        const conn = new Connection(getRpcUrl(), "confirmed");
        const tx = await conn.getTransaction(input.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) {
          return `Transaction ${input.signature} not found. It may not have been confirmed yet, or the signature is invalid.`;
        }
        const status = tx.meta?.err ? "FAILED" : "SUCCESS";
        const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown";
        const fee = tx.meta?.fee ? `${tx.meta.fee / LAMPORTS_PER_SOL} SOL` : "unknown";
        const slot = tx.slot ?? "unknown";
        const explorerUrl = `https://explorer.solana.com/tx/${input.signature}` +
          (network.includes("devnet") ? `?cluster=devnet` : "");
        const lines = [
          `Transaction: ${input.signature}`,
          `Status: ${status}`,
          `Block time: ${blockTime}`,
          `Slot: ${slot}`,
          `Fee: ${fee}`,
          `Explorer: ${explorerUrl}`,
        ];
        if (tx.meta?.preTokenBalances && tx.meta?.postTokenBalances) {
          lines.push("Token balance changes:");
          for (const post of tx.meta.postTokenBalances) {
            const pre = tx.meta.preTokenBalances.find((p: any) => p.accountIndex === post.accountIndex);
            const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
            const postAmount = Number(post.uiTokenAmount.amount);
            const diff = postAmount - preAmount;
            if (diff !== 0) {
              lines.push(`  ${post.mint.slice(0, 8)}...: ${diff > 0 ? "+" : ""}${diff}`);
            }
          }
        }
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to check tx status: ${msg}`;
      }
    },
  };

  const launchTokenTool: AgentTool<any, any> = {
    name: "solana_launch_token",
    description:
      "Launch a new SPL token on pump.fun bonding curve. The token is instantly tradeable. " +
      "Your CDP wallet becomes the token creator and receives creator fees from trading. " +
      "ALWAYS confirm the token name, symbol, and description with the user before launching. " +
      `Network: ${network}. Mainnet recommended for real launches.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Token name (e.g. 'My Awesome Token')",
        },
        symbol: {
          type: "string",
          description: "Token ticker symbol (e.g. 'AWESOME', max 10 chars)",
        },
        description: {
          type: "string",
          description: "Token description shown on pump.fun",
        },
        imageUrl: {
          type: "string",
          description: "URL to token logo image (square PNG/SVG recommended, 512x512). Host on imgur, IPFS, or any public URL.",
        },
        website: {
          type: "string",
          description: "Optional project website URL",
        },
        twitter: {
          type: "string",
          description: "Optional Twitter/X profile link",
        },
        telegram: {
          type: "string",
          description: "Optional Telegram group link",
        },
        initialBuySol: {
          type: "number",
          description: "Optional initial SOL amount to buy as the creator (e.g. 0.01). Default: 0 (no initial buy)",
          default: 0,
        },
      },
      required: ["name", "symbol", "description"],
    },
    async execute(input: any) {
      try {
        if (network.includes("devnet")) {
          return `Token launch is recommended on mainnet only. Current network: ${network}. ` +
            `Switch CDP_SOLANA_NETWORK to "solana" for real launches.`;
        }
        const account = await getAgentAccount(agentId);
        const conn = new Connection(getRpcUrl(), "confirmed");

        // Build metadata URI (pump.fun expects an off-chain JSON metadata URI)
        // We construct a minimal metadata object and host it as a data URI fallback
        const metadata = {
          name: input.name,
          symbol: input.symbol,
          description: input.description,
          image: input.imageUrl ?? "",
          website: input.website ?? "",
          twitter: input.twitter ?? "",
          telegram: input.telegram ?? "",
        };

        // For the URI, pump.fun requires a publicly accessible URL.
        // If no imageUrl provided, we use a placeholder metadata URI.
        const uri = input.imageUrl
          ? `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`
          : `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;

        // Generate a new mint keypair for the token
        const mintKeypair = Keypair.generate();

        // Build the pump.fun create instruction manually (no SDK needed).
        // pump.fun program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
        const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
        const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

        // Derive PDAs
        const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID);
        const [bondingCurvePda] = PublicKey.findProgramAddressSync([mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID);
        const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
          [bondingCurvePda.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const [associatedUser] = PublicKey.findProgramAddressSync(
          [new PublicKey(account.address).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // Encode strings with 4-byte LE length prefix
        const encodeStr = (s: string): Buffer => {
          const buf = Buffer.from(s, "utf8");
          const len = Buffer.alloc(4);
          len.writeUInt32LE(buf.length, 0);
          return Buffer.concat([len, buf]);
        };

        // Create instruction data: discriminator(0) + name + symbol + uri
        const data = Buffer.concat([
          Buffer.from([0]),
          encodeStr(input.name),
          encodeStr(input.symbol),
          encodeStr(uri),
        ]);

        const userPubkey = new PublicKey(account.address);
        const createIx = {
          programId: PUMP_PROGRAM_ID,
          keys: [
            { pubkey: globalPda, isSigner: false, isWritable: true },
            { pubkey: mintKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: userPubkey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: true },
            { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
          ],
          data,
        };

        // Get latest blockhash
        const { blockhash } = await conn.getLatestBlockhash("confirmed");

        // Build versioned transaction
        const message = new TransactionMessage({
          payerKey: new PublicKey(account.address),
          recentBlockhash: blockhash,
          instructions: [createIx],
        }).compileToV0Message();

        const tx = new VersionedTransaction(message);

        // Sign with mint keypair locally
        tx.sign([mintKeypair]);

        // Sign with CDP wallet (the payer/creator)
        const serializedTx = Buffer.from(tx.serialize()).toString("base64");
        const signResult = await account.signTransaction({ transaction: serializedTx });
        const signedTx = (signResult as any).signedTransaction ?? (signResult as any).signature;

        // Broadcast
        const sig = await conn.sendRawTransaction(Buffer.from(signedTx, "base64"));
        await conn.confirmTransaction(sig, "confirmed");

        const explorerUrl = `https://explorer.solana.com/tx/${sig}`;
        const pumpUrl = `https://pump.fun/${mintKeypair.publicKey.toBase58()}`;
        const mintExplorer = `https://explorer.solana.com/address/${mintKeypair.publicKey.toBase58()}`;

        return `Token launched successfully!\n` +
          `Name: ${input.name}\n` +
          `Symbol: ${input.symbol}\n` +
          `Mint address: ${mintKeypair.publicKey.toBase58()}\n` +
          `Pump.fun page: ${pumpUrl}\n` +
          `Transaction: ${sig}\n` +
          `Explorer (tx): ${explorerUrl}\n` +
          `Explorer (token): ${mintExplorer}\n` +
          `You are the token creator. Trading fees will be distributed to your wallet.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Token launch failed: ${msg}`;
      }
    },
  };

  const portfolioTool: AgentTool<any, any> = {
    name: "solana_portfolio",
    description:
      "Get a portfolio overview for your wallet. Returns token allocations (percentage of portfolio), " +
      "USD values where available, and a rebalancing suggestion if any token dominates. " +
      "Use this to give the user a snapshot of their holdings.",
    inputSchema: {
      type: "object",
      properties: {
        includeHistory: {
          type: "boolean",
          description: "If true, include 24h P&L estimate (requires balance history). Default: false",
          default: false,
        },
      },
    },
    async execute(input: any) {
      try {
        const data = await getAgentBalances(agentId);
        if (!data || data.balances.length === 0) {
          const account = await getAgentAccount(agentId);
          return `Wallet ${account.address} has no token balances. The wallet may need to be funded.`;
        }

        // Calculate total USD value
        let totalUsd = 0;
        const holdings = data.balances.map((b) => {
          const usd = b.usdValue ? parseFloat(b.usdValue) : 0;
          totalUsd += usd;
          return { ...b, usdValue: usd };
        });

        // Sort by USD value descending
        holdings.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));

        const lines = [`Portfolio for ${data.address}:`];
        if (totalUsd > 0) {
          lines.push(`Total estimated value: $${totalUsd.toFixed(2)}\n`);
        }

        for (const h of holdings) {
          const usdStr = h.usdValue > 0 ? ` ($${h.usdValue.toFixed(2)})` : "";
          const pct = totalUsd > 0 ? ` — ${((h.usdValue / totalUsd) * 100).toFixed(1)}%` : "";
          lines.push(`${h.symbol}: ${h.amount}${usdStr}${pct}`);
        }

        // Rebalancing suggestion
        if (totalUsd > 0) {
          const dominant = holdings[0];
          const dominantPct = (dominant.usdValue / totalUsd) * 100;
          if (dominantPct > 60) {
            lines.push(`\nRebalancing suggestion: ${dominant.symbol} is ${dominantPct.toFixed(1)}% of your portfolio. ` +
              `Consider diversifying by swapping some ${dominant.symbol} for other tokens.`);
          } else if (holdings.length === 1) {
            lines.push(`\nDiversification suggestion: You only hold ${dominant.symbol}. ` +
              `Consider acquiring other tokens to spread risk.`);
          } else {
            lines.push(`\nPortfolio looks diversified across ${holdings.length} tokens.`);
          }
        }

        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Portfolio analysis failed: ${msg}`;
      }
    },
  };

  const priceFeedTool: AgentTool<any, any> = {
    name: "solana_price_feed",
    description:
      "Get current price and 24h change for any Solana token. " +
      "Uses Jupiter's price API. Returns price in USD and 24h price change percentage. " +
      "Common mints: SOL=So11111111111111111111111111111111111111112, USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v. " +
      "Use solana_jupiter_search to find mint addresses for other tokens.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token mint address (e.g. So11111111111111111111111111111111111111112 for SOL)",
        },
      },
      required: ["mint"],
    },
    async execute(input: any) {
      try {
        const prices = await batchFetchJupiterPrices([input.mint]);
        const price = prices.get(input.mint);
        if (!price || price <= 0) {
          return `No price available for ${input.mint.slice(0, 12)}...`;
        }
        const lines = [`Price for ${input.mint.slice(0, 12)}...`];
        lines.push(`USD: $${price.toFixed(6)}`);
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Price feed failed: ${msg}`;
      }
    },
  };

  const ohlcvTool: AgentTool<any, any> = {
    name: "solana_ohlcv",
    description:
      "Get candlestick (OHLCV) data for a Solana token. Returns open, high, low, close, volume for each candle. " +
      "Useful for technical analysis, charting, and trend detection. " +
      "Powered by Birdeye API (free tier).",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token mint address",
        },
        resolution: {
          type: "string",
          description: 'Candle resolution: "1m", "5m", "15m", "1h", "4h", "1d". Default: "1h"',
          default: "1h",
        },
        count: {
          type: "number",
          description: "Number of candles to return (max 100). Default: 24",
          default: 24,
        },
      },
      required: ["mint"],
    },
    async execute(input: any) {
      try {
        const resolution = input.resolution ?? "1h";
        const count = Math.min(input.count ?? 24, 100);
        const url = new URL("https://public-api.birdeye.so/defi/ohlcv");
        url.searchParams.set("address", input.mint);
        url.searchParams.set("type", resolution);
        url.searchParams.set("limit", String(count));
        const res = await fetch(url.toString(), {
          headers: { "x-chain": "solana" },
        });
        if (!res.ok) {
          const errText = await res.text();
          return `OHLCV fetch failed (${res.status}): ${errText}. Birdeye free tier may be rate-limited.`;
        }
        const data = await res.json() as any;
        const candles = data.data ?? [];
        if (candles.length === 0) return `No OHLCV data found for ${input.mint}.`;
        const lines = [`OHLCV for ${input.mint.slice(0, 12)}... (${resolution}, last ${candles.length} candles):`];
        for (const c of candles.slice(-10)) {
          const time = c.unixTime ? new Date(c.unixTime * 1000).toISOString().slice(0, 16) : "?";
          lines.push(`  ${time} O:${c.o} H:${c.h} L:${c.l} C:${c.c} V:${c.v}`);
        }
        if (candles.length > 10) lines.push(`  ... (${candles.length - 10} more candles)`);
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `OHLCV fetch failed: ${msg}`;
      }
    },
  };

  const topHoldersTool: AgentTool<any, any> = {
    name: "solana_top_holders",
    description:
      "Get the top token holders and concentration risk for a Solana token. " +
      "Returns top 10 holders with their balance and percentage of total supply. " +
      "High concentration (top holder >20%) is a risk signal. " +
      "Use this alongside solana_jupiter_shield before investing in unknown tokens.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token mint address",
        },
      },
      required: ["mint"],
    },
    async execute(input: any) {
      try {
        const conn = new Connection(getRpcUrl(), "confirmed");
        const mint = new PublicKey(input.mint);
        const largestAccounts = await conn.getTokenLargestAccounts(mint);
        const supply = await conn.getTokenSupply(mint);
        const totalSupply = Number(supply.value.amount);
        if (totalSupply === 0) return `Token ${input.mint} has zero supply or does not exist.`;
        const lines = [`Top holders for ${input.mint.slice(0, 12)}...:`];
        const holders = largestAccounts.value.slice(0, 10);
        for (let i = 0; i < holders.length; i++) {
          const h = holders[i];
          const amount = Number(h.amount);
          const pct = ((amount / totalSupply) * 100).toFixed(2);
          const addr = h.address.toBase58().slice(0, 8) + "...";
          lines.push(`  ${i + 1}. ${addr} — ${pct}% (${h.amount})`);
        }
        const topPct = parseFloat(((Number(holders[0]?.amount ?? 0) / totalSupply) * 100).toFixed(2));
        if (topPct > 20) {
          lines.push(`\nRisk warning: Top holder owns ${topPct}% of supply. High concentration risk.`);
        } else if (topPct > 10) {
          lines.push(`\nCaution: Top holder owns ${topPct}% of supply. Moderate concentration.`);
        } else {
          lines.push(`\nHolder distribution looks healthy (top holder: ${topPct}%).`);
        }
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Top holders check failed: ${msg}`;
      }
    },
  };

  const liquidityCheckTool: AgentTool<any, any> = {
    name: "solana_liquidity_check",
    description:
      "Check pool liquidity for a Solana token across DEXs. " +
      "Returns available liquidity in USD, which indicates how easily the token can be bought/sold without large price impact. " +
      "Low liquidity (<$10k) means high slippage risk.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token mint address",
        },
      },
      required: ["mint"],
    },
    async execute(input: any) {
      try {
        const url = new URL("https://lite-api.jup.ag/ultra/v1/labels/liquidity");
        url.searchParams.set("mint", input.mint);
        const res = await fetch(url.toString());
        if (!res.ok) {
          return `Liquidity check failed (${res.status}). The token may not be listed on any DEX.`;
        }
        const data = await res.json() as any;
        const liquidity = data.liquidity ?? data.usdLiquidity ?? data.data?.liquidity;
        if (!liquidity) return `No liquidity data found for ${input.mint}.`;
        const usdLiq = typeof liquidity === "number" ? liquidity : parseFloat(liquidity);
        const lines = [`Liquidity for ${input.mint.slice(0, 12)}...:`];
        lines.push(`USD liquidity: $${usdLiq.toLocaleString()}`);
        if (usdLiq < 10000) {
          lines.push(`Risk: LOW LIQUIDITY. Swaps will have high price impact and slippage.`);
        } else if (usdLiq < 100000) {
          lines.push(`Caution: Moderate liquidity. Large swaps may have noticeable price impact.`);
        } else {
          lines.push(`Liquidity is healthy. Swaps should have minimal price impact for normal sizes.`);
        }
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Liquidity check failed: ${msg}`;
      }
    },
  };

  const newTokensTool: AgentTool<any, any> = {
    name: "solana_new_tokens",
    description:
      "Discover recently launched tokens on pump.fun. Returns the newest tokens with their mint address, " +
      "symbol, age, market cap, and volume. Use this to find new trading opportunities. " +
      "ALWAYS run solana_jupiter_shield and solana_top_holders on any token before considering a trade.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of tokens to return (max 20). Default: 10",
          default: 10,
        },
      },
    },
    async execute(input: any) {
      try {
        const limit = Math.min(input.limit ?? 10, 20);
        const res = await fetch(`https://pumpapi.fun/api/pumps?limit=${limit}&sort=new`);
        if (!res.ok) {
          return `New tokens fetch failed (${res.status}). pump.fun API may be unavailable.`;
        }
        const data = await res.json() as any;
        const tokens = Array.isArray(data) ? data : (data.pumps ?? data.data ?? []);
        if (tokens.length === 0) return `No new tokens found.`;
        const lines = [`Recent pump.fun token launches (newest first):`];
        for (const t of tokens.slice(0, limit)) {
          const symbol = t.symbol ?? t.ticker ?? "?";
          const mint = t.mint ?? t.mintAddress ?? "?";
          const mcap = t.marketCap ?? t.usd_market_cap ?? "?";
          const volume = t.volume ?? t.usd_volume ?? "?";
          const age = t.createdTimestamp ? `${Math.round((Date.now() - t.createdTimestamp * 1000) / 60000)}m ago` : "?";
          lines.push(`  ${symbol} — mint: ${mint.slice(0, 12)}... — mcap: $${mcap} — vol: $${volume} — ${age}`);
        }
        lines.push(`\nBefore trading any of these, run solana_jupiter_shield and solana_top_holders to check for risks.`);
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `New tokens fetch failed: ${msg}`;
      }
    },
  };

  const marketNewsTool: AgentTool<any, any> = {
    name: "solana_market_news",
    description:
      "Get latest crypto and Solana market news. Returns recent headlines from crypto news sources. " +
      "Use this to provide context for trading decisions. The agent can analyze sentiment from the headlines.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: 'News category: "crypto" (default), "solana", "defi", "nft"',
          default: "crypto",
        },
        limit: {
          type: "number",
          description: "Number of headlines to return (max 20). Default: 10",
          default: 10,
        },
      },
    },
    async execute(input: any) {
      try {
        const limit = Math.min(input.limit ?? 10, 20);
        const category = input.category ?? "crypto";
        const url = new URL("https://min-api.cryptocompare.com/data/v2/news/");
        url.searchParams.set("lang", "EN");
        if (category === "solana") url.searchParams.set("categories", "SOL|SOLANA");
        else if (category === "defi") url.searchParams.set("categories", "DEFI");
        else if (category === "nft") url.searchParams.set("categories", "NFT");
        const res = await fetch(url.toString());
        if (!res.ok) return `News fetch failed (${res.status}).`;
        const data = await res.json() as any;
        const articles = data.Data ?? [];
        if (articles.length === 0) return `No news found for category: ${category}.`;
        const lines = [`Latest ${category} news:`];
        for (const a of articles.slice(0, limit)) {
          const title = a.title ?? a.body ?? "?";
          const source = a.source_info?.name ?? a.source ?? "?";
          const time = a.published_on ? new Date(a.published_on * 1000).toISOString().slice(0, 16) : "?";
          lines.push(`  [${source}] ${time}: ${title}`);
        }
        lines.push(`\nAnalyze these headlines for market sentiment before making trading decisions.`);
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Market news fetch failed: ${msg}`;
      }
    },
  };

  const arbitrageScanTool: AgentTool<any, any> = {
    name: "solana_arbitrage_scan",
    description:
      "Scan for arbitrage opportunities between Jupiter and OKX DEX aggregators. " +
      "Fetches quotes from both DEXs for the same token pair and reports price differences. " +
      "Read-only — does not execute any trades. The agent should present opportunities to the user for manual decision.",
    inputSchema: {
      type: "object",
      properties: {
        inputMint: {
          type: "string",
          description: "Input token mint address (e.g. So11111111111111111111111111111111111111112 for SOL)",
        },
        outputMint: {
          type: "string",
          description: "Output token mint address",
        },
        amount: {
          type: "number",
          description: "Amount to check in human-readable units (e.g. 1 for 1 SOL)",
        },
        inputDecimals: {
          type: "number",
          description: "Decimals of input token (SOL=9, USDC=6). If omitted, auto-detected.",
        },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const isSol = input.inputMint === "So11111111111111111111111111111111111111112";
        let decimals: number;
        if (input.inputDecimals !== undefined) {
          decimals = input.inputDecimals;
        } else if (isSol) {
          decimals = 9;
        } else {
          return `Please provide inputDecimals for token ${input.inputMint}. Use solana_jupiter_search to look it up.`;
        }
        const rawAmount = String(Math.floor(input.amount * Math.pow(10, decimals)));

        const [jupOrder, okxQuote] = await Promise.all([
          (async () => {
            try {
              const orderUrl = new URL("https://lite-api.jup.ag/ultra/v1/order");
              orderUrl.searchParams.set("inputMint", input.inputMint);
              orderUrl.searchParams.set("outputMint", input.outputMint);
              orderUrl.searchParams.set("amount", rawAmount);
              orderUrl.searchParams.set("slippageBps", "100");
              const res = await fetch(orderUrl.toString());
              if (!res.ok) return null;
              return await res.json() as any;
            } catch { return null; }
          })(),
          getOkxQuote(input.inputMint, input.outputMint, rawAmount, 100, account.address),
        ]);

        const jupOut = jupOrder?.outAmount ? BigInt(jupOrder.outAmount) : null;
        const okxOut = okxQuote?.toTokenAmount ? BigInt(okxQuote.toTokenAmount) : null;

        if (jupOut === null && okxOut === null) {
          return `No quotes from either DEX for this pair.`;
        }

        const lines = [`Arbitrage scan for ${input.amount} ${isSol ? "SOL" : input.inputMint.slice(0, 8)}... → ${input.outputMint.slice(0, 8)}...:`];
        if (jupOut !== null) lines.push(`Jupiter output: ${jupOut.toString()}`);
        if (okxOut !== null) lines.push(`OKX output: ${okxOut.toString()}`);

        if (jupOut !== null && okxOut !== null && jupOut > 0n && okxOut > 0n) {
          const diff = jupOut > okxOut ? jupOut - okxOut : okxOut - jupOut;
          const pct = (Number(diff) * 10000 / Number(jupOut > okxOut ? okxOut : jupOut) / 100).toFixed(2);
          const better = jupOut > okxOut ? "Jupiter" : "OKX";
          lines.push(`Better DEX: ${better} (${pct}% more output)`);
          if (parseFloat(pct) > 1) {
            lines.push(`Potential arbitrage opportunity! Buy on ${jupOut > okxOut ? "OKX" : "Jupiter"}, sell on ${better}.`);
          } else {
            lines.push(`Price difference is minimal (<1%). No significant arbitrage opportunity.`);
          }
        }
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Arbitrage scan failed: ${msg}`;
      }
    },
  };

  const batchTransferTool: AgentTool<any, any> = {
    name: "solana_batch_transfer",
    description:
      "Transfer SOL or SPL tokens to multiple recipients in a single call. " +
      "Useful for airdrops, payroll, or multi-party payments. " +
      "Always confirm the total amount and all recipient addresses with the user before calling. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          description: "Array of { address, amount } objects",
          items: {
            type: "object",
            properties: {
              address: { type: "string", description: "Recipient wallet address" },
              amount: { type: "number", description: "Amount to transfer (human-readable)" },
            },
          },
        },
        token: {
          type: "string",
          description: 'Token to transfer: "sol" for native SOL, or SPL token mint address. Default: "sol"',
          default: "sol",
        },
        decimals: {
          type: "number",
          description: "Token decimals (SOL=9, USDC=6). If omitted, auto-detected for SOL.",
        },
      },
      required: ["recipients"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const token = input.token ?? "sol";
        const recipients = input.recipients as { address: string; amount: number }[];
        if (!recipients || recipients.length === 0) {
          return `No recipients provided.`;
        }
        if (recipients.length > 20) {
          return `Too many recipients (${recipients.length}). Maximum 20 per batch.`;
        }
        const decimals = token === "sol" ? 9 : (input.decimals ?? 6);
        const results: string[] = [];
        let successCount = 0;
        for (const r of recipients) {
          try {
            const rawAmount = BigInt(Math.floor(r.amount * Math.pow(10, decimals)));
            const { signature } = await account.transfer({
              to: r.address,
              amount: rawAmount,
              token,
              network: network as any,
            });
            results.push(`  ${r.address.slice(0, 8)}... — ${r.amount} ${token === "sol" ? "SOL" : token.slice(0, 8)} — tx: ${signature.slice(0, 12)}...`);
            successCount++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`  ${r.address.slice(0, 8)}... — FAILED: ${msg}`);
          }
        }
        return `Batch transfer complete: ${successCount}/${recipients.length} successful\n${results.join("\n")}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Batch transfer failed: ${msg}`;
      }
    },
  };

  // ── Raydium CLMM LP Tools ──────────────────────────────────────────────

  const raydiumCache = new Map<string, any>();

  async function getRaydiumInstance(walletAddress: string): Promise<any> {
    const cacheKey = `raydium-${walletAddress}`;
    if (raydiumCache.has(cacheKey)) return raydiumCache.get(cacheKey)!;
    const conn = new Connection(getRpcUrl(), "confirmed");
    const isDevnet = getNetwork().includes("devnet");
    const raydium = await Raydium.load({
      connection: conn,
      owner: new PublicKey(walletAddress),
      cluster: isDevnet ? "devnet" : "mainnet",
      disableLoadToken: isDevnet,
      disableFeatureCheck: true,
    });
    raydiumCache.set(cacheKey, raydium);
    return raydium;
  }

  async function signAndBroadcastWithCdp(
    agentId: string,
    txData: { transaction: VersionedTransaction; signers: any[] },
  ): Promise<string> {
    const account = await getAgentAccount(agentId);
    const conn = new Connection(getRpcUrl(), "confirmed");
    let tx = txData.transaction;

    // Collect valid local signers (e.g. NFT mint keypair for position opening)
    const validSigners = (txData.signers || []).filter((s: any) => s && s.secretKey && s.secretKey.length === 64);

    // Sign with local signers first
    if (validSigners.length > 0) {
      tx.sign(validSigners);
    }

    // Serialize WITH local signatures (don't strip them — CDP should add its signature alongside)
    const serializedTx = Buffer.from(tx.serialize()).toString("base64");

    // Sign with CDP wallet
    const signResult = await account.signTransaction({ transaction: serializedTx });
    const signedTxB64 = (signResult as any).signedTransaction ?? (signResult as any).signature;

    // Re-apply local signatures in case CDP didn't preserve them
    let finalTxBytes: Uint8Array = Buffer.from(signedTxB64, "base64");
    if (validSigners.length > 0) {
      const signedTx = VersionedTransaction.deserialize(finalTxBytes);
      signedTx.sign(validSigners);
      finalTxBytes = signedTx.serialize();
    }

    // Broadcast
    const sig = await conn.sendRawTransaction(Buffer.from(finalTxBytes));
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  }

  function getClmmProgramId(): PublicKey {
    return getNetwork().includes("devnet") ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;
  }

  /**
   * Fetch pool info without crashing on zero-liquidity pools.
   * Replicates getPoolInfoFromRpc's logic but skips the tick array fetch
   * (Object.values(r[e]) throws when tick data is undefined for new pools).
   */
  async function getPoolInfoSafe(raydium: any, poolId: PublicKey): Promise<{ poolInfo: any; poolKeys: any }> {
    const rpcInfo = await raydium.clmm.getRpcClmmPoolInfo({ poolId });
    const mintAddresses = [rpcInfo.mintA.toBase58(), rpcInfo.mintB.toBase58()];
    const mintInfos: Record<string, any> = {};
    for (const addr of mintAddresses) {
      const info = await raydium.token.getTokenInfo(new PublicKey(addr));
      if (info.programId && typeof info.programId === 'string') {
        info.programId = new PublicKey(info.programId);
      }
      mintInfos[addr] = info;
    }
    const { computeClmmPoolInfo } = await raydium.clmm.getComputeClmmPoolInfos({
      clmmPoolsRpcInfo: { [poolId.toString()]: rpcInfo },
      mintInfos,
    });
    const computed = computeClmmPoolInfo[poolId.toString()];

    // Fetch vault balances (same as SDK's getPoolInfoFromRpc)
    let mintAmountA = 0, mintAmountB = 0;
    try {
      const { getMultipleAccountsInfo } = raydium.scope.connection;
      const vaultAccounts = await getMultipleAccountsInfo([rpcInfo.vaultA, rpcInfo.vaultB]);
      if (vaultAccounts[0]?.accountInfo && vaultAccounts[1]?.accountInfo) {
        const { AmountLayout } = require("@raydium-io/raydium-sdk-v2");
        mintAmountA = Number(AmountLayout.decode(vaultAccounts[0].accountInfo.data).amount.toString());
        mintAmountB = Number(AmountLayout.decode(vaultAccounts[1].accountInfo.data).amount.toString());
      }
    } catch {}

    // Build poolInfo — match getPoolInfoFromRpc's output (all strings)
    const poolInfo: any = {
      ...computed,
      type: "Concentrated",
      programId: rpcInfo.programId.toBase58(),
      id: poolId.toBase58(),
      exBitmapAccount: computed.exBitmapAccount.toBase58(),
      observationId: computed.observationId.toBase58(),
      vault: { A: rpcInfo.vaultA.toBase58(), B: rpcInfo.vaultB.toBase58() },
      rewardDefaultInfos: computed.rewardInfos
        .filter((r: any) => !r.mint.equals(PublicKey.default))
        .map((r: any) => ({
          mint: {
            address: r.mint.toBase58(),
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            decimals: mintInfos[r.mint.toBase58()]?.decimals ?? 6,
          },
          perSecond: Number(r.emissionsPerSecondX64.divn(10 ** (mintInfos[r.mint.toBase58()]?.decimals ?? 6)).toString()),
          startTime: r.openTime.toNumber(),
          endTime: r.endTime.toNumber(),
        })),
      rewardDefaultPoolInfos: "Clmm",
      price: computed.currentPrice.toNumber(),
      mintAmountA,
      mintAmountB,
      feeRate: computed.ammConfig.tradeFeeRate,
      openTime: rpcInfo.startTime.toString(),
      tvl: 0,
      day: { volume: 0, volumeFee: 0, feeA: 0, feeB: 0, feeApr: 0, aprA: 0, aprB: 0, apr: 0 },
      week: { volume: 0, volumeFee: 0, feeA: 0, feeB: 0, feeApr: 0, aprA: 0, aprB: 0, apr: 0 },
      month: { volume: 0, volumeFee: 0, feeA: 0, feeB: 0, feeApr: 0, aprA: 0, aprB: 0, apr: 0 },
      pooltype: [],
      farmUpcomingCount: 0,
      farmOngoingCount: 0,
      farmFinishedCount: 0,
      burnPercent: 0,
      config: { ...computed.ammConfig, id: computed.ammConfig.id.toBase58() },
    };

    // Build poolKeys — match getPoolInfoFromRpc's output format
    const poolKeys: any = {
      ...computed,
      programId: rpcInfo.programId.toBase58(),
      id: poolId.toBase58(),
      exBitmapAccount: computed.exBitmapAccount.toBase58(),
      observationId: computed.observationId.toBase58(),
      vault: { A: rpcInfo.vaultA.toBase58(), B: rpcInfo.vaultB.toBase58() },
      config: { ...computed.ammConfig, id: computed.ammConfig.id.toBase58() },
      rewardInfos: computed.rewardInfos
        .filter((r: any) => !r.vault.equals(PublicKey.default))
        .map((r: any) => ({
          mint: {
            address: r.mint.toBase58(),
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            decimals: mintInfos[r.mint.toBase58()]?.decimals ?? 6,
          },
          vault: r.vault.toBase58(),
        })),
    };

    return { poolInfo, poolKeys };
  }

  const listClmmPoolsTool: AgentTool<any, any> = {
    name: "solana_list_clmm_pools",
    description:
      "List existing Raydium CLMM pools for a token pair. Use this to find pool addresses before opening positions. " +
      "Returns pool address, fee tier, current price, TVL, and liquidity for each pool. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        mintA: { type: "string", description: "First token mint address" },
        mintB: { type: "string", description: "Second token mint address" },
      },
      required: ["mintA", "mintB"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);
        const result = await raydium.api.fetchPoolByMints({
          mint1: input.mintA,
          mint2: input.mintB,
          type: "Concentrated",
          sort: "liquidity",
          order: "desc",
          pageSize: 10,
        });
        if (!result.data || result.data.length === 0) {
          return `No CLMM pools found for ${input.mintA} / ${input.mintB} on ${network}. You can create one with solana_create_clmm_pool.`;
        }
        const pools = result.data.map((pool: any) => ({
          poolAddress: pool.id,
          feeRate: pool.feeRate ? `${(pool.feeRate / 10000).toFixed(2)}%` : "unknown",
          currentPrice: pool.price,
          tvl: pool.tvl ? `$${pool.tvl.toLocaleString()}` : "unknown",
          liquidityA: pool.mintAmountA ? `${(pool.mintAmountA / Math.pow(10, pool.mintA.decimals)).toFixed(4)} ${pool.mintA.symbol || pool.mintA.address.slice(0, 8)}` : "unknown",
          liquidityB: pool.mintAmountB ? `${(pool.mintAmountB / Math.pow(10, pool.mintB.decimals)).toFixed(4)} ${pool.mintB.symbol || pool.mintB.address.slice(0, 8)}` : "unknown",
          openTime: pool.openTime,
        }));
        return `Found ${result.count} CLMM pool(s) for this pair:\n` +
          pools.map((p: any, i: number) => `${i + 1}. Pool: ${p.poolAddress}\n   Fee: ${p.feeRate} | Price: ${p.currentPrice} | TVL: ${p.tvl}\n   Liquidity: ${p.liquidityA} / ${p.liquidityB}`).join("\n\n") +
          `\n\nUse solana_open_clmm_position with the pool address to open a liquidity position.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to list CLMM pools: ${msg}`;
      }
    },
  };

  const createClmmPoolTool: AgentTool<any, any> = {
    name: "solana_create_clmm_pool",
    description:
      "Create a new Raydium CLMM (concentrated liquidity) pool for any pair of SPL tokens. " +
      "This is permissionless — no listing required. The pool is created on-chain and you become the pool creator. " +
      "After creating the pool, use solana_open_clmm_position to deposit liquidity. " +
      "ALWAYS confirm the token pair, initial price, and fee tier with the user before creating. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        mintA: { type: "string", description: "First token mint address" },
        mintB: { type: "string", description: "Second token mint address" },
        initialPrice: { type: "number", description: "Initial price of mintA in terms of mintB (e.g. 1 mintA = N mintB). The SDK auto-sorts mints by byte order." },
        feeTierIndex: { type: "number", description: "Fee tier index (0=0.01%, 1=0.05%, 2=0.25%, 3=1%, 4=2%, 5=5%). Default: 1 (0.05%)", default: 1 },
      },
      required: ["mintA", "mintB", "initialPrice"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);
        const programId = getClmmProgramId();

        // Fetch token info for both mints
        const mint1Info = await raydium.token.getTokenInfo(new PublicKey(input.mintA));
        const mint2Info = await raydium.token.getTokenInfo(new PublicKey(input.mintB));

        // Fetch available CLMM fee tier configs
        const clmmConfigs = await raydium.api.getClmmConfigs();
        const feeIndex = input.feeTierIndex ?? 1;
        const ammConfig = clmmConfigs.find((c: any) => c.index === feeIndex) ?? clmmConfigs[0];
        if (!ammConfig) {
          return `No CLMM fee tier configs available. This may be a network issue.`;
        }

        // On devnet, re-derive the config PDA
        const configId = new PublicKey(ammConfig.id);

        const buildData = await raydium.clmm.createPool({
          programId,
          mint1: mint1Info,
          mint2: mint2Info,
          ammConfig: { ...ammConfig, id: configId, fundOwner: ammConfig.fundOwner ?? "", description: ammConfig.description ?? "" },
          initialPrice: new Decimal(input.initialPrice),
          txVersion: TxVersion.V0,
        });

        const sig = await signAndBroadcastWithCdp(agentId, { transaction: buildData.transaction, signers: buildData.signers });
        const rawPoolId = (buildData as any).extInfo?.address?.id;
        const poolId = typeof rawPoolId === 'string' ? rawPoolId : (rawPoolId?.toBase58?.() ?? "unknown");
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? "?cluster=devnet" : "");
        const poolExplorer = poolId !== "unknown" ? `https://explorer.solana.com/address/${poolId}` + (network.includes("devnet") ? "?cluster=devnet" : "") : "(check transaction on explorer for pool address)";

        return `CLMM pool created successfully!\n` +
          `Pool address: ${poolId}\n` +
          `Token A: ${input.mintA}\n` +
          `Token B: ${input.mintB}\n` +
          `Initial price: ${input.initialPrice}\n` +
          `Fee tier index: ${feeIndex}\n` +
          `Transaction: ${sig}\n` +
          `Explorer (tx): ${explorerUrl}\n` +
          `Explorer (pool): ${poolExplorer}\n` +
          (poolId === "unknown" ? `NOTE: Pool address could not be extracted from the transaction. Check the transaction on Solana Explorer to find the pool address, then use solana_list_clmm_pools with the token mints to find it.\n` : "") +
          `Next step: use solana_open_clmm_position with this pool address to deposit liquidity.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `CLMM pool creation failed: ${msg}`;
      }
    },
  };

  const openClmmPositionTool: AgentTool<any, any> = {
    name: "solana_open_clmm_position",
    description:
      "Open a concentrated liquidity position in an existing Raydium CLMM pool. " +
      "Creates a position NFT in your wallet with the specified price range. " +
      "Deposits both tokens proportionally based on the current price and your range. " +
      "ALWAYS confirm the pool, amount, and price range with the user before opening. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "CLMM pool address (from solana_create_clmm_pool or explorer)" },
        amount: { type: "number", description: "Amount of the base token to deposit (in human-readable units)" },
        baseToken: { type: "string", description: "Which token to deposit as base: 'A' or 'B' (matching the pool's mintA/mintB)", default: "A" },
        lowerPrice: { type: "number", description: "Lower bound of the price range (e.g. 0.9 * currentPrice for -10%)" },
        upperPrice: { type: "number", description: "Upper bound of the price range (e.g. 1.1 * currentPrice for +10%)" },
      },
      required: ["poolId", "amount", "lowerPrice", "upperPrice"],
    },
    async execute(input: any) {
      try {
        if (!input.poolId || input.poolId === "unknown" || input.poolId.length < 32) {
          return `Cannot open CLMM position: invalid pool ID "${input.poolId}". Use solana_list_clmm_pools to find the correct pool address for your token pair.`;
        }
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);

        // Fetch pool info (handles pools with zero liquidity / no tick arrays)
        let poolInfo: any, poolKeys: any;
        try {
          const result = await getPoolInfoSafe(raydium, new PublicKey(input.poolId));
          poolInfo = result.poolInfo;
          poolKeys = result.poolKeys;
        } catch (rpcErr) {
          const rpcMsg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
          if (rpcMsg.includes("fetch pool info error") || rpcMsg.includes("does not exist") || rpcMsg.includes("not found")) {
            return `Pool ${input.poolId} does not exist on-chain on ${network}. Possible causes:\n1. The pool was created on a different network (devnet vs mainnet)\n2. The pool address is incorrect\n3. The pool creation transaction failed\nUse solana_list_clmm_pools with the token mint addresses to find existing pools.`;
          }
          throw rpcErr;
        }

        // Determine base token and convert amount to raw units
        const base = (input.baseToken ?? "A").toUpperCase() === "B" ? "MintB" : "MintA";
        const baseMint = base === "MintA" ? poolInfo.mintA : poolInfo.mintB;
        const baseDecimals = baseMint.decimals;
        const tickSpacing = poolInfo.config.tickSpacing;
        const zeroForOne = base === "MintA";

        // Compute tick range from price bounds
        const { tick: tickLower } = TickUtil.getPriceAndTick({
          price: new Decimal(input.lowerPrice),
          mintADecimals: poolInfo.mintA.decimals,
          mintBDecimals: poolInfo.mintB.decimals,
          zeroForOne,
          tickSpacing,
        });
        const { tick: tickUpper } = TickUtil.getPriceAndTick({
          price: new Decimal(input.upperPrice),
          mintADecimals: poolInfo.mintA.decimals,
          mintBDecimals: poolInfo.mintB.decimals,
          zeroForOne,
          tickSpacing,
        });

        const baseAmount = new BN(Math.floor(input.amount * Math.pow(10, baseDecimals)));

        // Compute the other token amount needed
        const epochInfo = await raydium.fetchEpochInfo();
        const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
          poolInfo,
          slippage: 0.01,
          inputA: base === "MintA",
          tickUpper: Math.max(tickLower, tickUpper),
          tickLower: Math.min(tickLower, tickUpper),
          amount: baseAmount,
          add: true,
          amountHasFee: true,
          epochInfo,
        });

        const buildData = await raydium.clmm.openPositionFromBase({
          poolInfo,
          poolKeys,
          tickLower: Math.min(tickLower, tickUpper),
          tickUpper: Math.max(tickLower, tickUpper),
          base,
          baseAmount,
          otherAmountMax: res.amountSlippageB.amount,
          ownerInfo: { useSOLBalance: true },
          txVersion: TxVersion.V0,
        });

        const sig = await signAndBroadcastWithCdp(agentId, { transaction: buildData.transaction, signers: buildData.signers });
        const nftMint = (buildData as any).extInfo?.nftMint?.toBase58?.() ?? "unknown";
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? "?cluster=devnet" : "");

        return `CLMM position opened successfully!\n` +
          `Pool: ${input.poolId}\n` +
          `Position NFT: ${nftMint}\n` +
          `Price range: ${input.lowerPrice} — ${input.upperPrice}\n` +
          `Deposited: ${input.amount} ${base === "MintA" ? "Token A" : "Token B"}\n` +
          `Transaction: ${sig}\n` +
          `Explorer: ${explorerUrl}\n` +
          `You can manage this position with solana_increase_liquidity, solana_decrease_liquidity, solana_collect_clmm_fees, or solana_close_clmm_position.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Open CLMM position failed: ${msg}`;
      }
    },
  };

  const increaseLiquidityTool: AgentTool<any, any> = {
    name: "solana_increase_liquidity",
    description:
      "Add more liquidity to an existing Raydium CLMM position. " +
      "Provide the position NFT mint address and the amount of one token to add. " +
      "The other token amount is calculated automatically based on the current price and position range. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        positionNft: { type: "string", description: "Position NFT mint address" },
        poolId: { type: "string", description: "CLMM pool address" },
        amount: { type: "number", description: "Amount of base token to add (human-readable)" },
        baseToken: { type: "string", description: "Which token to add: 'A' or 'B'", default: "A" },
      },
      required: ["positionNft", "poolId", "amount"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);

        const { poolInfo, poolKeys } = await getPoolInfoSafe(raydium, new PublicKey(input.poolId));

        // Find the position from owner positions
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: getClmmProgramId() });
        const pos = positions.find((p: any) => p.nftMint.toBase58() === input.positionNft);
        if (!pos) {
          return `Position NFT ${input.positionNft} not found in your wallet. Use solana_list_clmm_positions to see your positions.`;
        }

        const base = (input.baseToken ?? "A").toUpperCase() === "B" ? "MintB" : "MintA";
        const baseMint = base === "MintA" ? poolInfo.mintA : poolInfo.mintB;
        const baseAmount = new BN(Math.floor(input.amount * Math.pow(10, baseMint.decimals)));

        const epochInfo = await raydium.fetchEpochInfo();
        const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
          poolInfo,
          slippage: 0.01,
          inputA: base === "MintA",
          tickUpper: pos.tickUpperIndex,
          tickLower: pos.tickLowerIndex,
          amount: baseAmount,
          add: true,
          amountHasFee: true,
          epochInfo,
        });

        const buildData = await raydium.clmm.increasePositionFromBase({
          poolInfo,
          poolKeys,
          ownerPosition: pos,
          base,
          baseAmount,
          otherAmountMax: res.amountSlippageB.amount,
          txVersion: TxVersion.V0,
        });

        const sig = await signAndBroadcastWithCdp(agentId, { transaction: buildData.transaction, signers: buildData.signers });
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? "?cluster=devnet" : "");

        return `Liquidity increased!\nPosition: ${input.positionNft}\nAdded: ${input.amount} ${base === "MintA" ? "Token A" : "Token B"}\nTransaction: ${sig}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Increase liquidity failed: ${msg}`;
      }
    },
  };

  const decreaseLiquidityTool: AgentTool<any, any> = {
    name: "solana_decrease_liquidity",
    description:
      "Remove partial liquidity from an existing Raydium CLMM position. " +
      "Returns both tokens to your wallet proportional to the removed liquidity. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        positionNft: { type: "string", description: "Position NFT mint address" },
        poolId: { type: "string", description: "CLMM pool address" },
        liquidityPct: { type: "number", description: "Percentage of liquidity to remove (1-100). e.g. 50 removes half.", default: 100 },
      },
      required: ["positionNft", "poolId"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);

        const { poolInfo, poolKeys } = await getPoolInfoSafe(raydium, new PublicKey(input.poolId));
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: getClmmProgramId() });
        const pos = positions.find((p: any) => p.nftMint.toBase58() === input.positionNft);
        if (!pos) {
          return `Position NFT ${input.positionNft} not found in your wallet.`;
        }

        const pct = Math.min(Math.max(input.liquidityPct ?? 100, 1), 100);
        const removeLiquidity = new BN(pos.liquidity.mul(new BN(pct)).div(new BN(100)).toString());

        const buildData = await raydium.clmm.decreaseLiquidity({
          poolInfo,
          poolKeys,
          ownerPosition: pos,
          liquidity: removeLiquidity,
          ownerInfo: { useSOLBalance: true },
          txVersion: TxVersion.V0,
        });

        const sig = await signAndBroadcastWithCdp(agentId, { transaction: buildData.transaction, signers: buildData.signers });
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? "?cluster=devnet" : "");

        return `Liquidity decreased!\nPosition: ${input.positionNft}\nRemoved: ${pct}% of liquidity\nTransaction: ${sig}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Decrease liquidity failed: ${msg}`;
      }
    },
  };

  const collectClmmFeesTool: AgentTool<any, any> = {
    name: "solana_collect_clmm_fees",
    description:
      "Collect accumulated trading fees from a Raydium CLMM position. " +
      "Fees are earned when trades occur within your position's price range. " +
      "This withdraws the fees to your wallet without closing the position. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        positionNft: { type: "string", description: "Position NFT mint address" },
        poolId: { type: "string", description: "CLMM pool address" },
      },
      required: ["positionNft", "poolId"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);

        const { poolInfo, poolKeys } = await getPoolInfoSafe(raydium, new PublicKey(input.poolId));
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: getClmmProgramId() });
        const pos = positions.find((p: any) => p.nftMint.toBase58() === input.positionNft);
        if (!pos) {
          return `Position NFT ${input.positionNft} not found in your wallet.`;
        }

        const buildData = await raydium.clmm.decreaseLiquidity({
          poolInfo,
          poolKeys,
          ownerPosition: pos,
          liquidity: new BN(0),
          ownerInfo: { useSOLBalance: true },
          txVersion: TxVersion.V0,
        });

        const sig = await signAndBroadcastWithCdp(agentId, { transaction: buildData.transaction, signers: buildData.signers });
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? "?cluster=devnet" : "");

        return `Fees collected!\nPosition: ${input.positionNft}\nTransaction: ${sig}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Collect fees failed: ${msg}`;
      }
    },
  };

  const closeClmmPositionTool: AgentTool<any, any> = {
    name: "solana_close_clmm_position",
    description:
      "Close a Raydium CLMM position completely. " +
      "Withdraws all remaining liquidity and accumulated fees, then closes the position NFT. " +
      "Use solana_decrease_liquidity first if you only want to remove partial liquidity. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        positionNft: { type: "string", description: "Position NFT mint address" },
        poolId: { type: "string", description: "CLMM pool address" },
      },
      required: ["positionNft", "poolId"],
    },
    async execute(input: any) {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);

        const { poolInfo, poolKeys } = await getPoolInfoSafe(raydium, new PublicKey(input.poolId));
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: getClmmProgramId() });
        const pos = positions.find((p: any) => p.nftMint.toBase58() === input.positionNft);
        if (!pos) {
          return `Position NFT ${input.positionNft} not found in your wallet.`;
        }

        const buildData = await raydium.clmm.closePosition({
          poolInfo,
          poolKeys,
          ownerPosition: pos,
          ownerInfo: { useSOLBalance: true },
          txVersion: TxVersion.V0,
        });

        const sig = await signAndBroadcastWithCdp(agentId, { transaction: buildData.transaction, signers: buildData.signers });
        const explorerUrl = `https://explorer.solana.com/tx/${sig}` + (network.includes("devnet") ? "?cluster=devnet" : "");

        return `Position closed!\nPosition NFT: ${input.positionNft}\nAll liquidity and fees withdrawn.\nTransaction: ${sig}\nExplorer: ${explorerUrl}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Close position failed: ${msg}`;
      }
    },
  };

  const listClmmPositionsTool: AgentTool<any, any> = {
    name: "solana_list_clmm_positions",
    description:
      "List all Raydium CLMM LP positions held by your wallet. " +
      "Returns position NFT address, pool ID, token pair, liquidity, current price, in-range status, and fees earned. " +
      `Network: ${network}.`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const account = await getAgentAccount(agentId);
        const raydium = await getRaydiumInstance(account.address);
        const programId = getClmmProgramId();

        const positions = await raydium.clmm.getOwnerPositionInfo({ programId });
        if (!positions || positions.length === 0) {
          return `No CLMM positions found in your wallet. Use solana_create_clmm_pool and solana_open_clmm_position to create one.`;
        }

        const lines: string[] = [];
        for (const pos of positions as any[]) {
          const poolIdStr = pos.poolId.toBase58();
          const nftMintStr = pos.nftMint.toBase58();
          const tickLower = pos.tickLower;
          const tickUpper = pos.tickUpper;
          let tickCurrent = 0;
          let inRange = false;
          try {
            const rpcInfo = await raydium.clmm.getRpcClmmPoolInfo({ poolId: pos.poolId });
            tickCurrent = rpcInfo.tickCurrent;
            inRange = tickLower <= tickCurrent && tickCurrent <= tickUpper;
          } catch {
            // If pool info fetch fails, leave tickCurrent as 0 and inRange as false
          }
          lines.push(
            `Position NFT: ${nftMintStr}\n` +
            `  Pool: ${poolIdStr}\n` +
            `  Liquidity: ${pos.liquidity.toString()}\n` +
            `  Tick range: ${tickLower} — ${tickUpper} (current: ${tickCurrent})\n` +
            `  In range: ${inRange ? "YES" : "NO"}\n` +
            `  Explorer: https://explorer.solana.com/address/${nftMintStr}` + (network.includes("devnet") ? "?cluster=devnet" : "")
          );
        }

        return `Found ${positions.length} CLMM position(s):\n\n${lines.join("\n\n")}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `List CLMM positions failed: ${msg}`;
      }
    },
  };

  return [
    getWalletTool,
    getBalanceTool,
    transferTool,
    sendTransactionTool,
    requestFaucetTool,
    signMessageTool,
    getPolicyTool,
    jupiterSwapTool,
    jupiterSearchTool,
    jupiterQuoteTool,
    jupiterShieldTool,
    getTxHistoryTool,
    checkTxStatusTool,
    launchTokenTool,
    portfolioTool,
    priceFeedTool,
    ohlcvTool,
    topHoldersTool,
    liquidityCheckTool,
    newTokensTool,
    marketNewsTool,
    arbitrageScanTool,
    batchTransferTool,
    listClmmPoolsTool,
    createClmmPoolTool,
    openClmmPositionTool,
    increaseLiquidityTool,
    decreaseLiquidityTool,
    collectClmmFeesTool,
    closeClmmPositionTool,
    listClmmPositionsTool,
  ];
}
