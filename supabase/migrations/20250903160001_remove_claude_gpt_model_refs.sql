-- Replace claude-sonnet-4-20250514 with glm-5.3-flash in all marketplace agent configs
UPDATE public.heights_cloud_agents
SET agent = REPLACE(agent::text, '"claude-sonnet-4-20250514"', '"glm-5.3-flash"')::jsonb
WHERE agent::text LIKE '%claude-sonnet-4-20250514%';

-- Fix Congress Trades agent (had truncated JSON missing closing brace)
UPDATE public.heights_cloud_agents
SET agent = (agent::text || '}')::jsonb
WHERE name = 'Congress Trades Analyst'
  AND agent::text NOT LIKE '%}%';

-- Replace any remaining claude/gpt/gemini model names in live user agents
UPDATE public.agent_heights_agents
SET model = 'glm-5.3-flash'
WHERE model LIKE '%claude%'
   OR model LIKE '%gpt-4%'
   OR model LIKE '%o3-mini%'
   OR model LIKE '%gemini%';
