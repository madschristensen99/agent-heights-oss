-- Fix: world_state.seed was INTEGER (int32, max 2,147,483,647) but seeds are
-- generated with Math.floor(Math.random() * 0xffffffff) which can produce
-- values up to 4,294,967,295 — exceeding int32 range and causing:
--   "value '2359182896' is out of range for type integer"
-- Also fix rooms.seed which has the same issue.

ALTER TABLE public.agent_heights_world_state
  ALTER COLUMN seed TYPE BIGINT;

ALTER TABLE public.agent_heights_rooms
  ALTER COLUMN seed TYPE BIGINT;
