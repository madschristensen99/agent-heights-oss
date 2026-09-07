/**
 * Rewarded ads module — uses Google AdMob via Capacitor.
 * Users watch a short video ad to unlock rewards (entry fee, usage credits).
 * Targets the RevenueCat Shipaton HAMM Award (highest ad-mediated monetization).
 *
 * BLOCKER: Replace ADMOB_APP_ID and ADMOB_REWARDED_AD_UNIT_ID with real values
 * from Google AdMob dashboard (https://apps.admob.com).
 * For testing, Google provides test ad unit IDs.
 */
import { AdMob, type AdMobRewardItem } from "@capacitor-community/admob";
import { getToken } from "./auth";
import { getHttpBaseUrl, isNative } from "./platform";

// ─── AdMob Configuration ───────────────────────────────────────────────────

// TODO: Replace with your AdMob App ID (format: ca-app-pub-XXXXXXXXXXXXXXXX~XXXXXXXXXX)
// Get this from https://apps.admob.com → Apps → Add App
const ADMOB_APP_ID = "ca-app-pub-3940256099942544~1458002511"; // Google test app ID

// TODO: Replace with your rewarded ad unit ID (format: ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX)
// Create this in AdMob → Ad units → Add ad unit → Rewarded
const ADMOB_REWARDED_AD_UNIT_ID = "ca-app-pub-3940256099942544/1719395716"; // Google test rewarded ad unit

let initialized = false;

// ─── Reward Types ──────────────────────────────────────────────────────────

export type RewardType = "entry_fee" | "usage_credits" | "agent_hire" | "inference_boost";

export interface RewardConfig {
  type: RewardType;
  title: string;
  description: string;
  amount: number;
}

export const REWARD_CONFIGS: Record<RewardType, RewardConfig> = {
  entry_fee: {
    type: "entry_fee",
    title: "Enter Agent Heights",
    description: "Watch a short ad to enter — then watch more ads to earn inference credits",
    amount: 1,
  },
  usage_credits: {
    type: "usage_credits",
    title: "Get 50 Usage Credits",
    description: "Watch a short ad to get 50 extra usage credits this month",
    amount: 50,
  },
  agent_hire: {
    type: "agent_hire",
    title: "Free Agent Hire",
    description: "Watch a short ad to hire one agent for free",
    amount: 1,
  },
  inference_boost: {
    type: "inference_boost",
    title: "Keep Your Agents Working",
    description: "Watch a short ad to get $0.01 inference credit — your agents keep working",
    amount: 1,
  },
};

// ─── Initialization ────────────────────────────────────────────────────────

export async function initAdMob(): Promise<void> {
  if (initialized || !isNative()) return;
  try {
    await AdMob.initialize({
      initializeForTesting: true, // TODO: Set to false for production
    });
    initialized = true;
    console.log("[ads] AdMob initialized with app ID:", ADMOB_APP_ID);
  } catch (err) {
    console.error("[ads] AdMob init failed:", err);
  }
}

// ─── Show Rewarded Ad ──────────────────────────────────────────────────────

export async function showRewardedAd(rewardType: RewardType): Promise<boolean> {
  if (!isNative()) {
    console.warn("[ads] Rewarded ads only available on native platforms");
    return false;
  }

  try {
    // Prepare the ad
    await AdMob.prepareRewardVideoAd({
      adId: ADMOB_REWARDED_AD_UNIT_ID,
    });

    // Show the ad and wait for completion
    const result = await AdMob.showRewardVideoAd() as AdMobRewardItem;

    // Check if user earned the reward
    if (result && result.type && result.amount) {
      console.log(`[ads] Reward earned: type=${result.type}, amount=${result.amount}`);
      await grantRewardOnServer(rewardType);
      return true;
    }
    return false;
  } catch (err) {
    console.error("[ads] Rewarded ad failed:", err);
    return false;
  }
}

// ─── Server Sync ───────────────────────────────────────────────────────────

async function grantRewardOnServer(rewardType: RewardType): Promise<void> {
  const token = getToken();
  if (!token) {
    console.warn("[ads] No auth token — skipping server sync");
    return;
  }
  try {
    const res = await fetch(`${getHttpBaseUrl()}/api/ads/reward`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rewardType }),
    });
    if (!res.ok) {
      console.error("[ads] Server reward grant failed:", res.status);
    } else {
      const data = await res.json();
      console.log("[ads] Server granted reward:", data);
    }
  } catch (err) {
    console.error("[ads] Server sync error:", err);
  }
}

// ─── Preload Ad (optional — preloads so it's ready instantly) ──────────────

export async function preloadRewardedAd(): Promise<void> {
  if (!isNative() || !initialized) return;
  try {
    await AdMob.prepareRewardVideoAd({
      adId: ADMOB_REWARDED_AD_UNIT_ID,
    });
    console.log("[ads] Rewarded ad preloaded");
  } catch (err) {
    console.error("[ads] Preload failed:", err);
  }
}
