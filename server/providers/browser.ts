/**
 * Agent Browser Manager
 *
 * Manages headless Playwright browser instances per agent. Each agent gets
 * its own browser context for navigating websites, taking screenshots,
 * clicking elements, filling forms, and extracting text.
 *
 * Screenshots are cached for the ScreenshotManager and HTTP endpoint to serve.
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";

// Apply the stealth plugin — patches canvas, WebGL, permissions, hardware
// concurrency, navigator.webdriver, plugins, languages, chrome runtime,
// and many more fingerprints that Cloudflare uses to detect headless browsers.
chromiumExtra.use(StealthPlugin());

const chromium = chromiumExtra as unknown as typeof import("playwright")["chromium"];

interface AgentBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Latest screenshot as base64 JPEG (no data: prefix). */
  lastFrame: string | null;
  /** Current URL the page is on. */
  currentUrl: string;
  /** Timestamp of last activity (for idle cleanup). */
  lastActivity: number;
  /** Console errors and failed network requests for debugging. */
  consoleErrors: string[];
  failedRequests: string[];
}

const browsers = new Map<string, AgentBrowser>();

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  browserInstance = await chromium.launch({
    headless: true,
    // --no-sandbox is required because the container runs as root.
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // Stealth: reduce automation fingerprints for Cloudflare / bot detection
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
      "--window-size=1280,720",
    ],
  });
  console.log("[browser] launched headless Chromium (stealth args)");
  return browserInstance;
}

/** Get or create a browser context+page for an agent. */
export async function getAgentBrowser(agentId: string): Promise<AgentBrowser> {
  const existing = browsers.get(agentId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Stealth plugin (applied at launch) handles all fingerprint patching:
  // navigator.webdriver, plugins, languages, chrome.runtime, canvas, WebGL,
  // permissions, hardware concurrency, and dozens more.

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  // Capture console errors for debugging SPA data-loading issues
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[console] ${msg.text().slice(0, 200)}`);
    }
  });
  // Capture failed network requests (API calls that return errors)
  page.on("requestfailed", (req) => {
    failedRequests.push(`[req] ${req.method()} ${req.url().slice(0, 150)} — ${req.failure()?.errorText ?? "unknown"}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`[res] ${res.status()} ${res.url().slice(0, 150)}`);
    }
  });

  const ab: AgentBrowser = {
    browser,
    context,
    page,
    lastFrame: null,
    currentUrl: "about:blank",
    lastActivity: Date.now(),
    consoleErrors,
    failedRequests,
  };
  browsers.set(agentId, ab);
  console.log(`[browser] created context for agent ${agentId}`);
  return ab;
}

