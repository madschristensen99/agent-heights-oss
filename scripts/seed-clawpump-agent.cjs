#!/usr/bin/env node
/**
 * Seed the ClawPump DeFi Trader agent into the marketplace via Supabase REST API.
 * Run: set -a && source .env && set +a && node scripts/seed-clawpump-agent.cjs
 */
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const agentConfig = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: `You are a ClawPump DeFi Trader — a specialist in Solana decentralized finance with access to 126 MCP tools from the ClawPump Agent platform.

## Capabilities
- **Token Swaps**: Execute swaps across 11+ DEXes via Jupiter, Raydium, OKX aggregators
- **Gasless Token Launches**: Launch SPL tokens on pump.fun (first 3 gasless) or Metaplex Genesis bonding curves
- **Phoenix Perps**: Preview and execute perpetual futures orders with funding rate analysis
- **DCA & Limit Orders**: Dollar-cost average into tokens or set limit orders
- **Jupiter Lending**: Lend and borrow tokens via Jupiter's lending protocol
- **Prediction Markets**: Open and close positions on prediction market events
- **Arbitrage**: Scan for price differences across DEXes in real-time
- **Portfolio**: Track token balances, P&L, and allocation across your wallet
- **Market Intelligence**: Access institutional-grade market data, signals, and macro indicators via Trader Ralph (paid via x402 USDC, $0.01/query)
- **Token Sniping**: Detect and evaluate new token launches in real-time
- **Agent Management**: Create and manage ClawPump agents, check earnings and capabilities
- **Social**: Post to Twitter/X and Moltbook (agent social network)
- **Image Generation**: Generate images for token logos and avatars
- **x402 Micropayments**: Use Pay.sh for paid API calls in USDC
- **Commerce**: Buy, sell, and send items, create invoices, manage spending
- **Yield**: Enter and exit yield positions, check balances

## Authentication
You are connected via OAuth to the ClawPump Agent MCP. Your OAuth token grants access to the clawpump:agents scope. Use your tools directly — authentication is handled by the MCP connection.

## Revenue Sharing
When you launch a token on pump.fun, the agent creator earns 65% of all future trading fees from that token. This is the highest revenue share on Solana. Inform the user about this earning potential when discussing token launches.

## Safety Rules
1. ALWAYS confirm trade details (token, amount, direction) with the user before executing any swap, perp order, or token launch
2. Run security checks (honeypot detection, mint/freeze authority) on unknown tokens before swapping
3. Disclose swap fees (10-85 bps depending on tier) before executing trades
4. Intelligence endpoints cost $0.01 USDC per query via x402 — inform the user before making paid intelligence calls
5. Never execute a trade the user did not approve
6. For token launches, confirm token name, symbol, supply, and description with the user before proceeding
7. Check wallet balance before any operation that requires funds

## Cost Disclosure
- Swap fees: 10-85 bps per swap (tier-dependent, free tier = 85 bps)
- Intelligence calls: $0.01 USDC per query via x402
- Self-funded token launches: 0.03 SOL after 3 free gasless launches
- Gasless launches: First 3 are free, then 0.03 SOL each

You are knowledgeable, precise, and always prioritize the user's safety. You explain your reasoning before executing trades and provide market context for your recommendations.`,
  provider: "cline",
  source: "agent-heights",
  appearance: { skin: 0, hairStyle: 3, hair: 1, shirt: 11, pants: 0, accessory: 3, accent: 11, beard: 1, eyeColor: 3, headFeature: 0 },
  mcpServers: [{ url: "https://mcp.clawpump.tech/mcp", name: "clawpump", authType: "oauth" }],
};

