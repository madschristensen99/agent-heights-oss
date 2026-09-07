/**
 * Premium service proxy — wraps Circle marketplace x402-protected API services
 * as agent tools. When an agent calls a premium tool, the proxy:
 *
 *   1. Checks the user's monthly spend vs usageCap (blocks if over budget)
 *   2. Pays for the API call via Circle Gateway (USDC, zero gas)
 *   3. Records the cost to api_usage_records (flows into existing budget)
 *   4. Returns the response to the agent
 *
 * Users never hold crypto — Agent Heights pays and passes the cost through
 * to their subscription usage budget.
 */

import type { AgentTool } from "@cline/sdk";
import { payAndFetchWithOptions, isX402Configured } from "./x402-pay.js";
import { getMonthlyPremiumSpend, getPremiumCap } from "../usage.js";
import type { SubscriptionTier } from "../../shared/types.js";
import type { OnApiErrorFn } from "./mcp-client.js";

/** Maximum characters of a premium API result to pass into conversation history.
 *  ~15K chars ≈ 3.75K tokens — aggressive but prevents context overflow when
 *  agents make many premium calls in a single task run. */
const MAX_PREMIUM_RESULT_CHARS = 15_000;

/** Maximum total characters of ALL premium API results combined in a single task run.
 *  ~100K chars ≈ 25K tokens — caps cumulative context growth from tool results. */
const MAX_TOTAL_RESULT_CHARS_PER_TASK = 100_000;

/** Patterns that indicate a rate-limit error from the API. */
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate\s*limit/i,
  /secondary\s*rate\s*limit/i,
  /too\s*many\s*requests/i,
  /X-RateLimit-Remaining[:\s]*0/i,
  /API rate limit exceeded/i,
];

/** Patterns that indicate an API funding / billing / credits issue. */
const FUNDING_PATTERNS = [
  /\b402\b/,
  /payment\s*required/i,
  /insufficient\s*(credit|fund|balance)/i,
  /credit\s*balance.*(low|zero|insufficient|exhausted)/i,
  /quota\s*(exceeded|exhausted|depleted)/i,
  /billing\s*(issue|required|problem|failed)/i,
  /add\s*(payment|funding|billing)/i,
  /plan\s*(limit|upgrade|required)/i,
  /api\s*key.*(fund|credit|billing|payment)/i,
  /subscription.*(expired|inactive|required)/i,
  /out\s*of\s*credits/i,
  /no\s*credits/i,
];

/** Check if an error/result string looks like a rate-limit response. */
function isRateLimitError(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

/** Check if an error/result string looks like an API funding/billing issue. */
function isFundingError(text: string): boolean {
  return FUNDING_PATTERNS.some((p) => p.test(text));
}

/** Truncate a response string to MAX_PREMIUM_RESULT_CHARS with a truncation notice. */
function truncateResult(text: string): string {
  if (text.length <= MAX_PREMIUM_RESULT_CHARS) return text;
  return text.slice(0, MAX_PREMIUM_RESULT_CHARS) +
    `\n\n[... result truncated: ${text.length.toLocaleString()} chars total, showing first ${MAX_PREMIUM_RESULT_CHARS.toLocaleString()} ...]`;
}

/** Substitute {param} placeholders in a URL with values from the input object.
 *  Returns the substituted URL and the list of params that were consumed
 *  (so they can be excluded from query params). */
function substitutePathParams(
  url: string,
  input: Record<string, unknown>,
): { url: string; consumedKeys: Set<string> } {
  const consumedKeys = new Set<string>();
  const substituted = url.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = input[key];
    if (val !== undefined && val !== null && val !== "") {
      consumedKeys.add(key);
      return encodeURIComponent(String(val));
    }
    return match;
  });
  return { url: substituted, consumedKeys };
}

/** In-memory premium spend cache per user — prevents race conditions where
 *  concurrent calls all read the same stale DB value and overshoot the budget.
 *  Keyed by userId, value is the running spend for the current month.
 *  Initialized from DB on first access, incremented on each successful call. */
