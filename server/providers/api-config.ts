/**
 * Shared API provider configuration.
 *
 * Primary LLM provider: Pareto Inference (PARETO_INFERENCE_KEY).
 * Fallback LLM provider: DeepSeek (DEEPSEEK_KEY).
 * Vision provider: Kimi (KIMI_KEY) — used for image understanding tasks
 * like browser screenshots, since GLM/DeepSeek models do not support vision.
 * All expose OpenAI-compatible /chat/completions endpoints.
 */

export type ProviderName = "zai" | "deepseek" | "kimi";

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  /** Extra headers to send with every request (e.g. auth header). */
  headers: Record<string, string>;
  /** Default model for this provider. */
  defaultModel: string;
}

const PARETO_BASE_URL = "https://api.paretoinference.com/v1";
const PARETO_API_KEY = process.env.PARETO_INFERENCE_KEY ?? "";
const PARETO_DEFAULT_MODEL = "glm-5.3-flash";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_KEY ?? "";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

const KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const KIMI_API_KEY = process.env.KIMI_KEY ?? "";
const KIMI_DEFAULT_MODEL = "kimi-k2.6";

/** Aliases that map legacy model names to the Pareto default model. */
const MODEL_TO_PARETO: Record<string, string> = {
  "openrouter/tencent/hy3:free": PARETO_DEFAULT_MODEL,
  // Legacy Kimi defaults → Pareto
  "kimi-k2.5": PARETO_DEFAULT_MODEL,
  "kimi-k2.6": PARETO_DEFAULT_MODEL,
  // Legacy DeepSeek defaults → Pareto
  "deepseek-v4-flash": "deepseek-v4-flash",
};

// ── Circuit breaker for Pareto ────────────────────────────────────────────
// When Pareto returns auth/billing errors, we switch to DeepSeek fallback.
// The breaker auto-resets after 5 minutes to retry Pareto.
let paretoFailedAt = 0;
const PARETO_FAILURE_COOLDOWN_MS = 5 * 60_000;

/** Mark Pareto as failed (e.g. auth error). Subsequent getProviderConfig() calls
 *  will return DeepSeek until the cooldown expires. */
export function markParetoFailed(): void {
  paretoFailedAt = Date.now();
  console.log("[api-config] Pareto marked as failed — switching to DeepSeek fallback for 5 minutes");
}

/** Reset the Pareto failure flag (e.g. after a successful call). */
export function resetParetoFailure(): void {
  paretoFailedAt = 0;
}

function isParetoInCooldown(): boolean {
  if (paretoFailedAt === 0) return false;
  if (Date.now() - paretoFailedAt > PARETO_FAILURE_COOLDOWN_MS) {
    paretoFailedAt = 0;
    console.log("[api-config] Pareto cooldown expired — retrying Pareto");
    return false;
  }
  return true;
}

/**
 * Get the active primary provider configuration.
 * Priority: Pareto > DeepSeek > Kimi.
 * If Pareto is in failure cooldown, falls back to DeepSeek.
 */
function paretoConfig(): ProviderConfig {
  return {
    name: "zai",
    baseUrl: PARETO_BASE_URL,
    apiKey: PARETO_API_KEY,
    headers: { Authorization: `Bearer ${PARETO_API_KEY}` },
    defaultModel: PARETO_DEFAULT_MODEL,
  };
}

function deepseekConfig(): ProviderConfig {
  return {
    name: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL,
    apiKey: DEEPSEEK_API_KEY,
    headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
  };
}

function kimiConfig(): ProviderConfig {
  return {
    name: "kimi",
    baseUrl: KIMI_BASE_URL,
    apiKey: KIMI_API_KEY,
    headers: { Authorization: `Bearer ${KIMI_API_KEY}` },
    defaultModel: KIMI_DEFAULT_MODEL,
  };
}

export function getProviderConfig(): ProviderConfig {
  if (PARETO_API_KEY && !isParetoInCooldown()) {
    return paretoConfig();
  }
  if (DEEPSEEK_API_KEY) {
    return deepseekConfig();
  }
  if (KIMI_API_KEY) {
    return kimiConfig();
  }
  // Last resort: return Pareto even if in cooldown (better than nothing)
  if (PARETO_API_KEY) {
    return paretoConfig();
  }
  return deepseekConfig();
}

/** Get a fallback provider config, skipping the given provider name.
 *  Used for retrying with a different provider when one fails with auth errors.
 *  Returns null if no alternative provider is available. */
export function getFallbackProviderConfig(skipName: ProviderName): ProviderConfig | null {
  const providers: ProviderConfig[] = [];
  if (skipName !== "zai" && PARETO_API_KEY && !isParetoInCooldown()) providers.push(paretoConfig());
  if (skipName !== "deepseek" && DEEPSEEK_API_KEY) providers.push(deepseekConfig());
  if (skipName !== "kimi" && KIMI_API_KEY) providers.push(kimiConfig());
  return providers[0] ?? null;
}

/**
 * Get the vision provider configuration (Kimi).
 * Used when the primary model doesn't support image input.
 */
export function getVisionProviderConfig(): ProviderConfig {
  return {
    name: "kimi",
    baseUrl: KIMI_BASE_URL,
    apiKey: KIMI_API_KEY,
    headers: { Authorization: `Bearer ${KIMI_API_KEY}` },
    defaultModel: KIMI_DEFAULT_MODEL,
  };
}

/**
 * Resolve the model id for the active provider.
 * Maps known model names to Pareto equivalents.
 */
/** Map model names to the appropriate model for each provider. */
const MODEL_TO_DEEPSEEK: Record<string, string> = {
  "glm-5.3-flash": "deepseek-v4-flash",
  "glm-5.3": "deepseek-v4-pro",
  "z-ai/glm-5.3-flash": "deepseek-v4-flash",
  "z-ai/glm-5.3": "deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "deepseek-v4-flash",
};

