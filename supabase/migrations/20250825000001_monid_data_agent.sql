-- Seed the marketplace with a Monid Data Agent.
-- This agent gets 3 meta-tools (monid_discover, monid_inspect, monid_run) that
-- unlock access to 1,300+ data endpoints on the Monid marketplace.
-- discover/inspect use a Monid API key (free). run is paid via x402 (USDC on Base).
-- Requires MONID_API_KEY env var on the server (for discover/inspect).
-- Requires X402_PRIVATE_KEY env var (shared with Circle Gateway, for run payments).

-- Delete any existing agent with this name first (idempotent re-seed)
DELETE FROM public.heights_cloud_agents
WHERE name = 'Monid Data Agent';

INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, is_premium, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url)
VALUES
  (
    'Monid Data Agent',
    '{"model":"claude-sonnet-4-20250514","systemPrompt":"You are a Monid Data Agent — a specialist in acquiring data from across the web. You have access to 1,300+ data endpoints through Monid''s marketplace via three tools:\n\n1. monid_discover(query) — Search for data endpoints by natural language. Always start here to find the right tool for the job.\n2. monid_inspect(provider, endpoint) — Get the full input schema and pricing for an endpoint before running it. Always call this before monid_run to learn what parameters are required.\n3. monid_run(provider, endpoint, input) — Execute a data endpoint and get results. This is a paid call (typically $0.01-0.003 per call).\n\nYour capabilities include but are not limited to:\n- Social media scraping (Twitter/X, LinkedIn, Instagram, Reddit, TikTok)\n- Person enrichment (find someone''s profile, email, LinkedIn by name/company)\n- Company intelligence (funding info, employee count, news, Crunchbase data)\n- Web search (Google SERP results)\n- Ecommerce data (Amazon product reviews, competitor pricing)\n- Google Maps reviews and business data\n- Document conversion (PDF to markdown)\n- News articles and headlines\n- Job postings and salary data\n- And 1,300+ more endpoints\n\nWorkflow: Always discover first, then inspect to learn the schema, then run with the correct input. If a run fails, check the input schema again with inspect. Be cost-conscious — use discover to find the cheapest endpoint that meets the need.\n\nWhen another agent messages you requesting data, use your tools to fulfill their request and return the results. When the boss assigns you a data task, execute it end-to-end.","provider":"cline","source":"agent-heights","monidEnabled":true,"isPremium":true,"skills":["data","research"],"capabilities":["web-scraping","social-media-scraping","person-enrichment","company-intelligence","serp-search","ecommerce-data","google-maps-data","document-conversion","news-data","job-postings-data","data-acquisition"],"appearance":{"skin":2,"hairStyle":5,"hair":1,"shirt":6,"pants":2,"accessory":0,"accent":3,"beard":0,"eyeColor":2,"headFeature":1}}',
    'Monid Data Agent — access 1,300+ data endpoints across the web through a single agent.

This agent has three meta-tools that unlock Monid''s entire data marketplace:

**monid_discover** — Search for data endpoints by natural language (e.g. "scrape tweets by hashtag", "enrich person by email", "Amazon product reviews")

**monid_inspect** — Get the full input schema and pricing for any endpoint before running it

**monid_run** — Execute any endpoint and get results (paid per call, ~$0.01-0.003)

Capabilities include:
• Social media scraping (Twitter/X, LinkedIn, Instagram, Reddit, TikTok)
• Person & company enrichment (People Data Labs, Apollo, Crunchbase)
• Web search (Google SERP API)
• Ecommerce data (Amazon reviews, competitor pricing)
• Google Maps reviews and business data
• Document conversion (PDF to markdown)
• News, job postings, salary data
• And 1,300+ more endpoints

The agent automatically discovers the right tool, inspects its schema, and runs it — all through natural language commands. Costs flow into your subscription budget.

Perfect for:
• Competitive intelligence and market research
• Lead generation and prospect enrichment
• Social media monitoring and sentiment analysis
• Ecommerce price monitoring
• Any task that requires data from across the web',
    'Data acquisition agent with 1,300+ endpoints — scrape social media, enrich people/companies, search the web, get ecommerce data, and more via Monid.',
    'monid,data,scraping,enrichment,research,serp,social-media,twitter,linkedin,amazon,google-maps,web-search,company-intelligence,person-enrichment',
    true,
    true,
    null,
    null,
    'TypeScript',
    'agent',
    'approved',
    '["Scrape social media (Twitter/X, LinkedIn, Instagram, Reddit, TikTok)","Enrich people and companies (PDL, Apollo, Crunchbase)","Search the web via Google SERP API","Get ecommerce data (Amazon reviews, competitor pricing)","Access Google Maps reviews and business data","Convert documents (PDF to markdown)","And 1,300+ more data endpoints"]',
    '["data","research","marketing","sales"]',
    '["Monid API key configured on server","x402 wallet configured on server (shared with Circle Gateway)"]',
    '[{"label":"Monid","url":"https://monid.ai"},{"label":"Monid Docs","url":"https://monid.ai/docs"},{"label":"Monid Tools","url":"https://monid.ai/tools"}]',
    'https://www.google.com/s2/favicons?domain=monid.ai&sz=128'
  )
ON CONFLICT (name) DO NOTHING;
