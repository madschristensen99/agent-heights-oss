/**
 * Free→paid conversion tracking.
 * Logs funnel events for users who received the 2¢ free credit:
 *   1. first_inference — first chat or task by a free tier user
 *   2. credit_exhausted — free credit ran out (cap hit)
 *   3. conversion — user paid (entry fee or subscription)
 */

import { supabaseAdmin, isSupabaseConfigured } from "./supabase.js";

/** Track the first time a free tier user runs inference (chat or task). */
export async function trackFirstInference(userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabaseAdmin
      .from("heights_cloud_free_conversions")
      .upsert(
        { user_id: userId, first_inference_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
  } catch (err) {
    console.warn("[free-conversion] trackFirstInference error:", err);
  }
}

/** Track when a free tier user exhausts their free credit. */
export async function trackCreditExhausted(userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { data } = await supabaseAdmin
      .from("heights_cloud_free_conversions")
      .select("credit_exhausted_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (data?.credit_exhausted_at) return; // already tracked
    await supabaseAdmin
      .from("heights_cloud_free_conversions")
      .upsert(
        { user_id: userId, credit_exhausted_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
  } catch (err) {
    console.warn("[free-conversion] trackCreditExhausted error:", err);
  }
}

/** Track when a free tier user converts to paid (entry fee or subscription). */
export async function trackConversion(userId: string, type: "entry_fee" | "subscription"): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { data } = await supabaseAdmin
      .from("heights_cloud_free_conversions")
      .select("converted_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (data?.converted_at) return; // already converted
    await supabaseAdmin
      .from("heights_cloud_free_conversions")
      .upsert(
        { user_id: userId, converted_at: new Date().toISOString(), conversion_type: type },
        { onConflict: "user_id" },
      );
    console.log(`[free-conversion] user ${userId} converted via ${type}`);
  } catch (err) {
    console.warn("[free-conversion] trackConversion error:", err);
  }
}
