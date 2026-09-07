-- Bulletproof data safety: soft-delete agents + remove CASCADE on child tables.
--
-- Problem: When agent rows were hard-deleted from agent_heights_agents,
-- ON DELETE CASCADE wiped agent_heights_agent_logs, _schedules, and
-- _conversation_messages automatically. A transient query failure on boot
-- could trigger a destructive flush that deleted ALL user agents, which
-- cascade-deleted ALL logs — irreversible data loss.
--
-- Solution:
-- 1. Add `archived` column to agents. Fire = set archived=true (soft delete).
--    Load query filters archived=false. Hard delete never happens from flush.
-- 2. Change CASCADE → SET NULL on child FKs so logs/schedules/messages
--    survive even if an agent row is somehow deleted.

-- Step 1: Add archived column to agents
ALTER TABLE public.agent_heights_agents
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for efficient filtering on load
CREATE INDEX IF NOT EXISTS idx_agent_heights_agents_archived
  ON public.agent_heights_agents (owner_id, archived);

-- Step 2: Change CASCADE → SET NULL on agent_heights_agent_logs
ALTER TABLE public.agent_heights_agent_logs
  DROP CONSTRAINT IF EXISTS agent_heights_agent_logs_agent_id_fkey;
ALTER TABLE public.agent_heights_agent_logs
  ADD CONSTRAINT agent_heights_agent_logs_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES public.agent_heights_agents(id)
  ON DELETE SET NULL;

-- Step 3: Change CASCADE → SET NULL on agent_heights_schedules
ALTER TABLE public.agent_heights_schedules
  DROP CONSTRAINT IF EXISTS agent_heights_schedules_agent_id_fkey;
ALTER TABLE public.agent_heights_schedules
  ADD CONSTRAINT agent_heights_schedules_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES public.agent_heights_agents(id)
  ON DELETE SET NULL;

-- Step 4: Change CASCADE → SET NULL on agent_heights_conversation_messages
ALTER TABLE public.agent_heights_conversation_messages
  DROP CONSTRAINT IF EXISTS agent_heights_conversation_messages_agent_id_fkey;
ALTER TABLE public.agent_heights_conversation_messages
  ADD CONSTRAINT agent_heights_conversation_messages_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES public.agent_heights_agents(id)
  ON DELETE SET NULL;

-- Step 5: Change CASCADE → SET NULL on task_cards.assigned_agent_id
-- (this FK may or may not exist depending on migration order)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'agent_heights_task_cards_assigned_agent_id_fkey'
    AND table_name = 'agent_heights_task_cards'
  ) THEN
    ALTER TABLE public.agent_heights_task_cards
      DROP CONSTRAINT agent_heights_task_cards_assigned_agent_id_fkey;
    ALTER TABLE public.agent_heights_task_cards
      ADD CONSTRAINT agent_heights_task_cards_assigned_agent_id_fkey
      FOREIGN KEY (assigned_agent_id) REFERENCES public.agent_heights_agents(id)
      ON DELETE SET NULL;
  END IF;
END $$;
