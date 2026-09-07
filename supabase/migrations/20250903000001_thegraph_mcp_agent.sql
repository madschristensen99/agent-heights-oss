-- Seed marketplace agent and MCP catalog entry for The Graph Subgraph MCP server.
-- The Graph is a decentralized indexing protocol for blockchain data.
-- The Subgraph MCP server lets agents search subgraphs, inspect GraphQL schemas,
-- and run queries against any subgraph deployment on The Graph Network.
-- Auth: API key (Bearer token) from Subgraph Studio (https://thegraph.com/studio/)
-- Transport: Remote SSE at https://subgraphs.mcp.thegraph.com/sse
-- Docs: https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/

-- ── Delete existing entries (idempotent re-seed) ──────────────────────
DELETE FROM public.heights_cloud_agents
WHERE name IN ('The Graph', 'MCP: The Graph', 'The Graph Subgraph Analyst');

-- ── Marketplace agent (search_type = 'agent') ─────────────────────────
INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url)
VALUES
  (
    'The Graph',
    '{"model":"claude-sonnet-4-20250514","systemPrompt":"You are a The Graph Subgraph analyst agent connected to the Subgraph MCP server at https://subgraphs.mcp.thegraph.com/sse. You query blockchain data from The Graph Network — a decentralized indexing protocol covering Ethereum, Polygon, Arbitrum, Optimism, Base, and many other chains. You can: (1) search for subgraphs by keyword or contract address to find indexed datasets, (2) retrieve GraphQL schemas for any subgraph deployment to understand what data is available, (3) execute GraphQL queries against specific subgraph deployments to pull on-chain data like token transfers, protocol TVL, NFT trades, governance proposals, liquidity pool events, and more, (4) get 30-day query volume stats to gauge subgraph reliability and popularity, (5) find the top subgraph deployments indexing a specific contract on a specific chain. You translate natural-language questions into GraphQL queries automatically — users don''t need to know GraphQL. When a user asks about on-chain data: (a) search for relevant subgraphs by keyword or contract address, (b) retrieve the schema to understand available entities and fields, (c) construct and execute a GraphQL query, (d) present results in a clear, human-readable format with context. You collaborate with trading and wallet agents in the office — when a user wants on-chain analytics before making trades, you provide the data and insights. You are knowledgeable about DeFi protocols, NFT marketplaces, governance systems, and blockchain data structures. You explain complex GraphQL schemas in plain language. You are analytical, precise, and love diving into on-chain data. You wear a dark hoodie with a purple accent.","provider":"cline","source":"agent-heights","appearance":{"skin":0,"hairStyle":1,"hair":0,"shirt":7,"pants":4,"accessory":0,"accent":5,"beard":0,"eyeColor":4,"headFeature":0},"mcpServers":[{"name":"The Graph","url":"https://subgraphs.mcp.thegraph.com/sse","authType":"apikey","keyLabel":"Gateway API Key","keyPlaceholder":"Paste your Subgraph Studio API key...","keyHelpUrl":"https://thegraph.com/studio/"}]}',
    'The Graph — query on-chain data across all indexed blockchains via The Graph Network. Search subgraphs, inspect schemas, run GraphQL queries. API key required.

This agent can:
• Search for subgraphs by keyword or contract address across all supported chains
• Retrieve GraphQL schemas for any subgraph deployment (by deployment ID, Subgraph ID, or IPFS hash)
• Execute GraphQL queries against any subgraph deployment on The Graph Network
• Get 30-day query volume stats to gauge subgraph reliability
• Find the top subgraph deployments indexing a specific contract on a specific chain

Supported chains include Ethereum, Polygon, Arbitrum, Optimism, Base, Celo, Avalanche, Fantom, BNB Chain, and many more. Data covers DeFi protocols, NFT marketplaces, governance, token transfers, liquidity pools, and more.

Pairs with trading and wallet agents (Coinbase, Crossmint, ClawPump) for on-chain research before executing trades.

To connect: Get a free Gateway API Key from Subgraph Studio at https://thegraph.com/studio/. Paste your key when hiring this agent.',
    'The Graph — query on-chain data across all indexed chains. Search subgraphs, run GraphQL. API key.',
    'thegraph,subgraph,blockchain,graphql,ethereum,polygon,arbitrum,optimism,base,defi,nft,on-chain,data,web3,indexing,mcp',
    true,
    null,
    null,
    'TypeScript',
    'agent',
    'approved',
    '["Search for subgraphs by keyword or contract address across all chains","Retrieve GraphQL schemas by deployment ID, Subgraph ID, or IPFS hash","Execute GraphQL queries against any subgraph deployment","Get 30-day query volume stats for subgraph deployments","Find top subgraph deployments indexing a specific contract","Translate natural-language questions into GraphQL queries automatically"]',
    '["Data","Trading & Finance"]',
    '["The Graph Gateway API Key (free from https://thegraph.com/studio/)"]',
    '[{"label":"Subgraph MCP Docs","url":"https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/"},{"label":"Get API Key","url":"https://thegraph.com/studio/"},{"label":"The Graph Network","url":"https://thegraph.com/docs/en/about/"},{"label":"Supported Networks","url":"https://thegraph.com/docs/en/supported-networks/"}]',
    'https://icons.duckduckgo.com/ip3/thegraph.com.ico'
  )
ON CONFLICT (name) DO NOTHING;

-- ── MCP server catalog entry (search_type = 'mcp_server') ─────────────
INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url, risk_level, security_note, data_access)
VALUES
  (
    'MCP: The Graph',
    '{"id":"thegraph","transport":"remote","authType":"apikey","isOfficial":true,"category":["Data","Trading & Finance"],"icon":"https://icons.duckduckgo.com/ip3/thegraph.com.ico","url":"https://subgraphs.mcp.thegraph.com/sse","keyLabel":"Gateway API Key","keyPlaceholder":"Paste your Subgraph Studio API key...","keyHelpUrl":"https://thegraph.com/studio/"}',
    'The Graph Subgraph MCP server provides access to blockchain data across The Graph Network. Search for subgraphs by keyword or contract address, retrieve GraphQL schemas for any deployment, execute GraphQL queries against on-chain data, get 30-day query volume stats, and find top deployments for specific contracts. Covers Ethereum, Polygon, Arbitrum, Optimism, Base, and many more chains. Read-only data access — no write or transaction capabilities. Free Gateway API key from Subgraph Studio.',
    'On-chain blockchain data via The Graph Network — search subgraphs, run GraphQL queries. API key.',
    'thegraph,subgraph,blockchain,graphql,ethereum,polygon,arbitrum,optimism,base,defi,nft,on-chain,data,web3',
    true,
    null,
    null,
    'TypeScript',
    'mcp_server',
    'approved',
    '["Data","Trading & Finance"]',
    '["Data","Trading & Finance"]',
    '["The Graph Gateway API Key (https://thegraph.com/studio/)"]',
    '[{"label":"Subgraph MCP Docs","url":"https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/"},{"label":"Get API Key","url":"https://thegraph.com/studio/"},{"label":"Supported Networks","url":"https://thegraph.com/docs/en/supported-networks/"}]',
    'https://icons.duckduckgo.com/ip3/thegraph.com.ico',
    'low',
    'API key grants read-only access to query subgraph data on The Graph Network. No write, transaction, or financial operations are possible. Gateway API keys are free from Subgraph Studio. Rate limits may apply based on your Gateway plan.',
    'Search subgraphs, retrieve GraphQL schemas, and execute read-only GraphQL queries against any subgraph deployment on The Graph Network across all supported chains.'
  )
ON CONFLICT (name) DO NOTHING;
