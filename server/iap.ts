/**
 * Server-side RevenueCat IAP handler.
 * Receives purchase sync from client and RevenueCat webhooks.
 * Updates user_payments table — same fields Stripe webhooks update.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { supabaseAdmin, isSupabaseConfigured, verifyToken, type AuthUser } from "./supabase.js";
import { json, readBodyWithLimit } from "./security.js";
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from "../shared/types.js";

// RevenueCat secret API key for server-side REST API calls
const REVENUECAT_SECRET_KEY = process.env.REVENUECAT_SECRET_KEY ?? "";

const RC_API_BASE = "https://api.revenuecat.com/v1";

export const isRevenueCatConfigured = Boolean(REVENUECAT_SECRET_KEY);

// ─── Entitlement → Tier mapping ────────────────────────────────────────────

function entitlementsToTier(entitlements: string[]): { tier: SubscriptionTier | null; entrancePaid: boolean } {
  const has = (id: string) => entitlements.includes(id);
  let tier: SubscriptionTier | null = null;
  if (has("pro")) tier = "pro";
  else if (has("starter")) tier = "starter";
  const entrancePaid = has("entry");
  return { tier, entrancePaid };
}

// ─── Client sync endpoint: POST /api/iap/sync ──────────────────────────────

async function handleIapSync(req: IncomingMessage, res: ServerResponse, user: AuthUser): Promise<void> {
  const body = await readBodyWithLimit(req, 64 * 1024);
  let parsed: { entitlements?: string[]; originalAppUserId?: string; deploymentId?: string } = {};
  try { parsed = JSON.parse(body.toString()); } catch { /* empty body */ }

  const entitlements = parsed.entitlements ?? [];
  const { tier, entrancePaid } = entitlementsToTier(entitlements);

  // Verify with RevenueCat REST API for security
  if (isRevenueCatConfigured) {
    try {
      const rcResponse = await fetch(`${RC_API_BASE}/subscribers/${encodeURIComponent(user.id)}`, {
        headers: { "Authorization": `Bearer ${REVENUECAT_SECRET_KEY}` },
      });
      if (rcResponse.ok) {
        const rcData = await rcResponse.json() as any;
        const activeEntitlements = Object.keys(rcData.subscriber?.entitlements ?? {}).filter(
          (key) => rcData.subscriber.entitlements[key]?.isActive,
        );
        const verified = entitlementsToTier(activeEntitlements);
        // Use verified data from RevenueCat instead of client-provided
        const subscriptionActive = verified.tier !== null;

        await supabaseAdmin
          .from("user_payments")
          .upsert({
            user_id: user.id,
            entrance_paid: verified.entrancePaid || undefined,
            entry_method: verified.entrancePaid ? "paid" : undefined,
            subscription_status: subscriptionActive ? "active" : "canceled",
            subscription_tier: verified.tier,
            current_period_end: null, // RevenueCat manages renewal dates
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" });

        console.log(`[iap] Synced user ${user.id}: tier=${verified.tier}, entrance=${verified.entrancePaid}, entitlements=${activeEntitlements.join(",")}`);

        json(res, 200, {
          entrancePaid: verified.entrancePaid,
          subscriptionActive,
          subscriptionTier: verified.tier,
          agentLimit: verified.tier ? SUBSCRIPTION_TIERS[verified.tier].agentLimit : 2,
          usageCap: verified.tier ? SUBSCRIPTION_TIERS[verified.tier].usageCap : (verified.entrancePaid ? 50 : 2),
          subscriptionStatus: subscriptionActive ? "active" : "none",
          currentPeriodEnd: null,
        });
        return;
      }
    } catch (err) {
      console.error("[iap] RevenueCat verification failed:", err);
    }
  }

  // Fallback: trust client-provided entitlements (less secure, but works without RC secret)
  const subscriptionActive = tier !== null;
  await supabaseAdmin
    .from("user_payments")
    .upsert({
      user_id: user.id,
      entrance_paid: entrancePaid || undefined,
      entry_method: entrancePaid ? "paid" : undefined,
      subscription_status: subscriptionActive ? "active" : "canceled",
      subscription_tier: tier,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  json(res, 200, {
    entrancePaid,
    subscriptionActive,
    subscriptionTier: tier,
    agentLimit: tier ? SUBSCRIPTION_TIERS[tier].agentLimit : 2,
    usageCap: tier ? SUBSCRIPTION_TIERS[tier].usageCap : (entrancePaid ? 50 : 2),
    subscriptionStatus: subscriptionActive ? "active" : "none",
    currentPeriodEnd: null,
  });
}

// ─── RevenueCat webhook: POST /api/iap/webhook ─────────────────────────────

async function handleIapWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBodyWithLimit(req, 256 * 1024);
  let payload: any;
  try { payload = JSON.parse(body.toString()); } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  // Verify authorization header if configured
  const authHeader = req.headers["authorization"];
  if (REVENUECAT_SECRET_KEY) {
    const expected = `Bearer ${REVENUECAT_SECRET_KEY}`;
    if (authHeader !== expected) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }
  }

  try {
    const event = payload.event;
    if (!event) {
      json(res, 400, { error: "Missing event" });
      return;
    }

    const userId = event.app_user_id;
    if (!userId) {
      json(res, 200, { received: true });
      return;
    }

    const entitlements = Object.keys(event.entitlements ?? {}).filter(
      (key) => event.entitlements[key]?.isActive,
    );
    const { tier, entrancePaid } = entitlementsToTier(entitlements);
    const subscriptionActive = tier !== null;

    await supabaseAdmin
      .from("user_payments")
      .upsert({
        user_id: userId,
        entrance_paid: entrancePaid || undefined,
        subscription_status: subscriptionActive ? "active" : "canceled",
        subscription_tier: tier,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    console.log(`[iap] Webhook: user=${userId}, event=${event.type}, tier=${tier}, entitlements=${entitlements.join(",")}`);
    json(res, 200, { received: true });
  } catch (err) {
    console.error("[iap] Webhook error:", err);
    json(res, 500, { error: "Internal error" });
  }
}

// ─── HTTP route handler ────────────────────────────────────────────────────

export async function handleIapRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "";
  if (!url.startsWith("/api/iap")) return false;

  // Webhook — no auth, verified via Authorization header
  if (url === "/api/iap/webhook" && req.method === "POST") {
    await handleIapWebhook(req, res);
    return true;
  }

  // All other IAP routes require auth
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

  if (url === "/api/iap/sync" && req.method === "POST") {
    await handleIapSync(req, res, user);
    return true;
  }

  json(res, 404, { error: "Unknown IAP endpoint" });
  return true;
}
