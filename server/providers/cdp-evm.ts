import type { AgentTool } from "@cline/sdk";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, formatEther, parseEther, type Hex, type Chain as ViemChain } from "viem";
import { base, baseSepolia, mainnet as ethereum, polygon } from "viem/chains";

/**
 * CDP EVM provider — gives agents a programmatically-provisioned EVM wallet
 * via Coinbase Developer Platform. Same CDP API keys as Solana provider.
 *
 * Required env vars:
 *   CDP_API_KEY_ID
 *   CDP_API_KEY_SECRET
 *   CDP_WALLET_SECRET
 *
 * Optional env vars:
 *   CDP_EVM_NETWORK  (default: "base-sepolia")
 */

let cdpClient: CdpClient | null = null;

function getCdpClient(): CdpClient {
  if (cdpClient) return cdpClient;
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      "CDP EVM wallet requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET env vars."
    );
  }
  cdpClient = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  return cdpClient;
}

function isCdpConfigured(): boolean {
  return !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
}

function getNetwork(): string {
  return process.env.CDP_EVM_NETWORK || "base-sepolia";
}

function getViemChain(network: string): ViemChain {
  switch (network) {
    case "base": return base;
    case "base-sepolia": return baseSepolia;
    case "ethereum": return ethereum;
    case "polygon": return polygon;
    default: return baseSepolia;
  }
}

function explorerBase(network: string): string {
  switch (network) {
    case "base": return "https://basescan.org/address/";
    case "base-sepolia": return "https://sepolia.basescan.org/address/";
    case "ethereum": return "https://etherscan.io/address/";
    case "polygon": return "https://polygonscan.com/address/";
    default: return `https://sepolia.basescan.org/address/`;
  }
}

const accountCache = new Map<string, Awaited<ReturnType<CdpClient["evm"]["createAccount"]>>>();

export async function getAgentAccount(agentId: string) {
  const cacheKey = `agent-${agentId}`;
  if (accountCache.has(cacheKey)) return accountCache.get(cacheKey)!;
  const cdp = getCdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: cacheKey });
  accountCache.set(cacheKey, account);
  return account;
}

export async function getAgentWalletAddress(agentId: string): Promise<string | null> {
  if (!isCdpConfigured()) return null;
  try {
    const account = await getAgentAccount(agentId);
    return account.address;
  } catch (err) {
    console.error(`[cdp-evm] Failed to get wallet address for agent ${agentId}:`, err);
    return null;
  }
}

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

const priceCache = new Map<string, { price: number; ts: number }>();
const PRICE_CACHE_TTL_MS = 30_000;

async function fetchTokenPrice(address: string, network: string): Promise<number> {
  const now = Date.now();
  const cached = priceCache.get(address);
  if (cached && now - cached.ts < PRICE_CACHE_TTL_MS) return cached.price;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) { priceCache.set(address, { price: 0, ts: now }); return 0; }
    const data = await res.json() as { pairs?: any[] };
    const pairs = data.pairs ?? [];
    let bestPrice = 0;
    let bestLiquidity = 0;
    for (const p of pairs) {
      const priceUsd = parseFloat(p.priceUsd);
      const liquidity = p.liquidity?.usd ?? 0;
      if (!isNaN(priceUsd) && priceUsd > 0 && liquidity > bestLiquidity) {
        bestPrice = priceUsd;
        bestLiquidity = liquidity;
      }
    }
    priceCache.set(address, { price: bestPrice, ts: now });
    return bestPrice;
  } catch {
    priceCache.set(address, { price: 0, ts: now });
    return 0;
  }
}

