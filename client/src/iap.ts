/**
 * RevenueCat IAP module — handles in-app purchases on iOS via RevenueCat SDK.
 * On web, Stripe is used instead (see payment.ts).
 *
 * BLOCKER: Replace REVENUECAT_PUBLIC_KEY with your actual key from RevenueCat dashboard.
 * BLOCKER: Create matching products in App Store Connect with the product IDs below.
 */
import { Purchases, PURCHASES_ERROR_CODE, CustomerInfo } from "@revenuecat/purchases-capacitor";
import { getToken } from "./auth";
import { getHttpBaseUrl } from "./platform";
import type { SubscriptionTier, BillingPeriod } from "../../shared/types";

// ─── RevenueCat Configuration ──────────────────────────────────────────────

// RevenueCat public iOS API key — set as VITE_REVENUECAT_PUBLIC_KEY env var
const REVENUECAT_PUBLIC_KEY = import.meta.env.VITE_REVENUECAT_PUBLIC_KEY ?? "appl_YOUR_REVENUECAT_KEY_HERE";

// App Store Connect product IDs — must match what you create in App Store Connect
// These are referenced by the RevenueCat dashboard entitlement configuration.
// Product IDs: agent_heights_entry, agent_heights_starter_monthly,
// agent_heights_starter_annual, agent_heights_pro_monthly, agent_heights_pro_annual,
// agent_heights_asset_upgrade

// RevenueCat entitlement identifiers
const ENTITLEMENTS = {
  entry: "entry",
  starter: "starter",
  pro: "pro",
  assetUpgrade: "asset_upgrade",
} as const;

let initialized = false;

// ─── Initialization ────────────────────────────────────────────────────────

export async function initRevenueCat(userId?: string): Promise<void> {
  if (initialized) return;
  try {
    await Purchases.configure({
      apiKey: REVENUECAT_PUBLIC_KEY,
      appUserID: userId ?? undefined,
    });
    initialized = true;
    console.log("[iap] RevenueCat initialized");
  } catch (err) {
    console.error("[iap] RevenueCat init failed:", err);
  }
}

// ─── Purchase Functions ────────────────────────────────────────────────────

export async function purchaseEntry(): Promise<void> {
  try {
    const offerings = await Purchases.getOfferings();
    const entryOffering = offerings.all[ENTITLEMENTS.entry];
    if (!entryOffering?.availablePackages?.[0]) {
      alert("Entry fee purchase is not available. Please try again later.");
      return;
    }
    const result = await Purchases.purchasePackage({
      aPackage: entryOffering.availablePackages[0],
    });
    await syncPurchaseWithServer(result.customerInfo);
  } catch (err: any) {
    if (err?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return;
    console.error("[iap] Entry purchase failed:", err);
    alert("Purchase failed: " + (err?.message ?? "Unknown error"));
  }
}

export async function purchaseSubscription(
  tier: SubscriptionTier,
  billingPeriod: BillingPeriod = "annual",
): Promise<void> {
  try {
    const entitlementId = tier === "pro" ? ENTITLEMENTS.pro : ENTITLEMENTS.starter;
    const offerings = await Purchases.getOfferings();
    const offering = offerings.all[entitlementId];
    if (!offering?.availablePackages?.length) {
      alert(`${tier} subscription is not available. Please try again later.`);
      return;
    }
    // Find the package matching the billing period
    const pkg = offering.availablePackages.find(
      (p) => billingPeriod === "annual" && p.packageType === "ANNUAL",
    ) ?? offering.availablePackages.find(
      (p) => billingPeriod === "monthly" && p.packageType === "MONTHLY",
    ) ?? offering.availablePackages[0];

    const result = await Purchases.purchasePackage({ aPackage: pkg });
    await syncPurchaseWithServer(result.customerInfo);
  } catch (err: any) {
    if (err?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return;
    console.error("[iap] Subscription purchase failed:", err);
    alert("Purchase failed: " + (err?.message ?? "Unknown error"));
  }
}

export async function purchaseAssetUpgrade(deploymentId: string): Promise<void> {
  try {
    const offerings = await Purchases.getOfferings();
    const upgradeOffering = offerings.all[ENTITLEMENTS.assetUpgrade];
    if (!upgradeOffering?.availablePackages?.[0]) {
      alert("Asset upgrade purchase is not available. Please try again later.");
      return;
    }
    const result = await Purchases.purchasePackage({
      aPackage: upgradeOffering.availablePackages[0],
    });
    await syncPurchaseWithServer(result.customerInfo, { deploymentId });
  } catch (err: any) {
    if (err?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return;
    console.error("[iap] Asset upgrade purchase failed:", err);
    alert("Purchase failed: " + (err?.message ?? "Unknown error"));
  }
}

// ─── Restore Purchases (Apple requirement) ─────────────────────────────────

export async function restorePurchases(): Promise<void> {
  try {
    const result = await Purchases.restorePurchases();
    await syncPurchaseWithServer(result.customerInfo);
    console.log("[iap] Purchases restored");
  } catch (err) {
    console.error("[iap] Restore failed:", err);
    alert("Failed to restore purchases. Please try again.");
  }
}

// ─── Customer Info ─────────────────────────────────────────────────────────

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  try {
    const result = await Purchases.getCustomerInfo();
    return result.customerInfo;
  } catch (err) {
    console.error("[iap] Get customer info failed:", err);
    return null;
  }
}

export function hasActiveEntitlement(info: CustomerInfo, entitlement: string): boolean {
  return Boolean(info.entitlements.active[entitlement]);
}

// ─── Server Sync ───────────────────────────────────────────────────────────

async function syncPurchaseWithServer(
  customerInfo: CustomerInfo,
  extra?: { deploymentId?: string },
): Promise<void> {
  const token = getToken();
  if (!token) {
    console.warn("[iap] No auth token — skipping server sync");
    return;
  }
  try {
    const activeEntitlements = Object.keys(customerInfo.entitlements.active);
    const res = await fetch(`${getHttpBaseUrl()}/api/iap/sync`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entitlements: activeEntitlements,
        originalAppUserId: customerInfo.originalAppUserId,
        deploymentId: extra?.deploymentId,
      }),
    });
    if (!res.ok) {
      console.error("[iap] Server sync failed:", res.status);
    }
  } catch (err) {
    console.error("[iap] Server sync error:", err);
  }
}
