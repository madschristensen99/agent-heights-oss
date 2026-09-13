-- Seed Coinbase EVM Agent and Crossmint EVM Agent into the marketplace.
-- These agents were defined in scripts/seed-defi-agents.cjs and listed in
-- FEATURED_AGENTS (server/marketplace.ts) but never had SQL migrations created.
-- Coinbase EVM: auto-provisioned EVM wallet via Coinbase CDP (cdpEvm: true)
-- Crossmint EVM: auto-provisioned gasless smart wallet via Crossmint (crossmintWallet: true, crossmintChain: base-sepolia)

-- Delete existing entries first (idempotent re-seed)
DELETE FROM public.heights_cloud_agents
WHERE name IN ('Coinbase EVM Agent', 'Crossmint EVM Agent');

INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url)
VALUES
  (
    'Coinbase EVM Agent',
    '{"model":"claude-sonnet-4-20250514","systemPrompt":"You are a Coinbase EVM agent with an auto-provisioned EVM wallet via Coinbase Developer Platform (CDP). You operate on Base Sepolia by default (configurable via CDP_EVM_NETWORK env var). You can check your wallet address, view ETH and ERC-20 token balances with USD values, transfer ETH and ERC-20 tokens to any EVM address, swap tokens via 0x DEX aggregation for best routing across Uniswap, SushiSwap, Curve, and more, get swap price quotes without executing, send raw EVM transactions for DeFi composability (interact with any smart contract), request testnet faucet funds (Base Sepolia or Ethereum Sepolia), sign messages to prove wallet ownership, search for tokens by name/symbol to get contract addresses, view transaction history with explorer links, and check transaction status. Your wallet is secured in Coinbase TEE (Trusted Execution Environment) — private keys never leave Coinbase. Always confirm transactions with the user before executing, showing the recipient address, amount, and token. You are knowledgeable about EVM DeFi ecosystems including Uniswap V3, Aave V3, Lido staking, Curve Finance, Compound, and 1inch. You can help users construct calldata for any EVM smart contract interaction. If no spending policy is set, recommend the user set one. You have a modern appearance with Coinbase blue accents.","provider":"cline","source":"agent-heights","appearance":{"skin":1,"hairStyle":5,"hair":0,"shirt":1,"pants":5,"accessory":1,"accent":9,"beard":0,"eyeColor":0,"headFeature":0},"cdpEvm":true}',
    'Coinbase EVM Agent — auto-provisioned EVM wallet via Coinbase CDP. No user credentials needed. Runs on Base Sepolia by default.

This agent can:
• Get its own EVM wallet address (auto-provisioned on first use)
• Check ETH and ERC-20 token balances with USD values
• Transfer ETH and ERC-20 tokens to any address
• Swap tokens via 0x DEX aggregation (Uniswap, SushiSwap, Curve, etc.)
• Get swap price quotes without executing
• Send raw EVM transactions for DeFi composability
• Request testnet faucet funds (Base Sepolia / Ethereum Sepolia)
• Sign messages to prove wallet ownership
• Search for tokens by name/symbol to get contract addresses
• View transaction history with explorer links
• Check transaction status
• View portfolio with allocations

Wallets are secured in Coinbase Trusted Execution Environment (TEE). No user API keys or credentials needed — the server handles everything via Coinbase CDP SDK.

To start: Just hire the agent. The wallet is created automatically on first task.',
    'Coinbase EVM agent — auto-provisioned wallet on Base, transfers, 0x swaps, signing, DeFi composability. No setup needed.',
    'coinbase,evm,base,ethereum,defi,wallet,crypto,cdp,transfers,swaps,0x,signing',
    true,
    null,
    null,
    'TypeScript',
    'agent',
    'approved',
    '["Get auto-provisioned EVM wallet address","Transfer ETH and ERC-20 tokens","Swap tokens via 0x DEX aggregation","Search for tokens by name/symbol","Get swap price quotes","Send raw EVM transactions for DeFi","Request testnet faucet funds","Sign messages to prove ownership","View transaction history","Check transaction status","View portfolio overview"]',
    '["trading","finance","defi","wallet"]',
    '[]',
    '[{"label":"CDP Documentation","url":"https://docs.cdp.coinbase.com/wallets/quickstart/api-key-auth"},{"label":"BaseScan Explorer","url":"https://sepolia.basescan.org"},{"label":"0x API","url":"https://docs.0x.org/introduction/0x-api"}]',
    '/assets/agents/coinbase-evm-agent.png'
  ),
  (
    'Crossmint EVM Agent',
    '{"model":"claude-sonnet-4-20250514","systemPrompt":"You are a Crossmint EVM agent with an auto-provisioned smart wallet on Base Sepolia. Your wallet uses ERC-4337 account abstraction with gas sponsorship — you don''t need native ETH for gas fees. You can check your wallet address, view token balances (ETH, ERC-20, USDC), transfer tokens to any EVM address, swap tokens via 1inch DEX aggregation, get swap quotes without executing, send arbitrary transactions for DeFi composability, sign messages to prove wallet ownership, check your wallet policy, view transaction history, and search for tokens. Gas fees are sponsored by Crossmint''s paymaster. Always confirm transactions with the user before executing, showing the recipient address, amount, and token. You are knowledgeable about EVM DeFi ecosystems including Uniswap V3, Aave V3, Lido, Curve, and Compound. You have a sleek modern appearance with Crossmint purple accents.","provider":"cline","source":"agent-heights","appearance":{"skin":2,"hairStyle":3,"hair":5,"shirt":6,"pants":5,"accessory":4,"accent":4,"beard":0,"eyeColor":1,"headFeature":0},"crossmintWallet":true,"crossmintChain":"base-sepolia"}',
    'Crossmint EVM Agent — auto-provisioned smart wallet on Base Sepolia with gas sponsorship. No user credentials needed.

This agent can:
• Get its own EVM smart wallet address (auto-provisioned, ERC-4337)
• Check token balances (ETH, ERC-20, USDC) with USD values
• Transfer tokens to any EVM address (gas sponsored!)
• Swap tokens via 1inch DEX aggregation
• Get swap price quotes without executing
• Send arbitrary transactions for DeFi composability
• Sign messages to prove wallet ownership
• Check wallet policy and spending limits
• View transaction history
• Search for tokens by name/symbol

Gas fees are sponsored by Crossmint''s paymaster — the agent doesn''t need native ETH for transactions. Wallets use ERC-4337 account abstraction with built-in security policies. No user API keys needed — the server handles everything via Crossmint SDK.

To start: Just hire the agent. The wallet is created automatically on first task.',
    'Crossmint EVM agent — gasless smart wallet on Base, transfers, 1inch swaps, signing, DeFi composability. No setup needed.',
    'crossmint,evm,base,ethereum,defi,wallet,crypto,gasless,transfers,swaps,1inch,smart-wallet,erc-4331',
    true,
    null,
    null,
    'TypeScript',
    'agent',
    'approved',
    '["Get auto-provisioned EVM smart wallet address","Transfer tokens gas-free (sponsored)","Swap tokens via 1inch DEX aggregation","Get swap price quotes","Send arbitrary EVM transactions for DeFi","Sign messages to prove ownership","Check wallet policy","View transaction history","Search for tokens by name/symbol"]',
    '["trading","finance","defi","wallet"]',
    '[]',
    '[{"label":"Crossmint Documentation","url":"https://crossmint-crossmint-sdk.mintlify.app/wallets-sdk/evm-wallets"},{"label":"BaseScan Explorer","url":"https://sepolia.basescan.org"},{"label":"1inch API","url":"https://docs.1inch.io/"}]',
    'https://www.google.com/s2/favicons?domain=crossmint.com&sz=128'
  )
ON CONFLICT (name) DO NOTHING;
