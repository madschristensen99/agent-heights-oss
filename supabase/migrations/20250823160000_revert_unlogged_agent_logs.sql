-- Revert agent_heights_agent_logs from UNLOGGED back to LOGGED.
-- UNLOGGED tables are automatically truncated after a PostgreSQL crash or
-- unclean shutdown, causing permanent loss of agent conversation context.
-- Agent logs are user-visible conversation history, not transient data.
ALTER TABLE public.agent_heights_agent_logs SET LOGGED;
