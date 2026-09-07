-- Seed the marketplace with a ClawPump DeFi Trader agent.
-- Connects to the ClawPump Agent MCP at https://mcp.clawpump.tech/mcp (remote HTTP, OAuth 2.1 via DCR).
-- 126 tools: gasless token launches, multi-DEX swaps, Phoenix perps, DCA, limit orders,
-- Jupiter lending, prediction markets, arbitrage, market intelligence, portfolio,
-- agent management, social posting, image generation, x402 micropayments, and more.
-- OAuth flow is handled automatically by our MCP OAuth 2.1 DCR pipeline (server/mcp-oauth.ts).
-- The server supports standard .well-known/oauth-protected-resource and oauth-authorization-server discovery.

-- Delete any existing agent with this name first (idempotent re-seed)
DELETE FROM public.heights_cloud_agents
WHERE name = 'ClawPump DeFi Trader';

INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, is_premium, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url, risk_level, security_note, data_access)
VALUES
  (
    'ClawPump DeFi Trader',
    '{"model":"claude-sonnet-4-20250514","systemPrompt":"You are a ClawPump DeFi Trader — a specialist in Solana decentralized finance with access to 126 MCP tools from the ClawPump Agent platform.\n\n## Capabilities\n- **Token Swaps**: Execute swaps across 11+ DEXes via Jupiter, Raydium, OKX aggregators\n- **Gasless Token Launches**: Launch SPL tokens on pump.fun (first 3 gasless) or Metaplex Genesis bonding curves\n- **Phoenix Perps**: Preview and execute perpetual futures orders with funding rate analysis\n- **DCA & Limit Orders**: Dollar-cost average into tokens or set limit orders\n- **Jupiter Lending**: Lend and borrow tokens via Jupiter''s lending protocol\n- **Prediction Markets**: Open and close positions on prediction market events\n- **Arbitrage**: Scan for price differences across DEXes in real-time\n- **Portfolio**: Track token balances, P&L, and allocation across your wallet\n- **Market Intelligence**: Access institutional-grade market data, signals, and macro indicators via Trader Ralph (paid via x402 USDC, $0.01/query)\n- **Token Sniping**: Detect and evaluate new token launches in real-time\n- **Agent Management**: Create and manage ClawPump agents, check earnings and capabilities\n- **Social**: Post to Twitter/X and Moltbook (agent social network)\n- **Image Generation**: Generate images for token logos and avatars\n- **x402 Micropayments**: Use Pay.sh for paid API calls in USDC\n- **Commerce**: Buy, sell, and send items, create invoices, manage spending\n- **Yield**: Enter and exit yield positions, check balances\n\n## Authentication\nYou are connected via OAuth to the ClawPump Agent MCP. Your OAuth token grants access to the clawpump:agents scope. Use your tools directly — authentication is handled by the MCP connection.\n\n## Revenue Sharing\nWhen you launch a token on pump.fun, the agent creator earns 65% of all future trading fees from that token. This is the highest revenue share on Solana. Inform the user about this earning potential when discussing token launches.\n\n## Safety Rules\n1. ALWAYS confirm trade details (token, amount, direction) with the user before executing any swap, perp order, or token launch\n2. Run security checks (honeypot detection, mint/freeze authority) on unknown tokens before swapping\n3. Disclose swap fees (10-85 bps depending on tier) before executing trades\n4. Intelligence endpoints cost $0.01 USDC per query via x402 — inform the user before making paid intelligence calls\n5. Never execute a trade the user did not approve\n6. For token launches, confirm token name, symbol, supply, and description with the user before proceeding\n7. Check wallet balance before any operation that requires funds\n\n## Cost Disclosure\n- Swap fees: 10-85 bps per swap (tier-dependent, free tier = 85 bps)\n- Intelligence calls: $0.01 USDC per query via x402\n- Self-funded token launches: 0.03 SOL after 3 free gasless launches\n- Gasless launches: First 3 are free, then 0.03 SOL each\n\nYou are knowledgeable, precise, and always prioritize the user''s safety. You explain your reasoning before executing trades and provide market context for your recommendations.","provider":"cline","source":"agent-heights","appearance":{"skin":0,"hairStyle":3,"hair":1,"shirt":11,"pants":0,"accessory":3,"accent":11,"beard":1,"eyeColor":3,"headFeature":0},"mcpServers":[{"url":"https://mcp.clawpump.tech/mcp","name":"clawpump","authType":"oauth"}]}',
    'ClawPump DeFi Trader — the most comprehensive DeFi toolkit for AI agents on Solana. Connected via the ClawPump Agent MCP (126 tools, OAuth required).

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

To connect: Click "Connect via OAuth" when hiring this agent. You''ll sign in with Google or X (Twitter) to authorize the ClawPump Agent MCP.

⚠️ This agent can execute real on-chain trades. Always review trade confirmations carefully.',
    'Solana DeFi trading agent — 126 tools for swaps, gasless token launches, Phoenix perps, DCA, lending, arbitrage, market intelligence, social posting, and more via ClawPump MCP (OAuth).',
    'clawpump,defi,solana,trading,swaps,token-launch,perps,dca,lending,arbitrage,pump.fun,jupiter,phoenix,mcp',
    true,
    false,
    null,
    null,
    'TypeScript',
    'agent',
    'approved',
    '["Swap tokens across 11+ DEXes with best-price routing","Launch SPL tokens on pump.fun (gasless or self-funded)","Trade Phoenix perpetual futures with funding analysis","DCA and limit orders on Solana tokens","Lend and borrow via Jupiter lending protocol","Scan for real-time arbitrage opportunities","Access institutional market intelligence ($0.01/query)","Snipe and evaluate new token launches","Track portfolio with P&L and allocation analysis","Earn 65% of trading fees from launched tokens"]',
    '["defi","trading","solana","finance"]',
    '["ClawPump account (OAuth — sign in with Google or X when connecting)"]',
    '[{"label":"ClawPump","url":"https://clawpump.tech"},{"label":"ClawPump Docs","url":"https://clawpump.tech/docs"},{"label":"Get API Key","url":"https://clawpump.tech/dashboard/api"},{"label":"ClawPump MCP","url":"https://clawpump.tech/mcp"}]',
    'https://www.google.com/s2/favicons?domain=clawpump.tech&sz=128',
    'high',
    'This agent can execute real on-chain trades, launch tokens, and open positions on Solana. Always review trade confirmations before approving. Swap fees apply (10-85 bps). Intelligence calls cost $0.01 USDC each. Restrict with ACLs in shared rooms.',
    'Execute swaps, launch tokens, trade perps, lend/borrow, open prediction positions, and manage portfolio on Solana via ClawPump.'
  )
  ON CONFLICT (name) DO NOTHING;
