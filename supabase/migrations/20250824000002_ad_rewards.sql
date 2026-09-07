-- Ad rewards table — tracks rewarded ad views and grants
-- Used for RevenueCat Shipaton HAMM Award (highest ad-mediated monetization)

create table if not exists heights_cloud_ad_rewards (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  reward_type text not null check (reward_type in ('entry_fee', 'usage_credits', 'agent_hire', 'agent_hire_token', 'inference_boost')),
  amount integer not null default 1,
  created_at timestamptz not null default now()
);

-- Index for rate limiting queries (count rewards per user per day)
create index if not exists idx_ad_rewards_user_date
  on heights_cloud_ad_rewards (user_id, created_at);

-- Row-level security: users can only see their own ad rewards
alter table heights_cloud_ad_rewards enable row level security;

create policy "Users can view own ad rewards"
  on heights_cloud_ad_rewards for select
  using (auth.uid()::text = user_id);

create policy "Users can insert own ad rewards"
  on heights_cloud_ad_rewards for insert
  with check (auth.uid()::text = user_id);
