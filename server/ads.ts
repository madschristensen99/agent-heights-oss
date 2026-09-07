/**
 * Server-side ad reward handler.
 * Grants rewards to users after they watch a rewarded ad.
 * Updates user_payments and usage records.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { supabaseAdmin, isSupabaseConfigured, verifyToken, type AuthUser } from "./supabase.js";
import { json, readBodyWithLimit } from "./security.js";

type RewardType = "entry_fee" | "usage_credits" | "agent_hire" | "inference_boost";

const REWARD_AMOUNTS: Record<RewardType, number> = {
  entry_fee: 1,
  usage_credits: 50,
  agent_hire: 1,
  inference_boost: 1, // $0.01 in inference credit per ad watch
};

// Per-type daily limits — inference_boost gets more (ad-supported free inference)
const DAILY_LIMITS: Record<RewardType, number> = {
  entry_fee: 5,
  usage_credits: 5,
  agent_hire: 5,
  inference_boost: 20,
};

async function handleAdReward(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<void> {
  const body = await readBodyWithLimit(req, 64 * 1024);
  let parsed: { rewardType?: RewardType } = {};
  try { parsed = JSON.parse(body.toString()); } catch { /* empty */ }

  const rewardType = parsed.rewardType;
  if (!rewardType || !(rewardType in REWARD_AMOUNTS)) {
    json(res, 400, { error: "Invalid reward type" });
    return;
  }

  // Per-type rate limit check
  const today = new Date().toISOString().slice(0, 10);
  const dailyLimit = DAILY_LIMITS[rewardType];
  const { count } = await supabaseAdmin
    .from("ad_rewards")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("reward_type", rewardType)
    .gte("created_at", today + "T00:00:00Z");

  if ((count ?? 0) >= dailyLimit) {
    json(res, 429, { error: `Daily limit reached for ${rewardType} (${dailyLimit}/day). Try again tomorrow!` });
    return;
  }

  // Record the ad reward
  await supabaseAdmin.from("ad_rewards").insert({
    user_id: user.id,
    reward_type: rewardType,
    amount: REWARD_AMOUNTS[rewardType],
  });

  // Apply the reward
  if (rewardType === "entry_fee") {
    // Mark entrance as entered via ad (not paid) — gives $0.01 usage cap instead of $0.50
    await supabaseAdmin
      .from("user_payments")
      .upsert({
        user_id: user.id,
        entrance_paid: true,
        entry_method: "ad",
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    console.log(`[ads] User ${user.id} entered via rewarded ad (entry_method=ad)`);
    json(res, 200, {
      success: true,
      reward: "entry_fee",
      message: "You're in! Watch more ads to earn inference credits, or subscribe for more agents.",
    });
  } else if (rewardType === "usage_credits") {
    // Add usage credits (record as negative usage to give credit)
    await supabaseAdmin.from("api_usage_records").insert({
      user_id: user.id,
      cost_usd: -REWARD_AMOUNTS.usage_credits / 100, // negative = credit
      model: "ad_reward",
      tokens_in: 0,
      tokens_out: 0,
      task_id: null,
    });

    console.log(`[ads] User ${user.id} earned 50 usage credits via rewarded ad`);
    json(res, 200, {
      success: true,
      reward: "usage_credits",
      amount: 50,
      message: "50 usage credits added to your account!",
    });
  } else if (rewardType === "agent_hire") {
    // Grant a free agent hire token
    await supabaseAdmin.from("ad_rewards").insert({
      user_id: user.id,
      reward_type: "agent_hire_token",
      amount: 1,
    });

    console.log(`[ads] User ${user.id} earned free agent hire via rewarded ad`);
    json(res, 200, {
      success: true,
      reward: "agent_hire",
      message: "Free agent hire unlocked!",
    });
  } else if (rewardType === "inference_boost") {
    // Grant $0.01 inference credit (ad-supported free inference)
    await supabaseAdmin.from("api_usage_records").insert({
      user_id: user.id,
      cost_usd: -REWARD_AMOUNTS.inference_boost / 100, // negative = credit ($0.01)
      model: "ad_reward",
      tokens_in: 0,
      tokens_out: 0,
      task_id: null,
    });

    console.log(`[ads] User ${user.id} earned $0.01 inference credit via rewarded ad`);
    json(res, 200, {
      success: true,
      reward: "inference_boost",
      amount: REWARD_AMOUNTS.inference_boost,
      message: "$0.01 inference credit added! Watch more ads to keep your agents working.",
    });
  }
}

// ─── HTTP route handler ────────────────────────────────────────────────────

export async function handleAdRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "";
  if (!url.startsWith("/api/ads")) return false;

  if (!isSupabaseConfigured) {
    json(res, 503, { error: "Supabase not configured" });
    return true;
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    json(res, 401, { error: "Authentication required" });
    return true;
  }
  const user = await verifyToken(token);
  if (!user) {
    json(res, 401, { error: "Invalid token" });
    return true;
  }

  if (url === "/api/ads/reward" && req.method === "POST") {
    await handleAdReward(req, res, user);
    return true;
  }

  json(res, 404, { error: "Unknown ad endpoint" });
  return true;
}