async function fetchEthPrice(network: string): Promise<number> {
  const chainMap: Record<string, string> = { "base": "base", "base-sepolia": "base", "ethereum": "ethereum", "polygon": "matic" };
  const chainId = chainMap[network] ?? "base";
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${chainId === "matic" ? "matic-network" : chainId}&vs_currencies=usd`);
    if (!res.ok) return 0;
    const data = await res.json() as any;
    const id = chainId === "matic" ? "matic-network" : chainId;
    return data[id]?.usd ?? 0;
  } catch { return 0; }
}

export async function getAgentBalances(agentId: string): Promise<{ address: string; balances: { symbol: string; amount: string; usdValue?: string }[]; totalUsdValue?: string } | null> {
  if (!isCdpConfigured()) return null;
  try {
    const network = getNetwork();
    const account = await getAgentAccount(agentId);
    const viemChain = getViemChain(network);
    const client = createPublicClient({ chain: viemChain, transport: http() });

    let cdpBalances: any[] = [];
    try {
      const cdp = getCdpClient();
      const cdpResult = await cdp.evm.listTokenBalances({ address: account.address, network: network as any });
      cdpBalances = (cdpResult as any).balances ?? [];
    } catch { /* best-effort */ }

    const cdpUsdMap = new Map<string, string>();
    const cdpFallback: { symbol: string; amount: string; usdValue?: string }[] = [];
    for (const b of cdpBalances as any[]) {
      const mint = b.token?.contractAddress ?? b.token?.address;
      const usd = b.usdValue?.value ?? b.usdValue;
      if (mint && usd) cdpUsdMap.set(mint.toLowerCase(), String(usd));
      const rawAmount = BigInt(b.amount?.amount ?? 0);
      const decimals = Number(b.amount?.decimals ?? 0);
      const symbol = b.token?.symbol ?? b.token?.name ?? "unknown";
      cdpFallback.push({ symbol, amount: rawToHuman(rawAmount, decimals), usdValue: usd ? String(usd) : undefined });
    }

    let totalUsd = 0;
    const balances: { symbol: string; amount: string; usdValue?: string }[] = [];

    // Native ETH balance
    try {
      const ethBalance = await client.getBalance({ address: account.address as `0x${string}` });
      const ethAmount = formatEther(ethBalance);
      const ethPrice = await fetchEthPrice(network);
      const ethUsd = ethPrice * parseFloat(ethAmount);
      if (ethUsd > 0) totalUsd += ethUsd;
      balances.push({ symbol: network === "polygon" ? "MATIC" : "ETH", amount: ethAmount, usdValue: ethUsd > 0 ? ethUsd.toFixed(2) : undefined });
    } catch { /* RPC may fail */ }

    // ERC-20 balances from CDP
    for (const b of cdpBalances as any[]) {
      const mint = (b.token?.contractAddress ?? b.token?.address ?? "").toLowerCase();
      const rawAmount = BigInt(b.amount?.amount ?? 0);
      const decimals = Number(b.amount?.decimals ?? 18);
      const symbol = b.token?.symbol ?? b.token?.name ?? "unknown";
      const amount = rawToHuman(rawAmount, decimals);
      let usdValue: string | undefined;
      const cdpUsd = cdpUsdMap.get(mint);
      if (cdpUsd) {
        usdValue = cdpUsd;
        totalUsd += parseFloat(cdpUsd);
      } else {
        const price = await fetchTokenPrice(b.token?.contractAddress ?? b.token?.address ?? "", network);
        if (price > 0) {
          const usd = price * parseFloat(amount);
          if (usd > 0) { usdValue = usd.toFixed(2); totalUsd += usd; }
        }
      }
      balances.push({ symbol, amount, usdValue });
    }

    if (balances.length === 0 && cdpFallback.length > 0) {
      return { address: account.address, balances: cdpFallback, totalUsdValue: undefined };
    }

    return { address: account.address, balances, totalUsdValue: totalUsd > 0 ? totalUsd.toFixed(2) : undefined };
  } catch (err) {
    console.error(`[cdp-evm] Failed to get balances for agent ${agentId}:`, err);
    return null;
  }
}

export async function getAgentTxHistory(agentId: string, limit: number = 10): Promise<{ hash: string; blockNumber: number | null; timestamp: number | null; from: string; to: string; value: string; status: boolean | null }[] | null> {
  if (!isCdpConfigured()) return null;
  try {
    const network = getNetwork();
    const account = await getAgentAccount(agentId);
    const viemChain = getViemChain(network);
    const client = createPublicClient({ chain: viemChain, transport: http() });
    const block = await client.getBlockNumber();
    const logs = await client.getLogs({
      address: account.address as `0x${string}`,
      fromBlock: block > 10000n ? block - 10000n : 0n,
      toBlock: block,
    });
    const txHashes = [...new Set(logs.map(l => l.transactionHash))].slice(0, limit);
    const result: { hash: string; blockNumber: number | null; timestamp: number | null; from: string; to: string; value: string; status: boolean | null }[] = [];
    for (const hash of txHashes) {
      try {
        const tx = await client.getTransaction({ hash: hash! });
        const receipt = await client.getTransactionReceipt({ hash: hash! });
        result.push({
          hash: hash!,
          blockNumber: Number(tx.blockNumber ?? 0),
          timestamp: null,
          from: tx.from,
          to: tx.to ?? "",
          value: formatEther(tx.value),
          status: receipt.status === "success",
        });
      } catch { /* skip */ }
    }
    return result;
  } catch (err) {
    console.error(`[cdp-evm] Failed to get tx history for agent ${agentId}:`, err);
    return null;
  }
}

export async function loadCdpEvmTools(agentId: string): Promise<AgentTool<any, any>[]> {
  if (!isCdpConfigured()) {
    console.warn("[cdp-evm] CDP env vars not set — EVM wallet tools disabled.");
    return [];
  }

  const network = getNetwork();

  const getWalletTool: AgentTool<any, any> = {
    name: "evm_get_wallet",
    description:
      "Get or create your dedicated EVM wallet. Returns the wallet address. " +
      "This wallet is auto-provisioned for you — no setup needed. " +
      `Current network: ${network}. Secured in Coinbase TEE.`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const account = await getAgentAccount(agentId);
        return `Your EVM wallet address: ${account.address}\nNetwork: ${network}\n` +
          `View on explorer: ${explorerBase(network)}${account.address}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error getting wallet: ${msg}`;
      }
    },
  };

  const getBalanceTool: AgentTool<any, any> = {
    name: "evm_get_balance",
    description:
      "Get token balances for your EVM wallet. Returns native ETH/MATIC and ERC-20 token balances " +
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
        return `Balances for ${data.address}:\n${formatted.join("\n")}` +
          (data.totalUsdValue ? `\nTotal estimated value: $${data.totalUsdValue}` : "");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error getting balances: ${msg}`;
      }
    },
  };

  const transferTool: AgentTool<any, any> = {
    name: "evm_transfer",
    description:
      "Transfer ETH/MATIC or ERC-20 tokens from your wallet to a recipient address. " +
      "Always confirm the transfer details with the user before calling this tool. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient EVM wallet address (0x...)" },
        amount: { type: "number", description: "Amount to transfer (human-readable, e.g. 0.5 for 0.5 ETH)" },
        token: { type: "string", description: 'Token to transfer: "native" for ETH/MATIC, or ERC-20 contract address', default: "native" },
        decimals: { type: "number", description: "Token decimals (ETH=18, USDC=6, most ERC-20=18). If omitted, auto-detected." },
      },
      required: ["to", "amount"],
    },
    async execute(input: any) {
      try {
        const cdp = getCdpClient();
        const account = await getAgentAccount(agentId);
        const token = input.token ?? "native";

        if (token === "native") {
          const value = parseEther(String(input.amount));
          const { transactionHash } = await cdp.evm.sendTransaction({
            address: account.address,
            network: network as any,
            transaction: { to: input.to, value } as any,
          });
          return `Transfer submitted!\nTo: ${input.to}\nAmount: ${input.amount} ${network === "polygon" ? "MATIC" : "ETH"}\nTx: ${transactionHash}\nExplorer: ${explorerBase(network)}${transactionHash}`;
        }

        // ERC-20 transfer
        const decimals = input.decimals ?? 18;
        const rawAmount = BigInt(Math.floor(input.amount * Math.pow(10, decimals)));
        const transferData = `0xa9059cbb${input.to.slice(2).padStart(64, "0")}${rawAmount.toString(16).padStart(64, "0")}` as Hex;
        const { transactionHash } = await cdp.evm.sendTransaction({
          address: account.address,
          network: network as any,
          transaction: { to: token, data: transferData } as any,
        });
        return `Transfer submitted!\nTo: ${input.to}\nAmount: ${input.amount}\nToken: ${token}\nTx: ${transactionHash}\nExplorer: ${explorerBase(network)}${transactionHash}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Transfer failed: ${msg}`;
      }
    },
  };

  const sendTransactionTool: AgentTool<any, any> = {
    name: "evm_send_transaction",
    description:
      "Send a raw EVM transaction from your wallet. Provide the transaction data (hex) and target contract address. " +
      "Use this for advanced DeFi operations not covered by transfer or swap tools. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target contract address (0x...)" },
        data: { type: "string", description: "Transaction calldata (hex string, with or without 0x prefix)" },
        value: { type: "string", description: "Native value to send in ETH (human-readable). Default: '0'", default: "0" },
      },
      required: ["to", "data"],
    },
    async execute(input: any) {
      try {
        const cdp = getCdpClient();
        const account = await getAgentAccount(agentId);
        const txValue = input.value && input.value !== "0" ? parseEther(String(input.value)) : 0n;
        const hexData = (input.data.startsWith("0x") ? input.data : `0x${input.data}`) as Hex;
        const { transactionHash } = await cdp.evm.sendTransaction({
          address: account.address,
          network: network as any,
          transaction: { to: input.to, data: hexData, value: txValue } as any,
        });
        return `Transaction submitted!\nTo: ${input.to}\nTx: ${transactionHash}\nExplorer: ${explorerBase(network)}${transactionHash}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Send transaction failed: ${msg}`;
      }
    },
  };

  const requestFaucetTool: AgentTool<any, any> = {
    name: "evm_request_faucet",
    description:
      "Request testnet ETH from the Coinbase CDP faucet. Only works on testnet networks (base-sepolia). " +
      `Current network: ${network}.`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        if (!network.includes("sepolia") && !network.includes("testnet")) {
          return `Faucet is only available on testnet networks. Current network: ${network}`;
        }
        const cdp = getCdpClient();
        const account = await getAgentAccount(agentId);
        const response = await cdp.evm.requestFaucet({
          address: account.address,
          network: network as any,
          token: "eth",
        });
        return `Faucet request submitted!\nTx: ${response.transactionHash}\nExplorer: ${explorerBase(network)}${response.transactionHash}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Faucet request failed: ${msg}`;
      }
    },
  };

  const signMessageTool: AgentTool<any, any> = {
    name: "evm_sign_message",
    description:
      "Sign an arbitrary message with your EVM wallet key (EIP-191 personal_sign). " +
      "Use this for authentication, identity verification, or off-chain message signing.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to sign (plain text)" },
      },
      required: ["message"],
    },
    async execute(input: any) {
      try {
        const cdp = getCdpClient();
        const account = await getAgentAccount(agentId);
        const signature = await cdp.evm.signMessage({
          address: account.address,
          message: input.message,
        });
        return `Message signed successfully.\nChain: ${network}\nSigner: ${account.address}\nSignature: ${signature}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Message signing failed: ${msg}`;
      }
    },
  };

  const swapQuoteTool: AgentTool<any, any> = {
    name: "evm_swap_quote",
    description:
      "Get a swap quote without executing. Uses 0x API (or 1inch) for EVM DEX aggregation. " +
      "Returns expected output amount and price. Use this to check prices before executing a swap.",
    inputSchema: {
      type: "object",
      properties: {
        sellToken: { type: "string", description: "Input token address (0x...). Use 0xeee...eee for native ETH." },
        buyToken: { type: "string", description: "Output token address (0x...). Use 0xeee...eee for native ETH." },
        sellAmount: { type: "string", description: "Amount to sell in human-readable units (e.g. '0.1')" },
        sellDecimals: { type: "number", description: "Decimals of sell token (ETH=18, USDC=6). Default: 18", default: 18 },
      },
      required: ["sellToken", "buyToken", "sellAmount"],
    },
    async execute(input: any) {
      try {
        const decimals = input.sellDecimals ?? 18;
        const rawAmount = String(Math.floor(parseFloat(input.sellAmount) * Math.pow(10, decimals)));
        const chainId = network.includes("base") ? "base" : network === "polygon" ? "polygon" : "ethereum";
        const params = new URLSearchParams({
          sellToken: input.sellToken,
          buyToken: input.buyToken,
          sellAmount: rawAmount,
        });
        const res = await fetch(`https://api.0x.org/swap/permit2/quote?${params}`, {
          headers: { "0x-chain-id": chainId === "base" ? "8453" : chainId === "polygon" ? "137" : "1" },
        });
        if (!res.ok) return `0x quote failed (${res.status}).`;
        const data = await res.json() as any;
        return `Quote (0x, ${chainId}):\n` +
          `Sell: ${input.sellAmount} (${input.sellToken.slice(0, 10)}...)\n` +
          `Expected buy: ${data.buyAmount ?? "unknown"} (raw)\n` +
          `Price: ${data.price ?? "unknown"}\n` +
          `Gas estimate: ${data.gas ?? "unknown"}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Swap quote failed: ${msg}`;
      }
    },
  };

  const swapTool: AgentTool<any, any> = {
    name: "evm_swap",
    description:
      "Swap tokens using your EVM wallet via 0x API DEX aggregation. " +
      "Use evm_swap_quote first to check expected output, then execute with evm_swap. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        sellToken: { type: "string", description: "Input token address (0x...). Use 0xeee...eee for native ETH." },
        buyToken: { type: "string", description: "Output token address (0x...). Use 0xeee...eee for native ETH." },
        sellAmount: { type: "string", description: "Amount to sell in human-readable units" },
        sellDecimals: { type: "number", description: "Decimals of sell token (ETH=18, USDC=6). Default: 18", default: 18 },
        slippageBps: { type: "number", description: "Slippage tolerance in basis points (50 = 0.5%). Default: 100", default: 100 },
      },
      required: ["sellToken", "buyToken", "sellAmount"],
    },
    async execute(input: any) {
      try {
        const cdp = getCdpClient();
        const account = await getAgentAccount(agentId);
        const decimals = input.sellDecimals ?? 18;
        const rawAmount = String(Math.floor(parseFloat(input.sellAmount) * Math.pow(10, decimals)));
        const slippageBps = input.slippageBps ?? 100;
        const chainId = network.includes("base") ? "base" : network === "polygon" ? "polygon" : "ethereum";
        const params = new URLSearchParams({
          sellToken: input.sellToken,
          buyToken: input.buyToken,
          sellAmount: rawAmount,
          taker: account.address,
          slippageBps: String(slippageBps),
        });
        const res = await fetch(`https://api.0x.org/swap/permit2/quote?${params}`, {
          headers: { "0x-chain-id": chainId === "base" ? "8453" : chainId === "polygon" ? "137" : "1" },
        });
        if (!res.ok) return `0x swap quote failed (${res.status}).`;
        const data = await res.json() as any;
        if (!data.to || !data.data) return `0x returned no swap data.`;
        const { transactionHash } = await cdp.evm.sendTransaction({
          address: account.address,
          network: network as any,
          transaction: { to: data.to, data: data.data as Hex, value: data.value ? BigInt(data.value) : 0n } as any,
        });
        return `Swap submitted via 0x!\n` +
          `Sell: ${input.sellAmount} (${input.sellToken.slice(0, 10)}...)\n` +
          `Expected buy: ${data.buyAmount ?? "unknown"} (raw)\n` +
          `Tx: ${transactionHash}\n` +
          `Explorer: ${explorerBase(network)}${transactionHash}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Swap failed: ${msg}`;
      }
    },
  };

  const tokenSearchTool: AgentTool<any, any> = {
    name: "evm_token_search",
    description:
      "Search for ERC-20 tokens by name or symbol. Returns contract address, decimals, and 24h volume. " +
      "Use this to find token addresses before swapping or transferring.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Token name, symbol, or contract address to search for" },
      },
      required: ["query"],
    },
    async execute(input: any) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(input.query)}`);
        if (!res.ok) return `Token search failed (${res.status}).`;
        const data = await res.json() as any;
        const pairs = data.pairs ?? [];
        if (pairs.length === 0) return `No tokens found for "${input.query}".`;
        const seen = new Set<string>();
        const lines = [`Search results for "${input.query}" (${pairs.length} pairs found):`];
        for (const p of pairs.slice(0, 10)) {
          const addr = p.baseToken?.address ?? "";
          if (seen.has(addr)) continue;
          seen.add(addr);
          const symbol = p.baseToken?.symbol ?? "?";
          const name = p.baseToken?.name ?? "?";
          const price = p.priceUsd ?? "?";
          const vol = p.volume?.h24 ?? "?";
          lines.push(`  ${symbol} (${name}) — ${addr} — $${price} — 24h vol: $${vol}`);
        }
        return lines.join("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Token search failed: ${msg}`;
      }
    },
  };

  const getTxHistoryTool: AgentTool<any, any> = {
    name: "evm_get_tx_history",
    description:
      "Get recent transaction history for your EVM wallet. Returns recent transactions with hash, " +
      "from, to, value, and status.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of transactions to return. Default: 10", default: 10 },
      },
    },
    async execute(input: any) {
      try {
        const limit = input.limit ?? 10;
        const history = await getAgentTxHistory(agentId, limit);
        if (!history || history.length === 0) {
          const account = await getAgentAccount(agentId);
          return `No recent transactions found for ${account.address}.`;
        }
        const lines = history.map((tx) => {
          return `  ${tx.hash.slice(0, 18)}... — from: ${tx.from.slice(0, 10)}... — to: ${tx.to.slice(0, 10)}... — ${tx.value} ETH — ${tx.status === null ? "pending" : tx.status ? "success" : "failed"}`;
        });
        return `Recent transactions (${history.length}):\n${lines.join("\n")}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to get tx history: ${msg}`;
      }
    },
  };

  const checkTxStatusTool: AgentTool<any, any> = {
    name: "evm_check_tx_status",
    description:
      "Check the confirmation status of an EVM transaction by hash. " +
      `Network: ${network}.`,
    inputSchema: {
      type: "object",
      properties: {
        hash: { type: "string", description: "Transaction hash (0x...)" },
      },
      required: ["hash"],
    },
    async execute(input: any) {
      try {
        const viemChain = getViemChain(network);
        const client = createPublicClient({ chain: viemChain, transport: http() });
        const receipt = await client.getTransactionReceipt({ hash: input.hash as `0x${string}` });
        return `Transaction ${input.hash}\nStatus: ${receipt.status === "success" ? "SUCCESS" : "FAILED"}\nBlock: ${receipt.blockNumber}\nGas used: ${receipt.gasUsed.toString()}\nExplorer: ${explorerBase(network)}${input.hash}`;
      } catch {
        return `Transaction ${input.hash} not found or still pending.\nExplorer: ${explorerBase(network)}${input.hash}`;
      }
    },
  };

  const portfolioTool: AgentTool<any, any> = {
    name: "evm_portfolio",
    description:
      "Get a portfolio overview for your EVM wallet. Returns token allocations, " +
      "USD values where available, and diversification suggestions.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        const data = await getAgentBalances(agentId);
        if (!data || data.balances.length === 0) {
          const account = await getAgentAccount(agentId);
          return `Wallet ${account.address} has no token balances. The wallet may need to be funded.`;
        }
        let totalUsd = 0;
        const holdings = data.balances.map((b) => {
          const usd = b.usdValue ? parseFloat(b.usdValue) : 0;
          totalUsd += usd;
          return { ...b, usdValue: usd };
        });
        holdings.sort((a: any, b: any) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
        const lines = [`Portfolio for ${data.address}:`];
        if (totalUsd > 0) lines.push(`Total estimated value: $${totalUsd.toFixed(2)}\n`);
        for (const h of holdings) {
          const usdStr = h.usdValue > 0 ? ` ($${h.usdValue.toFixed(2)})` : "";
          const pct = totalUsd > 0 ? ` — ${((h.usdValue / totalUsd) * 100).toFixed(1)}%` : "";
          lines.push(`${h.symbol}: ${h.amount}${usdStr}${pct}`);
        }
        if (totalUsd > 0) {
          const dominant = holdings[0];
          const dominantPct = (dominant.usdValue / totalUsd) * 100;
          if (dominantPct > 60) {
            lines.push(`\nRebalancing suggestion: ${dominant.symbol} is ${dominantPct.toFixed(1)}% of your portfolio.`);
          } else if (holdings.length === 1) {
            lines.push(`\nDiversification suggestion: You only hold ${dominant.symbol}.`);
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

  const batchTransferTool: AgentTool<any, any> = {
    name: "evm_batch_transfer",
    description:
      "Transfer native ETH/MATIC to multiple recipients in a single call. " +
      "Useful for airdrops, payroll, or multi-party payments. " +
      "Always confirm the total amount and all recipient addresses with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          description: "Array of { address, amount } objects",
          items: {
            type: "object",
            properties: {
              address: { type: "string", description: "Recipient wallet address (0x...)" },
              amount: { type: "number", description: "Amount to transfer (human-readable)" },
            },
          },
        },
      },
      required: ["recipients"],
    },
    async execute(input: any) {
      try {
        const recipients = input.recipients as { address: string; amount: number }[];
        if (!recipients || recipients.length === 0) return `No recipients provided.`;
        if (recipients.length > 20) return `Too many recipients (${recipients.length}). Maximum 20 per batch.`;
        const cdp = getCdpClient();
        const account = await getAgentAccount(agentId);
        const results: string[] = [];
        let successCount = 0;
        for (const r of recipients) {
          try {
            const value = parseEther(String(r.amount));
            const { transactionHash } = await cdp.evm.sendTransaction({
              address: account.address,
              network: network as any,
              transaction: { to: r.address, value } as any,
            });
            results.push(`  ${r.address.slice(0, 10)}... — ${r.amount} — tx: ${transactionHash.slice(0, 20)}...`);
            successCount++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`  ${r.address.slice(0, 10)}... — FAILED: ${msg}`);
          }
        }
        return `Batch transfer complete: ${successCount}/${recipients.length} successful\n${results.join("\n")}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Batch transfer failed: ${msg}`;
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
    swapQuoteTool,
    swapTool,
    tokenSearchTool,
    getTxHistoryTool,
    checkTxStatusTool,
    portfolioTool,
    batchTransferTool,
  ];
}
