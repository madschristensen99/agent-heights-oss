import { Capacitor } from "@capacitor/core";

export type Platform = "ios" | "android" | "web";

export function getPlatform(): Platform {
  return Capacitor.getPlatform() as Platform;
}

export function isNativeIOS(): boolean {
  return Capacitor.getPlatform() === "ios";
}

export function isNativeAndroid(): boolean {
  return Capacitor.getPlatform() === "android";
}

export function isWeb(): boolean {
  return Capacitor.getPlatform() === "web";
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Features that are disabled on iOS for App Store compliance or
 * technical limitations (WKWebView doesn't support them).
 */
const IOS_DISABLED_FEATURES = new Set([
  "cdpSolana",
  "crossmintWallet",
  "premiumMarketplace",
  "screenShare",
  "webcam",
  "voice",
  "monacoEditor",
  "stripeCheckout",
  "tokenGate",
]);

const ANDROID_DISABLED_FEATURES = new Set([
  "screenShare",
  "monacoEditor",
]);

export type FeatureFlag =
  | "cdpSolana"
  | "crossmintWallet"
  | "premiumMarketplace"
  | "screenShare"
  | "webcam"
  | "voice"
  | "monacoEditor"
  | "stripeCheckout"
  | "tokenGate";

export function isFeatureEnabled(feature: FeatureFlag): boolean {
  const platform = getPlatform();
  if (platform === "ios" && IOS_DISABLED_FEATURES.has(feature)) return false;
  if (platform === "android" && ANDROID_DISABLED_FEATURES.has(feature)) return false;
  return true;
}

/**
 * Get the server URL for WebSocket / HTTP connections.
 * On web, this is the current page host (or VITE_WS_HOST env var).
 * On native, the Capacitor config hostname is used with the production server.
 */
export function getServerHost(): string {
  if (isNative()) {
    // Read from the Capacitor config — injected as a global or from env
    const envHost = (window as any).__SERVER_HOST__ as string | undefined;
    if (envHost) return envHost;
    // Fallback: production server
    return "agentheights.up.railway.app";
  }
  // Web: use existing logic (location.host with env var override)
  const runtimeEnv = (window as any).__ENV__ || {};
  const wsHost = runtimeEnv.VITE_WS_HOST ?? import.meta.env.VITE_WS_HOST;
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const effectiveWsHost = wsHost && (!wsHost.includes("localhost") || isLocal) ? wsHost : undefined;
  return effectiveWsHost ?? location.host;
}

export function getHttpBaseUrl(): string {
  const host = getServerHost();
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
  return isLocal ? `http://${host}` : `https://${host}`;
}
