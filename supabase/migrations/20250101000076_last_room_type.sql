-- Add last_room_type column to world_state for persisting the user's last
-- room type across server redeploys, so they can be restored to the correct
-- room (HQ2, private office, token-gated room, etc.) after a restart.

ALTER TABLE public.agent_heights_world_state
  ADD COLUMN IF NOT EXISTS last_room_type TEXT;