const premiumSpendCache = new Map<string, { spend: number; month: number }>();

/** Get cached premium spend, initializing from DB if needed. */
async function getCachedPremiumSpend(userId: string): Promise<number> {
  const now = new Date();
  const currentMonth = now.getMonth();
  const cached = premiumSpendCache.get(userId);

  // Cache hit for current month
  if (cached && cached.month === currentMonth) {
    return cached.spend;
  }

  // Cache miss or month changed — fetch from DB
  const dbSpend = await getMonthlyPremiumSpend(userId);
  premiumSpendCache.set(userId, { spend: dbSpend, month: currentMonth });
  return dbSpend;
}

/** Increment the in-memory spend cache after a successful premium call. */
function incrementSpendCache(userId: string, cost: number): void {
  const cached = premiumSpendCache.get(userId);
  if (cached) {
    cached.spend += cost;
  }
}

/** Maximum allowed cost per single API call (USD). */
const MAX_COST_PER_CALL = parseFloat(process.env.CIRCLE_MAX_COST_PER_CALL ?? "0.30");

/** Maximum premium API calls per task (prevents runaway spend). */
const MAX_PREMIUM_CALLS_PER_TASK = parseInt(process.env.CIRCLE_MAX_CALLS_PER_TASK ?? "20", 10);

/** Maximum total premium spend per task in USD (prevents runaway spend). */
const MAX_TASK_SPEND = parseFloat(process.env.CIRCLE_MAX_TASK_SPEND ?? "0.50");

export interface PremiumToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface CircleServiceConfig {
  /** Human-readable name for the service (e.g. "weather-api"). */
  name: string;
  /** The x402-protected API endpoint URL. */
  endpoint: string;
  /** Price per call in USD (used for budget checking + recording). */
  pricePerCall: number;
  /** Human-readable description of the service. */
  description: string;
  /** Tool definitions exposed by this service. */
  tools: PremiumToolDef[];
  /** HTTP method for this endpoint (default: GET). */
  method?: "GET" | "POST" | "PUT" | "DELETE";
}

/**
 * Context needed for budget checking and cost recording per task run.
 * Passed from the manager when loading tools.
 */
export interface PremiumProxyContext {
  userId: string;
  agentId: string;
  agentName: string;
  subscriptionTier: SubscriptionTier | null;
  /** Called to record the cost of a premium API call. */
  onPremiumUsage?: (params: {
    userId: string;
    agentId: string;
    agentName: string;
    serviceName: string;
    cost: number;
    task?: string;
  }) => void;
  /** Called when a premium API encounters a rate-limit or funding error. */
  onApiError?: OnApiErrorFn;
}

/**
 * Load premium service tools for an agent.
 * Each tool checks the user's budget before making a paid API call.
 */
