import type { CapacitorConfig } from "@capacitor/cli";

const SERVER_URL = process.env.VITE_WS_HOST ?? "wss://agentheights.up.railway.app";

const config: CapacitorConfig = {
  appId: "com.agentheights.app",
  appName: "Agent Heights",
  webDir: "dist",
  backgroundColor: "#0d0f1a",
  ios: {
    contentInset: "always",
    scrollEnabled: false,
    allowsLinkPreview: false,
    limitsNavigationsToAppBoundDomains: true,
  },
  server: {
    // When running in a native shell, the web assets are loaded from the device.
    // The client uses this hostname for WebSocket + HTTP API connections.
    hostname: "agentheights.app",
    androidScheme: "https",
    iosScheme: "capacitor",
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: "#0d0f1a",
      showSpinner: false,
    },
  },
};

// Expose server URL to the client via a global so net.ts can pick it up.
// Capacitor injects this before the web view loads.
export { SERVER_URL };
