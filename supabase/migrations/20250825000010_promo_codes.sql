-- Promo code system for waiving the $0.99 entry fee.
-- Also adds entry_method column to distinguish how the user entered:
--   NULL  = free tier (no entry)
--   'ad'  = entered by watching a rewarded ad (small credit)
--   'paid' = paid $0.99 via Stripe or RevenueCat IAP
--   'promo' = redeemed a promo code

ALTER TABLE public.user_payments
  ADD COLUMN IF NOT EXISTS entry_method TEXT DEFAULT NULL;

-- Promo codes table
CREATE TABLE IF NOT EXISTS public.heights_cloud_promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  max_redemptions INT,          -- NULL = unlimited
  redeemed_count INT NOT NULL DEFAULT 0,
  per_user_limit INT NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ,       -- NULL = never expires
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.heights_cloud_promo_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to promo codes" ON public.heights_cloud_promo_codes;
CREATE POLICY "Service role full access to promo codes"
  ON public.heights_cloud_promo_codes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Promo redemptions table (audit trail)
CREATE TABLE IF NOT EXISTS public.heights_cloud_promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES public.heights_cloud_promo_codes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.heights_cloud_promo_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to promo redemptions" ON public.heights_cloud_promo_redemptions;
CREATE POLICY "Service role full access to promo redemptions"
  ON public.heights_cloud_promo_redemptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own redemptions" ON public.heights_cloud_promo_redemptions;
CREATE POLICY "Users read own redemptions"
  ON public.heights_cloud_promo_redemptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON public.heights_cloud_promo_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON public.heights_cloud_promo_redemptions(promo_code_id);
