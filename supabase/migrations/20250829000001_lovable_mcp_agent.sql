-- Seed marketplace agent and MCP catalog entry for Lovable MCP server.
-- Lovable is an AI-powered full-stack app builder that exposes itself as an MCP server.
-- Users authenticate with their own Lovable account via OAuth 2.1 (PKCE, public client).
-- The agent can create, iterate, inspect, and deploy web apps on the user's behalf.
-- Docs: https://docs.lovable.dev/integrations/lovable-mcp-server
-- GitHub: https://github.com/lovablelabs/mcp

-- ── Delete existing entries (idempotent re-seed) ──────────────────────
DELETE FROM public.heights_cloud_agents
WHERE name IN ('Lovable App Builder', 'MCP: Lovable');

-- ── Marketplace agent (search_type = 'agent') ─────────────────────────
INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url)
VALUES
  (
    'Lovable App Builder',
    '{"model":"claude-sonnet-4-20250514","systemPrompt":"You are a Lovable app builder agent connected to the Lovable MCP server at https://mcp.lovable.dev. You can create new full-stack web apps (React + Tailwind + shadcn/ui), send messages to iterate on projects, inspect code via diffs and file listings, deploy projects to production on lovable.app, manage project and workspace knowledge/instructions, enable and query cloud PostgreSQL databases, browse templates and design systems, and check project analytics. You help users go from idea to deployed app without leaving the conversation. When a user asks you to build something: (1) call list_workspaces to find their workspace, (2) call create_project with a clear initial_message describing what to build, (3) iterate via send_message if refinements are needed, (4) call get_diff to review what was built, (5) call deploy_project when the user is satisfied. Use plan_mode=true on send_message for complex features to discuss architecture before code is written. Be descriptive in your build prompts — describe WHAT to build, not HOW to implement it. Mention UI layout, desired behavior, and specific features. Always confirm with the user before deploying. Remember that create_project and send_message consume the user''s Lovable build credits. You are creative, energetic, and love turning ideas into reality. You wear a trendy startup hoodie.","provider":"cline","source":"agent-heights","appearance":{"skin":0,"hairStyle":3,"hair":1,"shirt":2,"pants":5,"accessory":1,"accent":4,"beard":0,"eyeColor":2,"headFeature":0},"mcpServers":[{"name":"Lovable","url":"https://mcp.lovable.dev","authType":"oauth"}]}',
    'Lovable App Builder — create, iterate, and deploy full-stack web apps via the Lovable MCP server (OAuth).

This agent can:
• Create new projects from a natural language description (React + Tailwind + shadcn/ui)
• Send messages to iterate on projects — add features, fix bugs, change design
• Inspect code — view diffs, list files, read source, browse edit history
• Deploy projects to production on lovable.app and get a live URL
• Enable and query cloud PostgreSQL databases (Supabase)
• Manage workspace and project knowledge/instructions
• Browse templates, design systems, and connectors
• Check project analytics (traffic, trends)
• Upload files (mockups, screenshots, wireframes) to attach to build messages

Uses your Lovable build credits. Available on all Lovable plans including Free.

To connect: Click "Connect via OAuth" when hiring this agent. You will sign in with your Lovable account.',
    'Lovable app builder — create, iterate, and deploy web apps via Lovable MCP (OAuth). 50+ tools.',
    'lovable,app builder,deploy,react,tailwind,shadcn,full-stack,web apps,mcp,development,oauth',
    true,
    null,
    null,
    'TypeScript',
    'agent',
    'approved',
    '["Create new web apps from natural language descriptions","Iterate on projects — add features, fix bugs, change design","Inspect code — diffs, file listings, source reading, edit history","Deploy projects to production on lovable.app","Enable and query cloud PostgreSQL databases","Manage workspace and project knowledge/instructions","Browse templates and design systems","Check project analytics and traffic data"]',
    '["Development"]',
    '["Lovable account (OAuth connection required)"]',
    '[{"label":"Lovable MCP Server","url":"https://mcp.lovable.dev"},{"label":"Documentation","url":"https://docs.lovable.dev/integrations/lovable-mcp-server"},{"label":"GitHub","url":"https://github.com/lovablelabs/mcp"},{"label":"Sign up (free)","url":"https://lovable.dev"}]',
    'https://icons.duckduckgo.com/ip3/lovable.dev.ico'
  )
ON CONFLICT (name) DO NOTHING;

-- ── MCP server catalog entry (search_type = 'mcp_server') ─────────────
INSERT INTO public.heights_cloud_agents (name, agent, description, summary, tags, is_free, price, price_usd, language, search_type, status, use_cases, category, requirements, links, image_url, risk_level, security_note, data_access)
VALUES
  (
    'MCP: Lovable',
    '{"id":"lovable","transport":"remote","authType":"oauth","isOfficial":true,"category":["Development"],"icon":"https://icons.duckduckgo.com/ip3/lovable.dev.ico","url":"https://mcp.lovable.dev"}',
    'Lovable is an AI-powered full-stack app builder that exposes itself as an MCP server. Create, iterate, inspect, and deploy web apps (React + Tailwind + shadcn/ui) programmatically. 50+ tools across projects, agent interaction, code inspection, knowledge, cloud database, connectors, analytics, and file uploads. OAuth 2.1 with PKCE. Available on all plans including Free. create_project and send_message consume build credits.',
    'AI app builder — create, iterate, and deploy web apps via MCP. OAuth. 50+ tools.',
    'lovable,app builder,deploy,react,tailwind,shadcn,full-stack,web apps,development',
    true,
    null,
    null,
    'TypeScript',
    'mcp_server',
    'approved',
    '["Development"]',
    '["Development"]',
    '["Lovable account (OAuth)"]',
    '[{"label":"Documentation","url":"https://docs.lovable.dev/integrations/lovable-mcp-server"},{"label":"GitHub","url":"https://github.com/lovablelabs/mcp"},{"label":"Sign up","url":"https://lovable.dev"}]',
    'https://icons.duckduckgo.com/ip3/lovable.dev.ico',
    'medium',
    'OAuth grants access to your entire Lovable workspace — all projects, databases, and deployments. The agent can create, modify, and deploy apps on your behalf. Use a dedicated test workspace if sharing agents in shared rooms. create_project and send_message consume your Lovable build credits.',
    'Create, iterate, inspect, and deploy Lovable projects. Run SQL against project databases. Manage workspace and project knowledge/instructions.'
  )
ON CONFLICT (name) DO NOTHING;