const MODEL_TO_KIMI: Record<string, string> = {
  "glm-5.3-flash": "kimi-k2.7-code",
  "glm-5.3": "kimi-k2.6",
  "z-ai/glm-5.3-flash": "kimi-k2.7-code",
  "z-ai/glm-5.3": "kimi-k2.6",
  "deepseek/deepseek-v4-flash": "kimi-k2.7-code",
  "deepseek-v4-flash": "kimi-k2.7-code",
};

export function resolveModel(model: string, provider: ProviderName): string {
  if (provider === "deepseek") return MODEL_TO_DEEPSEEK[model] ?? MODEL_TO_PARETO[model] ?? model;
  if (provider === "kimi") return MODEL_TO_KIMI[model] ?? MODEL_TO_PARETO[model] ?? model;
  return MODEL_TO_PARETO[model] ?? model;
}

/**
 * Check whether any API key is configured.
 */
export function hasApiKey(): boolean {
  return !!PARETO_API_KEY || !!DEEPSEEK_API_KEY || !!KIMI_API_KEY;
}

/**
 * Check whether the vision (Kimi) provider is available.
 */
export function hasVisionApiKey(): boolean {
  return !!KIMI_API_KEY;
}

/**
 * Models known to support vision (image understanding).
 * DeepSeek V4 Flash does NOT support vision — only Kimi models do.
 */
const VISION_CAPABLE_MODELS = new Set([
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k3",
]);

/**
 * Check if a model supports vision (image input).
 */
export function isVisionCapable(model: string): boolean {
  return VISION_CAPABLE_MODELS.has(model);
}

/**
 * If the current model doesn't support vision, route to a Kimi vision model.
 * Returns the model name to use for vision-capable tasks (e.g. browser
 * screenshots). If the current model is already vision-capable, returns it
 * as-is.
 */
export function resolveVisionModel(model: string, _provider: ProviderName): string {
  if (isVisionCapable(model)) return model;
  // DeepSeek V4 Flash doesn't support vision — fall back to Kimi
  return KIMI_DEFAULT_MODEL;
}

// ── Hermes gateway model resolution ───────────────────────────────────────

export interface HermesModelConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Resolve which LLM provider/model/key the Hermes gateway should use.
 *
 * Priority:
 * 1. Explicit HERMES_MODEL_PROVIDER + HERMES_MODEL_NAME overrides (if set AND
 *    a matching key exists)
 * 2. Pareto Inference (if PARETO_INFERENCE_KEY is non-empty)
 * 3. DeepSeek (if DEEPSEEK_KEY is non-empty)
 * 4. Kimi (if KIMI_KEY or KIMI_API_KEY is non-empty)
 * 5. null — no key configured
 *
 * Uses || (not ??) so empty-string env vars trigger fallback.
 */
export function resolveHermesModelConfig(): HermesModelConfig | null {
  const paretoKey = process.env.PARETO_INFERENCE_KEY || "";
  const deepseekKey = process.env.DEEPSEEK_KEY || "";
  const kimiKey = process.env.KIMI_KEY || process.env.KIMI_API_KEY || "";
  const explicitProvider = process.env.HERMES_MODEL_PROVIDER || "";
  const explicitModel = process.env.HERMES_MODEL_NAME || "";

  // If an explicit provider is set, use it with the matching key
  if (explicitProvider) {
    if (explicitProvider === "pareto" && paretoKey) {
      // Use Hermes's native "z-ai" provider (with hyphen) which maps to
      // Pareto's API via GLM_API_KEY and GLM_BASE_URL. The Hermes API lists
      // models as z-ai/glm-5.3-flash — using "zai" (no hyphen) causes the
      // gateway to fail provider matching and fall back to deepseek.
      return {
        provider: "z-ai",
        model: explicitModel || PARETO_DEFAULT_MODEL,
        apiKey: paretoKey,
        baseUrl: "https://api.paretoinference.com/v1",
      };
    }
    if (explicitProvider === "deepseek" && deepseekKey) {
      return {
        provider: "deepseek",
        model: explicitModel || DEEPSEEK_DEFAULT_MODEL,
        apiKey: deepseekKey,
        baseUrl: "https://api.deepseek.com",
      };
    }
    if ((explicitProvider === "kimi" || explicitProvider === "kimi-coding") && kimiKey) {
      return {
        provider: explicitProvider,
        model: explicitModel || "kimi-k2.7-code",
        apiKey: kimiKey,
        baseUrl: "https://api.moonshot.ai/v1",
      };
    }
    // Explicit provider set but no matching key — fall through to auto-detect
  }

  // Auto-detect: Pareto first, then DeepSeek, then Kimi
  // Use Hermes's native "z-ai" provider (with hyphen) which uses GLM_API_KEY
  // + GLM_BASE_URL to talk to Pareto's OpenAI-compatible API. The hyphen is
  // required — the Hermes API lists models as z-ai/glm-5.3-flash.
  if (paretoKey) {
    return {
      provider: "z-ai",
      model: PARETO_DEFAULT_MODEL,
      apiKey: paretoKey,
      baseUrl: "https://api.paretoinference.com/v1",
    };
  }
  if (deepseekKey) {
    return {
      provider: "deepseek",
      model: DEEPSEEK_DEFAULT_MODEL,
      apiKey: deepseekKey,
      baseUrl: "https://api.deepseek.com",
    };
  }
  if (kimiKey) {
    return {
      provider: "kimi",
      model: "kimi-k2.7-code",
      apiKey: kimiKey,
      baseUrl: "https://api.moonshot.ai/v1",
    };
  }
  return null;
}
