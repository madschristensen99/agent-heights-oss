-- Track free→paid conversion funnel for users who received the 2¢ free credit.
-- Each row represents a free tier user's journey from first inference to conversion.
CREATE TABLE IF NOT EXISTS heights_cloud_free_conversions (
  user_id TEXT NOT NULL PRIMARY KEY,
  first_inference_at TIMESTAMPTZ,     -- first chat or task execution by free tier user
  credit_exhausted_at TIMESTAMPTZ,    -- when free credit ran out (cap hit)
  converted_at TIMESTAMPTZ,           -- when they paid (entry fee or subscription)
  conversion_type TEXT,               -- 'entry_fee' or 'subscription'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE heights_cloud_free_conversions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own conversion" ON heights_cloud_free_conversions
  FOR SELECT USING (user_id = auth.uid()::text);
