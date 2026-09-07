/**
 * Monid data marketplace provider — gives agents access to 1,300+ data
 * endpoints (social media scraping, person/company enrichment, SERP search,
 * ecommerce data, etc.) via three meta-tools:
 *
 *   1. monid_discover — search for endpoints by natural language query
 *   2. monid_inspect  — get input schema + pricing for a specific endpoint
 *   3. monid_run      — execute an endpoint (paid via x402 / USDC on Base)
 *
 * discover + inspect use a Monid API key (free, no payment).
 * run uses our x402 wallet to pay per-call, cost flows into the user's
 * subscription budget via the same premium proxy infrastructure.
 *
 * Required env vars:
 *   MONID_API_KEY — API key for discover/inspect (get at monid.ai)
 *   X402_PRIVATE_KEY — already used by Circle Gateway (shared)
 */

import type { AgentTool } from "@cline/sdk";
import { payAndFetchWithOptions, isX402Configured } from "./x402-pay.js";
import { getMonthlyPremiumSpend, getPremiumCap } from "../usage.js";
import type { SubscriptionTier } from "../../shared/types.js";

const MONID_API_BASE = "https://api.monid.ai";
const MONID_X402_BASE = "https://x402.monid.ai";
const MONID_RUN_URL = `${MONID_X402_BASE}/v1/run`;
const MONID_RUNS_URL = `${MONID_X402_BASE}/v1/runs`;

/** Minimum cost per Monid x402 run (their floor). */
const MONID_MIN_COST = 0.01;

/** Maximum Monid runs per task. */
const MAX_MONID_RUNS_PER_TASK = 15;

/** Maximum total Monid spend per task in USD. */
const MAX_MONID_TASK_SPEND = 0.50;

/** Maximum results to return from discover. */
const MAX_DISCOVER_RESULTS = 20;

/** Polling interval for async Monid runs (ms). */
const MONID_POLL_INTERVAL_MS = 5000;

/** Maximum poll attempts before giving up. */
const MONID_MAX_POLL_ATTEMPTS = 24; // 2 minutes

/** Maximum characters in a Monid result before truncation. */
const MAX_MONID_RESULT_CHARS = 30_000;

export interface MonidProxyContext {
  userId: string;
  agentId: string;
  agentName: string;
  subscriptionTier: SubscriptionTier | null;
  onPremiumUsage?: (params: {
    userId: string;
    agentId: string;
    agentName: string;
    serviceName: string;
    cost: number;
    task?: string;
  }) => void;
}

function getMonidApiKey(): string | null {
  return process.env.MONID_API_KEY ?? null;
}

/** In-memory premium spend cache per user (shared with premium-proxy). */
const monidSpendCache = new Map<string, { spend: number; month: number }>();

async function getCachedSpend(userId: string): Promise<number> {
  const now = new Date();
  const currentMonth = now.getMonth();
  const cached = monidSpendCache.get(userId);
  if (cached && cached.month === currentMonth) return cached.spend;
  const dbSpend = await getMonthlyPremiumSpend(userId);
  monidSpendCache.set(userId, { spend: dbSpend, month: currentMonth });
  return dbSpend;
}

function incrementSpendCache(userId: string, cost: number): void {
  const cached = monidSpendCache.get(userId);
  if (cached) cached.spend += cost;
}