export async function loadPremiumTools(
  services: CircleServiceConfig[],
  proxyCtx: PremiumProxyContext,
): Promise<AgentTool<any, any>[]> {
  const gatewayConfigured = isX402Configured();
  if (!gatewayConfigured) {
    console.warn("[premium-proxy] Circle Gateway not configured — premium tools will be registered but calls will fail with funding error");
  }

  const allTools: AgentTool<any, any>[] = [];
  let taskCallCount = 0;
  let taskSpend = 0;
  let taskResultChars = 0;

  for (const service of services) {
    for (const def of service.tools) {
      // Prefix tool name with service name to avoid collisions
      const toolName = `${service.name}__${def.name}`;

      allTools.push({
        name: toolName,
        description: `[Premium: $${service.pricePerCall}/call] ${def.description}`,
        inputSchema: def.inputSchema ?? { type: "object", properties: {} },
        async execute(input: any) {
          // If gateway isn't configured, return a clear error so the agent
          // knows the issue is funding, not that the tool is missing
          if (!gatewayConfigured) {
            return `Payment wallet not configured. Premium API calls require funding.`;
          }

          // Per-task call limit
          taskCallCount++;
          if (taskCallCount > MAX_PREMIUM_CALLS_PER_TASK) {
            throw new Error(`Premium call limit reached (${MAX_PREMIUM_CALLS_PER_TASK}/task).`);
          }

          // Per-task total spend limit
          if (taskSpend + service.pricePerCall > MAX_TASK_SPEND) {
            throw new Error(`Premium task spend limit reached ($${taskSpend.toFixed(2)}/$${MAX_TASK_SPEND.toFixed(2)}).`);
          }

          // Per-call cost ceiling
          if (service.pricePerCall > MAX_COST_PER_CALL) {
            throw new Error(`Service cost $${service.pricePerCall} exceeds limit $${MAX_COST_PER_CALL}.`);
          }

          // Budget check — compare monthly premium spend vs premium cap (separate from LLM budget)
          const premiumCap = getPremiumCap(proxyCtx.subscriptionTier);
          if (premiumCap > 0) {
            const spend = await getCachedPremiumSpend(proxyCtx.userId);
            if (spend + service.pricePerCall >= premiumCap) {
              throw new Error(`Premium budget exceeded ($${spend.toFixed(2)}/$${premiumCap.toFixed(2)}).`);
            }
          }

          const httpMethod = service.method ?? "GET";
          let url = service.endpoint;
          const inputObj = input ?? {};
          let payOptions: { method?: string; body?: unknown; headers?: Record<string, string> } = {};

          // Fix A: Substitute path parameters ({id}, {contract_address}, etc.) from input
          const { url: substitutedUrl, consumedKeys } = substitutePathParams(url, inputObj);
          url = substitutedUrl;

          // Check for unresolved path params — agent forgot to provide a required value
          const unresolvedParams = [...url.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
          if (unresolvedParams.length > 0) {
            const missing = unresolvedParams.join(", ");
            return `Missing required path parameter(s): ${missing}. Provide ${unresolvedParams.length === 1 ? "it" : "them"} as input to this tool. The endpoint URL is ${service.endpoint} — the placeholder(s) {${missing}} must be filled with actual values.`;
          }

          if (httpMethod === "GET") {
            // For GET, append remaining input (excluding consumed path params) as query params
            const queryParams = Object.entries(inputObj)
              .filter(([k, v]) => !consumedKeys.has(k) && v !== undefined && v !== null && v !== "")
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
              .join("&");
            if (queryParams) {
              url += (url.includes("?") ? "&" : "?") + queryParams;
            }
          } else {
            // For POST/PUT, send input as JSON body (path params already in URL)
            payOptions = { method: httpMethod, body: inputObj, headers: { "Content-Type": "application/json" } };
          }

          console.log(`[premium-proxy] calling ${service.name}.${def.name} ($${service.pricePerCall}/call, ${httpMethod}) for user ${proxyCtx.userId}`);

          // Pay and fetch
          const result = await payAndFetchWithOptions(url, service.pricePerCall, payOptions);

          if (result.error) {
            console.error(`[premium-proxy] ${service.name}.${def.name} failed: ${result.error}`);

            // Fix E: Rate limit detection
            if (isRateLimitError(result.error)) {
              proxyCtx.onApiError?.("rate_limit", { serverLabel: service.name, toolName: def.name, message: result.error.slice(0, 500) });
              return `[RATE LIMITED] ${result.error}\n\n⚠️ This API is rate-limited. Do NOT retry any API calls for at least 10 minutes. Wait for the cooldown to expire before making another request.`;
            }

            // Fix E2: Funding/billing error detection
            if (isFundingError(result.error)) {
              proxyCtx.onApiError?.("funding", { serverLabel: service.name, toolName: def.name, message: result.error.slice(0, 500) });
              return `[FUNDING ISSUE] ${result.error}\n\n⚠️ This API has a billing or funding problem. Do NOT retry this API call until the funding issue is resolved.`;
            }

            const friendlyError = result.error.includes("settlement failed") || result.error.includes("invalid_signature")
              ? `Premium API payment failed — the payment wallet may have insufficient Gateway balance. Please try again later.`
              : `API error: ${result.error}`;
            return friendlyError;
          }

          if (result.status !== 200 && result.status !== 202) {
            console.error(`[premium-proxy] ${service.name}.${def.name} returned status ${result.status}`);
            const statusMsg = `API returned HTTP ${result.status}`;

            // Fix E: Rate limit detection on non-200 status
            if (result.status === 429 || isRateLimitError(statusMsg)) {
              proxyCtx.onApiError?.("rate_limit", { serverLabel: service.name, toolName: def.name, message: statusMsg });
              return `[RATE LIMITED] ${statusMsg}\n\n⚠️ This API is rate-limited. Do NOT retry any API calls for at least 10 minutes.`;
            }

            // Fix E2: Funding detection on non-200 status
            if (result.status === 402 || isFundingError(statusMsg)) {
              proxyCtx.onApiError?.("funding", { serverLabel: service.name, toolName: def.name, message: statusMsg });
              return `[FUNDING ISSUE] ${statusMsg}\n\n⚠️ This API has a billing or funding problem. Do NOT retry this API call until the funding issue is resolved.`;
            }

            return statusMsg;
          }

          // Increment per-task spend tracker and in-memory spend cache immediately
          if (result.cost > 0) {
            taskSpend += result.cost;
            incrementSpendCache(proxyCtx.userId, result.cost);
          }

          // Record the cost to api_usage_records via the callback
          if (proxyCtx.onPremiumUsage && result.cost > 0) {
            proxyCtx.onPremiumUsage({
              userId: proxyCtx.userId,
              agentId: proxyCtx.agentId,
              agentName: proxyCtx.agentName,
              serviceName: service.name,
              cost: result.cost,
            });
          }

          // Fix C: Format the response for the agent, truncating oversized results
          let responseText: string;
          if (typeof result.data === "string") {
            responseText = result.data;
          } else {
            try {
              responseText = JSON.stringify(result.data, null, 2);
            } catch {
              responseText = String(result.data);
            }
          }

          // Fix E: Check response body for rate-limit / funding errors even on HTTP 200
          if (isRateLimitError(responseText)) {
            proxyCtx.onApiError?.("rate_limit", { serverLabel: service.name, toolName: def.name, message: responseText.slice(0, 500) });
            return `[RATE LIMITED] ${truncateResult(responseText)}\n\n⚠️ This API is rate-limited. Do NOT retry any API calls for at least 10 minutes.`;
          }
          if (isFundingError(responseText)) {
            proxyCtx.onApiError?.("funding", { serverLabel: service.name, toolName: def.name, message: responseText.slice(0, 500) });
            return `[FUNDING ISSUE] ${truncateResult(responseText)}\n\n⚠️ This API has a billing or funding problem. Do NOT retry this API call until the funding issue is resolved.`;
          }

          // Fix 4: Per-task cumulative result budget
          taskResultChars += responseText.length;
          if (taskResultChars > MAX_TOTAL_RESULT_CHARS_PER_TASK) {
            const budgetMsg = `[RESULT BUDGET EXCEEDED] This task has already retrieved ${taskResultChars.toLocaleString()} chars of API data (limit: ${MAX_TOTAL_RESULT_CHARS_PER_TASK.toLocaleString()}). Summarize what you have so far and call submit_and_exit with your findings. Do NOT make any more API calls.`;
            console.warn(`[premium-proxy] result budget exceeded for ${proxyCtx.agentId}: ${taskResultChars} chars`);
            return truncateResult(responseText) + `\n\n${budgetMsg}`;
          }

          return truncateResult(responseText);
        },
      });
    }
  }

  console.log(`[premium-proxy] loaded ${allTools.length} premium tools from ${services.length} service(s) for agent ${proxyCtx.agentId}`);
  return allTools;
}