/** Check if a URL is safe for agent navigation (blocks SSRF to internal services). */
function isUrlSafe(rawUrl: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Protocol '${parsed.protocol}' not allowed` };
  }
  const host = parsed.hostname.toLowerCase();
  // Block loopback
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
    return { safe: false, reason: "Loopback addresses are blocked" };
  }
  // Block cloud metadata endpoints
  if (host === "169.254.169.254" || host === "169.254.170.2") {
    return { safe: false, reason: "Cloud metadata endpoints are blocked" };
  }
  // Block private IP ranges (IPv4)
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number) as number[];
    if (a === 10) return { safe: false, reason: "Private IP range blocked" };
    if (a === 172 && b >= 16 && b <= 31) return { safe: false, reason: "Private IP range blocked" };
    if (a === 192 && b === 168) return { safe: false, reason: "Private IP range blocked" };
    if (a === 127) return { safe: false, reason: "Loopback addresses are blocked" };
    if (a === 169 && b === 254) return { safe: false, reason: "Link-local addresses are blocked" };
  }
  // Block IPv6 unique local addresses
  if (host.startsWith("fc") || host.startsWith("fd")) {
    return { safe: false, reason: "IPv6 unique local addresses are blocked" };
  }
  return { safe: true };
}

/** Navigate the agent's browser to a URL. Returns page title + URL. */
export async function browserNavigate(agentId: string, url: string): Promise<string> {
  const check = isUrlSafe(url);
  if (!check.safe) {
    return `Navigation blocked: ${check.reason}`;
  }
  const ab = await getAgentBrowser(agentId);
  await ab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Detect Cloudflare "Just a moment..." challenge and wait for it to resolve.
  // The challenge auto-executes JS in the browser; with stealth args it may clear.
  const title = await ab.page.title();
  if (title.includes("Just a moment") || title.includes("Attention Required")) {
    console.log(`[browser] Cloudflare challenge detected on ${url}, waiting up to 10s for resolution...`);
    try {
      // Wait for the challenge to resolve — the page title or URL will change
      await ab.page.waitForFunction(
        () => !document.title.includes("Just a moment") && !document.title.includes("Attention Required"),
        { timeout: 10_000 },
      );
      console.log(`[browser] Cloudflare challenge resolved for ${url}`);
    } catch {
      console.log(`[browser] Cloudflare challenge did not resolve within 10s for ${url}`);
    }
  }

  // Wait for network idle so Next.js / SPA client-side data fetching completes.
  // domcontentloaded fires before JS-driven API calls finish, so the DOM may
  // have empty states ("No data found") even though data is still loading.
  try {
    await ab.page.waitForLoadState("networkidle", { timeout: 8_000 });
  } catch {
    // networkidle can timeout on pages with persistent connections (polling,
    // websockets) — that's fine, we gave it a chance to fetch initial data.
  }

  ab.currentUrl = ab.page.url();
  ab.lastActivity = Date.now();
  const finalTitle = await ab.page.title();
  return `Navigated to ${ab.page.url()}\nTitle: ${finalTitle}`;
}

/** Take a screenshot and cache it. Returns base64 JPEG (no data: prefix). */
export async function browserScreenshot(agentId: string): Promise<string> {
  const ab = await getAgentBrowser(agentId);
  const buf = await ab.page.screenshot({ type: "jpeg", quality: 80 });
  const base64 = buf.toString("base64");
  ab.lastFrame = base64;
  ab.lastActivity = Date.now();
  return base64;
}

/** Extract visible text content from the current page. */
export async function browserExtractText(agentId: string): Promise<string> {
  const ab = await getAgentBrowser(agentId);
  // Wait a moment for any pending client-side renders (Next.js RSC hydration,
  // lazy-loaded components, API-driven data) to settle before reading the DOM.
  try {
    await ab.page.waitForLoadState("networkidle", { timeout: 5_000 });
  } catch {
    // Ignore timeout — read whatever is available.
  }
  const text = await ab.page.evaluate(() => document.body?.innerText ?? "");
  ab.lastActivity = Date.now();

  // Append debug info: console errors and failed network requests.
  // This helps diagnose why SPA pages (e.g. Next.js RSC apps) show empty states.
  let debug = "";
  if (ab.consoleErrors.length > 0) {
    debug += `\n\n--- Console Errors (${ab.consoleErrors.length}) ---\n${ab.consoleErrors.slice(-10).join("\n")}`;
  }
  if (ab.failedRequests.length > 0) {
    debug += `\n\n--- Failed Requests (${ab.failedRequests.length}) ---\n${ab.failedRequests.slice(-10).join("\n")}`;
  }

  // Truncate to avoid blowing up the context window
  return (text + debug).slice(0, 8000);
}

/** Click an element by CSS selector or text. */
export async function browserClick(agentId: string, selector: string): Promise<string> {
  const ab = await getAgentBrowser(agentId);
  // Try CSS selector first, then text match
  try {
    await ab.page.click(selector, { timeout: 10_000 });
  } catch {
    await ab.page.getByText(selector, { exact: false }).first().click({ timeout: 10_000 });
  }
  ab.lastActivity = Date.now();
  await ab.page.waitForTimeout(500);
  return `Clicked: ${selector}`;
}

/** Fill an input element by CSS selector with the given value. */
export async function browserFill(agentId: string, selector: string, value: string): Promise<string> {
  const ab = await getAgentBrowser(agentId);
  await ab.page.fill(selector, value, { timeout: 10_000 });
  ab.lastActivity = Date.now();
  return `Filled ${selector} with: ${value}`;
}

/** Get the current URL of the agent's browser. */
export function browserCurrentUrl(agentId: string): string {
  return browsers.get(agentId)?.currentUrl ?? "about:blank";
}

/** Get the last cached screenshot frame (base64 JPEG, no data: prefix). */
export function browserLastFrame(agentId: string): string | null {
  return browsers.get(agentId)?.lastFrame ?? null;
}

/** Check if an agent has an active browser session. */
export function hasBrowser(agentId: string): boolean {
  return browsers.has(agentId);
}

/** Close and clean up an agent's browser context. */
export async function closeAgentBrowser(agentId: string): Promise<void> {
  const ab = browsers.get(agentId);
  if (!ab) return;
  try {
    await ab.context.close();
  } catch { /* ignore */ }
  browsers.delete(agentId);
  console.log(`[browser] closed context for agent ${agentId}`);
}

/** Close all browser contexts and the browser instance. */
export async function destroyAllBrowsers(): Promise<void> {
  for (const [id] of browsers) {
    await closeAgentBrowser(id);
  }
  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* ignore */ }
    browserInstance = null;
    console.log("[browser] closed Chromium instance");
  }
}

/** Clean up idle browser contexts (older than 10 minutes with no activity). */
export async function cleanupIdleBrowsers(): Promise<void> {
  const now = Date.now();
  const IDLE_MS = 10 * 60 * 1000;
  for (const [agentId, ab] of browsers) {
    if (now - ab.lastActivity > IDLE_MS) {
      await closeAgentBrowser(agentId);
    }
  }
}
