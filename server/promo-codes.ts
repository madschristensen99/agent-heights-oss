/**
 * Promo code system — waives the $0.99 entry fee.
 * When redeemed, sets entrance_paid = true + entry_method = 'promo' in user_payments.
 * This gives the user the same $0.50 usage cap as a paid entry.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { supabaseAdmin, isSupabaseConfigured, verifyToken } from "./supabase.js";
import { json, readBodyWithLimit } from "./security.js";
import { COMMAND_CENTER_ADMINS, type PromoCode } from "../shared/types.js";
import { trackConversion } from "./free-conversion.js";
import { ProfileManager } from "./profile.js";

// ─── User redemption ──────────────────────────────────────────────────────

export async function redeemPromoCode(
  userId: string,
  code: string,
): Promise<{ success: true; message: string } | { success: false; error: string }> {
  if (!isSupabaseConfigured) {
    return { success: false, error: "Service not configured" };
  }

  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    return { success: false, error: "Please enter a promo code" };
  }

  // Look up the code
  const { data: promo, error: lookupError } = await supabaseAdmin
    .from("heights_cloud_promo_codes")
    .select("*")
    .eq("code", normalizedCode)
    .maybeSingle();

  if (lookupError || !promo) {
    return { success: false, error: "Invalid promo code" };
  }

  if (!promo.active) {
    return { success: false, error: "This promo code is no longer active" };
  }

  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return { success: false, error: "This promo code has expired" };
  }

  if (promo.max_redemptions !== null && promo.redeemed_count >= promo.max_redemptions) {
    return { success: false, error: "This promo code has reached its redemption limit" };
  }

  // Check per-user limit
  const { count } = await supabaseAdmin
    .from("heights_cloud_promo_redemptions")
    .select("*", { count: "exact", head: true })
    .eq("promo_code_id", promo.id)
    .eq("user_id", userId);

  if ((count ?? 0) >= promo.per_user_limit) {
    return { success: false, error: "You've already redeemed this promo code" };
  }

  // Check if user already has entrance paid
  const { data: existing } = await supabaseAdmin
    .from("user_payments")
    .select("entrance_paid, entry_method")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing?.entrance_paid && existing?.entry_method === "paid") {
    return { success: false, error: "You've already paid the entry fee" };
  }
  if (existing?.entrance_paid && existing?.entry_method === "promo") {
    return { success: false, error: "You've already used a promo code" };
  }

  // Apply: set entrance_paid = true with entry_method = 'promo'
  const { error: upsertError } = await supabaseAdmin
    .from("user_payments")
    .upsert({
      user_id: userId,
      entrance_paid: true,
      entry_method: "promo",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (upsertError) {
    console.error("[promo] Failed to update user_payments:", upsertError);
    return { success: false, error: "Failed to redeem promo code" };
  }

  // Record the redemption
  const { error: redemptionError } = await supabaseAdmin
    .from("heights_cloud_promo_redemptions")
    .insert({
      promo_code_id: promo.id,
      user_id: userId,
    });

  if (redemptionError) {
    console.error("[promo] Failed to record redemption:", redemptionError);
    // Non-fatal — the entrance is already granted
  }

  // Increment redeemed_count
  const { error: incrementError } = await supabaseAdmin
    .from("heights_cloud_promo_codes")
    .update({ redeemed_count: promo.redeemed_count + 1 })
    .eq("id", promo.id);

  if (incrementError) {
    console.error("[promo] Failed to increment count:", incrementError);
  }

  // Track conversion + profile
  void trackConversion(userId, "entry_fee").catch(() => {});
  void ProfileManager.ingestEntrancePayment(userId).catch(() => {});

  console.log(`[promo] User ${userId} redeemed code ${normalizedCode}`);
  return { success: true, message: "Entry fee unlocked! You now have $0.50 in usage credits." };
}

// ─── Admin CRUD ───────────────────────────────────────────────────────────

export async function listPromoCodes(): Promise<PromoCode[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabaseAdmin
    .from("heights_cloud_promo_codes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row: any) => ({
    id: row.id,
    code: row.code,
    maxRedemptions: row.max_redemptions,
    redeemedCount: row.redeemed_count,
    perUserLimit: row.per_user_limit,
    expiresAt: row.expires_at,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function createPromoCode(
  code: string,
  maxRedemptions: number | null,
  perUserLimit: number,
  expiresAt: string | null,
  createdBy: string,
): Promise<{ success: true; promo: PromoCode } | { success: false; error: string }> {
  if (!isSupabaseConfigured) {
    return { success: false, error: "Service not configured" };
  }

  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode || normalizedCode.length < 3) {
    return { success: false, error: "Code must be at least 3 characters" };
  }

  const { data, error } = await supabaseAdmin
    .from("heights_cloud_promo_codes")
    .insert({
      code: normalizedCode,
      max_redemptions: maxRedemptions,
      per_user_limit: perUserLimit,
      expires_at: expiresAt,
      created_by: createdBy,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { success: false, error: "A promo code with this code already exists" };
    }
    console.error("[promo] Create failed:", error);
    return { success: false, error: "Failed to create promo code" };
  }

  return {
    success: true,
    promo: {
      id: data.id,
      code: data.code,
      maxRedemptions: data.max_redemptions,
      redeemedCount: data.redeemed_count,
      perUserLimit: data.per_user_limit,
      expiresAt: data.expires_at,
      active: data.active,
      createdBy: data.created_by,
      createdAt: data.created_at,
    },
  };
}

export async function deactivatePromoCode(id: string): Promise<{ success: boolean; error?: string }> {
  if (!isSupabaseConfigured) {
    return { success: false, error: "Service not configured" };
  }

  const { error } = await supabaseAdmin
    .from("heights_cloud_promo_codes")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[promo] Deactivate failed:", error);
    return { success: false, error: "Failed to deactivate promo code" };
  }

  return { success: true };
}

// ─── HTTP route handler ───────────────────────────────────────────────────

export async function handlePromoRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "";
  if (!url.startsWith("/api/promo") && !url.startsWith("/api/admin/promo-codes")) return false;

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

  // User redemption endpoint
  if (url === "/api/promo/redeem" && req.method === "POST") {
    const body = await readBodyWithLimit(req, 64 * 1024);
    let parsed: { code?: string } = {};
    try { parsed = JSON.parse(body.toString()); } catch { /* empty */ }

    if (!parsed.code) {
      json(res, 400, { error: "Missing 'code' field" });
      return true;
    }

    const result = await redeemPromoCode(user.id, parsed.code);
    if (result.success) {
      json(res, 200, { success: true, message: result.message });
    } else {
      json(res, 400, { success: false, error: result.error });
    }
    return true;
  }

  // Admin endpoints
  if (url.startsWith("/api/admin/promo-codes")) {
    if (!user.email || !COMMAND_CENTER_ADMINS.includes(user.email.toLowerCase())) {
      json(res, 403, { error: "Admin access required" });
      return true;
    }

    if (url === "/api/admin/promo-codes" && req.method === "GET") {
      const codes = await listPromoCodes();
      json(res, 200, codes);
      return true;
    }

    if (url === "/api/admin/promo-codes" && req.method === "POST") {
      const body = await readBodyWithLimit(req, 64 * 1024);
      let parsed: { code?: string; maxRedemptions?: number | null; perUserLimit?: number; expiresAt?: string | null } = {};
      try { parsed = JSON.parse(body.toString()); } catch { /* empty */ }

      const result = await createPromoCode(
        parsed.code ?? "",
        parsed.maxRedemptions ?? null,
        parsed.perUserLimit ?? 1,
        parsed.expiresAt ?? null,
        user.email,
      );

      if (result.success) {
        json(res, 200, result.promo);
      } else {
        json(res, 400, { error: result.error });
      }
      return true;
    }

    // Deactivate: PATCH /api/admin/promo-codes/:id
    const deactivateMatch = url.match(/^\/api\/admin\/promo-codes\/(.+)$/);
    if (deactivateMatch && req.method === "PATCH") {
      const result = await deactivatePromoCode(deactivateMatch[1]);
      if (result.success) {
        json(res, 200, { success: true });
      } else {
        json(res, 400, { error: result.error });
      }
      return true;
    }
  }

  json(res, 404, { error: "Unknown promo endpoint" });
  return true;
}
