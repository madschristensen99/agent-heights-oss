/**
 * Agent Browser Manager
 *
 * Manages headless Playwright browser instances per agent. Each agent gets
 * its own browser context for navigating websites, taking screenshots,
 * clicking elements, filling forms, and extracting text.
 *
 * Screenshots are cached for the ScreenshotManager and HTTP endpoint to serve.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

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

  // Anti-detection: remove navigator.webdriver flag and patch other fingerprints
  // that Cloudflare and similar services use to detect headless browsers.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    (window as any).chrome = { runtime: {} };
  });

  const ab: AgentBrowser = {
    browser,
    context,
    page,
    lastFrame: null,
    currentUrl: "about:blank",
    lastActivity: Date.now(),
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
  const text = await ab.page.evaluate(() => document.body?.innerText ?? "");
  ab.lastActivity = Date.now();
  // Truncate to avoid blowing up the context window
  return text.slice(0, 8000);
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