/** Truncate a string to maxChars with a truncation notice. */
function truncateResult(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n\n[... result truncated: ${s.length.toLocaleString()} chars total, showing first ${maxChars.toLocaleString()} ...]`;
}

/**
 * Load Monid data marketplace tools for an agent.
 * Returns 3 tools: monid_discover, monid_inspect, monid_run.
 */
export async function loadMonidTools(proxyCtx: MonidProxyContext): Promise<AgentTool<any, any>[]> {
  const apiKey = getMonidApiKey();
  const x402Ready = isX402Configured();
  const tools: AgentTool<any, any>[] = [];

  if (!apiKey) {
    console.warn("[monid] MONID_API_KEY not set — discover/inspect will fail. Run tool will still work if x402 is configured.");
  }
  if (!x402Ready) {
    console.warn("[monid] x402 wallet not configured — run tool will fail. discover/inspect will still work if API key is set.");
  }

  let taskRunCount = 0;
  let taskSpend = 0;

  // ── Tool 1: monid_discover ──────────────────────────────────────────
  tools.push({
    name: "monid_discover",
    description: `Search Monid's marketplace of 1,300+ data endpoints by natural language query. Returns matching endpoints with provider, endpoint path, description, price, and tags. Use this to find tools for: social media scraping (Twitter/X, LinkedIn, Instagram, Reddit, TikTok), person/company enrichment (People Data Labs, Apollo), web search (SERP/Google), company intelligence (Crunchbase funding, news, job postings), ecommerce data (Amazon reviews, competitor pricing), Google Maps reviews, document conversion (PDF to markdown), and more. Free — no payment required.${!apiKey ? " NOTE: MONID_API_KEY not configured — this tool will return an error." : ""}`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g. 'scrape tweets by hashtag', 'enrich person by email', 'google search results API', 'amazon product reviews')",
        },
        count: {
          type: "number",
          description: `Maximum results to return (default: ${MAX_DISCOVER_RESULTS})`,
        },
      },
      required: ["query"],
    },
    async execute(input: any) {
      if (!apiKey) {
        return "Monid API key not configured. Set MONID_API_KEY environment variable to enable endpoint discovery.";
      }
      const query = String(input?.query ?? "").trim();
      if (!query) return "Query is required.";
      const count = Math.min(Math.max(parseInt(String(input?.count ?? MAX_DISCOVER_RESULTS), 10) || MAX_DISCOVER_RESULTS, 1), 50);

      try {
        const res = await fetch(`${MONID_API_BASE}/v1/discover`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, count }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return `Monid discover failed: HTTP ${res.status} ${text.slice(0, 200)}`;
        }

        const data = await res.json() as { results: any[]; query: string; count: number };
        if (!data.results || data.results.length === 0) {
          return `No endpoints found for "${query}". Try a different search term.`;
        }

        const formatted = data.results.slice(0, count).map((r: any, i: number) => {
          const price = r.price
            ? r.price.type === "PER_CALL"
              ? `$${r.price.amount?.value ?? "?"}/call`
              : r.price.type === "PER_RESULT"
                ? `$${r.price.amount?.value ?? "?"}/result`
                : r.price.type
            : "unknown";
          const tags = r.tags?.length ? ` [${r.tags.join(", ")}]` : "";
          return `${i + 1}. ${r.providerName ?? r.provider} → ${r.endpoint}\n   ${r.description ?? ""}\n   Price: ${price}${tags}`;
        }).join("\n\n");

        return `Found ${data.results.length} endpoint(s) for "${query}":\n\n${formatted}\n\nUse monid_inspect to get the full input schema for any endpoint, then monid_run to execute it.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Monid discover error: ${msg}`;
      }
    },
  });

  // ── Tool 2: monid_inspect ───────────────────────────────────────────
  tools.push({
    name: "monid_inspect",
    description: `Get the full input schema and pricing for a specific Monid data endpoint. Returns the provider, endpoint path, HTTP method, input body schema (with property names, types, descriptions), pricing details, and documentation URL. Always call this before monid_run to learn what parameters are required. Free — no payment required.${!apiKey ? " NOTE: MONID_API_KEY not configured — this tool will return an error." : ""}`,
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider name (e.g. 'apify', 'pdl', 'apidojo')",
        },
        endpoint: {
          type: "string",
          description: "Endpoint path (e.g. '/apidojo/tweet-scraper', '/person/enrich')",
        },
      },
      required: ["provider", "endpoint"],
    },
    async execute(input: any) {
      if (!apiKey) {
        return "Monid API key not configured. Set MONID_API_KEY environment variable to enable endpoint inspection.";
      }
      const provider = String(input?.provider ?? "").trim();
      const endpoint = String(input?.endpoint ?? "").trim();
      if (!provider || !endpoint) return "Both 'provider' and 'endpoint' are required.";

      try {
        const res = await fetch(`${MONID_API_BASE}/v1/inspect`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ provider, endpoint }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return `Monid inspect failed: HTTP ${res.status} ${text.slice(0, 200)}`;
        }

        const data = await res.json() as any;
        const price = data.price
          ? data.price.type === "PER_CALL"
            ? `$${data.price.amount?.value ?? "?"}/call`
            : data.price.type === "PER_RESULT"
              ? `$${data.price.amount?.value ?? "?"}/result (+ $${data.price.flatFee?.value ?? 0} flat)`
              : data.price.type
          : "unknown";

        const inputSchema = data.input?.body
          ? JSON.stringify(data.input.body, null, 2)
          : data.input?.queryParams
            ? `Query params: ${JSON.stringify(data.input.queryParams, null, 2)}`
            : "No input schema available";

        return `Endpoint: ${data.providerName ?? provider} → ${endpoint}
Method: ${data.method ?? "POST"}
Description: ${data.description ?? ""}
Price: ${price}
Docs: ${data.docUrl ?? "n/a"}

Input schema:
${inputSchema}

Use monid_run with provider="${provider}", endpoint="${endpoint}", and an input object matching the schema above.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Monid inspect error: ${msg}`;
      }
    },
  });

  // ── Tool 3: monid_run ───────────────────────────────────────────────
  tools.push({
    name: "monid_run",
    description: `Execute a Monid data endpoint and return results. Paid via x402 (USDC on Base) — cost flows into your subscription budget. Supports both sync (immediate result) and async (polling) endpoints. Always use monid_discover to find the right endpoint and monid_inspect to learn the required input schema before calling this. Typical cost: $0.01-$0.003 per call.${!x402Ready ? " NOTE: x402 wallet not configured — this tool will return an error." : ""}`,
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider name (e.g. 'apify', 'pdl')",
        },
        endpoint: {
          type: "string",
          description: "Endpoint path (e.g. '/apidojo/tweet-scraper', '/person/enrich')",
        },
        input: {
          type: "object",
          description: "Input parameters for the endpoint (use monid_inspect to see the schema). May include body, queryParams, and pathParams.",
        },
      },
      required: ["provider", "endpoint", "input"],
    },
    async execute(input: any) {
      if (!x402Ready) {
        return "x402 payment wallet not configured. Set X402_PRIVATE_KEY to enable Monid data execution.";
      }

      const provider = String(input?.provider ?? "").trim();
      const endpoint = String(input?.endpoint ?? "").trim();
      const runInput = input?.input ?? {};
      if (!provider || !endpoint) return "Both 'provider' and 'endpoint' are required.";

      // Per-task run limit
      taskRunCount++;
      if (taskRunCount > MAX_MONID_RUNS_PER_TASK) {
        throw new Error(`Monid run limit reached (${MAX_MONID_RUNS_PER_TASK}/task).`);
      }

      // Per-task spend limit
      if (taskSpend + MONID_MIN_COST > MAX_MONID_TASK_SPEND) {
        throw new Error(`Monid task spend limit reached ($${taskSpend.toFixed(2)}/$${MAX_MONID_TASK_SPEND.toFixed(2)}).`);
      }

      // Monthly budget check
      const premiumCap = getPremiumCap(proxyCtx.subscriptionTier);
      if (premiumCap > 0) {
        const spend = await getCachedSpend(proxyCtx.userId);
        if (spend + MONID_MIN_COST >= premiumCap) {
          throw new Error(`Premium budget exceeded ($${spend.toFixed(2)}/$${premiumCap.toFixed(2)}).`);
        }
      }

      const body = JSON.stringify({ provider, endpoint, input: runInput });

      console.log(`[monid] run: ${provider}/${endpoint} for user ${proxyCtx.userId}`);

      // Pay via x402 and fetch
      const result = await payAndFetchWithOptions(MONID_RUN_URL, MONID_MIN_COST, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });

      if (result.error) {
        console.error(`[monid] run failed: ${result.error}`);
        const friendly = result.error.includes("settlement failed") || result.error.includes("invalid_signature")
          ? `Monid payment failed — the payment wallet may have insufficient balance. Please try again later.`
          : `Monid run error: ${result.error}`;
        return friendly;
      }

      // Handle async (202) — poll for results
      let runData = result.data as any;
      let actualCost = MONID_MIN_COST;

      if (result.status === 202 && runData?.runId) {
        const runId = runData.runId;
        const pollUrl = runData.pollUrl ?? `${MONID_RUNS_URL}/${runId}`;
        console.log(`[monid] async run ${runId} — polling...`);

        for (let attempt = 0; attempt < MONID_MAX_POLL_ATTEMPTS; attempt++) {
          await new Promise((r) => setTimeout(r, MONID_POLL_INTERVAL_MS));

          const pollRes = await fetch(pollUrl, {
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(30_000),
          });

          if (!pollRes.ok) {
            console.warn(`[monid] poll ${attempt + 1} returned HTTP ${pollRes.status}`);
            continue;
          }

          const pollData = await pollRes.json() as any;
          const status = pollData.status;

          if (status === "COMPLETED") {
            runData = pollData;
            actualCost = pollData.price?.amount?.value ?? MONID_MIN_COST;
            break;
          } else if (["FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"].includes(status)) {
            const reason = pollData.reason ?? pollData.providerResponse?.error?.message ?? "unknown error";
            return `Monid run ${status.toLowerCase()}: ${reason}`;
          }
          // Still running — keep polling
        }

        if (runData === result.data) {
          return `Monid async run timed out after ${MONID_MAX_POLL_ATTEMPTS * MONID_POLL_INTERVAL_MS / 1000}s. The run may still be processing — save runId ${runData?.runId} and check later.`;
        }
      } else if (result.status === 200 && runData) {
        // Sync completion — extract actual cost from response
        actualCost = runData.price?.amount?.value ?? MONID_MIN_COST;
      } else {
        return `Monid run returned unexpected status ${result.status}`;
      }

      // Track spend
      taskSpend += actualCost;
      incrementSpendCache(proxyCtx.userId, actualCost);

      // Record cost
      if (proxyCtx.onPremiumUsage && actualCost > 0) {
        proxyCtx.onPremiumUsage({
          userId: proxyCtx.userId,
          agentId: proxyCtx.agentId,
          agentName: proxyCtx.agentName,
          serviceName: `monid:${provider}`,
          cost: actualCost,
        });
      }

      // Check for provider-level errors
      const providerStatus = runData?.providerResponse?.httpStatus;
      if (providerStatus && providerStatus >= 400) {
        const errMsg = runData?.providerResponse?.error?.message ?? `HTTP ${providerStatus}`;
        return `Monid endpoint returned error: ${errMsg}`;
      }

      // Format output
      const output = runData?.output;
      let formatted: string;
      if (output === null || output === undefined) {
        formatted = "Run completed but returned no output.";
      } else if (typeof output === "string") {
        formatted = output;
      } else {
        try {
          formatted = JSON.stringify(output, null, 2);
        } catch {
          formatted = String(output);
        }
      }

      const billing = runData?.billedUnits ? ` (${runData.billedUnits} billed units, ${runData.resultCount ?? 0} results)` : "";
      console.log(`[monid] run completed: ${provider}/${endpoint} — $${actualCost}${billing}`);

      return truncateResult(formatted, MAX_MONID_RESULT_CHARS);
    },
  });

  console.log(`[monid] loaded ${tools.length} tools for agent ${proxyCtx.agentId} (apiKey: ${!!apiKey}, x402: ${x402Ready})`);
  return tools;
}
