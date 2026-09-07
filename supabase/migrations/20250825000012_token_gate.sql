-- Token-gated room access verifications
-- Tracks which users have verified token ownership for the Holder's Lounge
CREATE TABLE heights_cloud_token_gate_verifications (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'phantom',
  token_mint TEXT NOT NULL,
  balance_at_verification BIGINT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, token_mint)
);

ALTER TABLE heights_cloud_token_gate_verifications
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own token gate verifications"
  ON heights_cloud_token_gate_verifications
  FOR SELECT
  USING (auth.uid() = user_id);

-- Index for fast expiry checks
CREATE INDEX idx_token_gate_expiry ON heights_cloud_token_gate_verifications(expires_at);