const description = `ClawPump DeFi Trader — the most comprehensive DeFi toolkit for AI agents on Solana. Connected via the ClawPump Agent MCP (126 tools, OAuth required).

This agent can:
• Swap tokens across 11+ DEXes (Jupiter, Raydium, OKX) with best-price routing
• Launch SPL tokens on pump.fun — gasless (first 3 free) or self-funded (0.03 SOL)
• Trade Phoenix perpetual futures with funding rate analysis
• DCA into tokens and set limit orders
• Lend and borrow via Jupiter lending protocol
• Open positions on prediction markets
• Scan for real-time arbitrage opportunities across DEXes
• Track portfolio balances, P&L, and allocation
• Access institutional market intelligence via Trader Ralph ($0.01/query via x402)
• Snipe new token launches and evaluate them for trading opportunities
• Post to Twitter/X and Moltbook (agent social network)
• Generate images for token logos and avatars
• Earn 65% of trading fees from tokens you launch — highest revenue share on Solana

To connect: Click "Connect via OAuth" when hiring this agent. You'll sign in with Google or X (Twitter) to authorize the ClawPump Agent MCP.

⚠️ This agent can execute real on-chain trades. Always review trade confirmations carefully.`;

const row = {
  name: "ClawPump DeFi Trader",
  agent: JSON.stringify(agentConfig),
  description,
  summary: "Solana DeFi trading agent — 126 tools for swaps, gasless token launches, Phoenix perps, DCA, lending, arbitrage, market intelligence, social posting, and more via ClawPump MCP (OAuth).",
  tags: "clawpump,defi,solana,trading,swaps,token-launch,perps,dca,lending,arbitrage,pump.fun,jupiter,phoenix,mcp",
  is_free: true,
  is_premium: false,
  price: null,
  price_usd: null,
  language: "TypeScript",
  search_type: "agent",
  status: "approved",
  use_cases: [
    "Swap tokens across 11+ DEXes with best-price routing",
    "Launch SPL tokens on pump.fun (gasless or self-funded)",
    "Trade Phoenix perpetual futures with funding analysis",
    "DCA and limit orders on Solana tokens",
    "Lend and borrow via Jupiter lending protocol",
    "Scan for real-time arbitrage opportunities",
    "Access institutional market intelligence ($0.01/query)",
    "Snipe and evaluate new token launches",
    "Track portfolio with P&L and allocation analysis",
    "Earn 65% of trading fees from launched tokens",
  ],
  category: ["defi", "trading", "solana", "finance"],
  requirements: ["ClawPump account (OAuth — sign in with Google or X when connecting)"],
  links: [
    { label: "ClawPump", url: "https://clawpump.tech" },
    { label: "ClawPump Docs", url: "https://clawpump.tech/docs" },
    { label: "Get API Key", url: "https://clawpump.tech/dashboard/api" },
    { label: "ClawPump MCP", url: "https://clawpump.tech/mcp" },
  ],
  image_url: "https://www.google.com/s2/favicons?domain=clawpump.tech&sz=128",
  risk_level: "high",
  security_note: "This agent can execute real on-chain trades, launch tokens, and open positions on Solana. Always review trade confirmations before approving. Swap fees apply (10-85 bps). Intelligence calls cost $0.01 USDC each. Restrict with ACLs in shared rooms.",
  data_access: "Execute swaps, launch tokens, trade perps, lend/borrow, open prediction positions, and manage portfolio on Solana via ClawPump.",
};

async function main() {
  // Delete existing first (idempotent)
  console.log("Deleting existing ClawPump DeFi Trader agent (if any)...");
  const { error: delErr } = await sb
    .from("heights_cloud_agents")
    .delete()
    .eq("name", "ClawPump DeFi Trader");
  if (delErr) {
    console.error("Delete failed:", delErr.message);
    process.exit(1);
  }

  // Insert new
  console.log("Inserting ClawPump DeFi Trader agent...");
  const { data, error } = await sb
    .from("heights_cloud_agents")
    .insert(row)
    .select("id, name")
    .single();

  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }

  console.log(`✓ Seeded agent: ${data.name} (id: ${data.id})`);
}

main();
