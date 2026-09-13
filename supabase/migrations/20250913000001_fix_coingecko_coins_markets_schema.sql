-- Fix CoinGecko coins_markets tool: "type":"enum" is not a valid JSON Schema type.
-- The LLM API rejects the entire tool set when any schema has an invalid type,
-- making ALL CoinGecko endpoints unusable — not just coins_markets.
--
-- Root cause: migration 20250827000001 rewrote the `order` property as
--   "type":"enum"  (invalid)
-- instead of the correct JSON Schema form:
--   "type":"string", "enum":[...]  (valid)
--
-- This surgical fix uses jsonb_set to replace only the broken property.

UPDATE public.heights_cloud_agents
SET agent = jsonb_set(
  agent,
  '{circleServices,11,tools,0,inputSchema,properties,order}',
  '{
    "type": "string",
    "enum": ["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc", "id_asc", "id_desc"],
    "default": "market_cap_desc",
    "description": "Sort order"
  }'::jsonb
)
WHERE name = 'CoinGecko';
