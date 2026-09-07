/**
 * Shareable Hire Links — encode/decode agent configs into URL fragments.
 *
 * Encode a ShareableAgentConfig into a base64 string suitable for URL fragments.
 * Decode from URL hash or pasted text.
 */

import type { ShareableAgentConfig, AgentRole, TaskCategory } from "../../shared/types.js";
import { isValidAppearance, isValidPersonality } from "../../shared/types.js";

/** Current encoding version — bump if format changes. */
const SHARE_VERSION = 1;
/** Max encoded size before we refuse (URLs have practical limits). */
const MAX_ENCODED_SIZE = 4000;

/**
 * Encode a ShareableAgentConfig into a compact base64 string.
 * Returns the full hash fragment: #hire=<encoded>
 */
export function encodeAgentConfig(config: ShareableAgentConfig): string {
  const payload = {
    v: SHARE_VERSION,
    n: config.name,
    s: config.systemPrompt,
    r: config.role,
    a: config.appearance,
    p: config.personality,
    k: config.skills,
    m: config.mcpServerUrls?.length ? config.mcpServerUrls : undefined,
  };

  const json = JSON.stringify(payload);
  const encoded = btoa(encodeURIComponent(json));

  if (encoded.length > MAX_ENCODED_SIZE) {
    // Truncate system prompt to fit
    const overflow = encoded.length - MAX_ENCODED_SIZE;
    const trimmedPrompt = config.systemPrompt.slice(0, Math.max(100, config.systemPrompt.length - overflow * 2));
    payload.s = trimmedPrompt;
    const trimmedJson = JSON.stringify(payload);
    return `hire=${btoa(encodeURIComponent(trimmedJson))}`;
  }

  return `hire=${encoded}`;
}

/**
 * Decode a share code (either from URL hash or pasted text) into a ShareableAgentConfig.
 * Returns null if invalid or incompatible.
 */
export function decodeAgentConfig(hash: string): ShareableAgentConfig | null {
  let encoded: string;

  // Accept either "#hire=..." or just the raw encoded string
  const match = hash.match(/(?:#?hire=)?([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  encoded = match[1];

  try {
    if (encoded.length > MAX_ENCODED_SIZE * 1.5) return null;

    const json = decodeURIComponent(atob(encoded));
    const payload = JSON.parse(json);

    if (typeof payload.v !== "number" || payload.v !== SHARE_VERSION) return null;

    const config: ShareableAgentConfig = {
      name: String(payload.n ?? "").slice(0, 24),
      systemPrompt: String(payload.s ?? ""),
      role: (["worker", "manager", "devops"].includes(payload.r) ? payload.r : "worker") as AgentRole,
      appearance: isValidAppearance(payload.a) ? payload.a : { skin: 0, hairStyle: 0, hair: 0, shirt: 0, pants: 0, accessory: 0, accent: 0, beard: 0, eyeColor: 0, headFeature: 0 },
      personality: isValidPersonality(payload.p) ? payload.p : { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.3 },
      skills: Array.isArray(payload.k) ? payload.k.filter((s: string) => ["frontend", "backend", "devops", "data", "writing", "research", "crypto"].includes(s)) as TaskCategory[] : [],
      mcpServerUrls: Array.isArray(payload.m) ? payload.m.filter((u: string) => typeof u === "string").slice(0, 5) : undefined,
    };

    if (!config.name) return null;

    return config;
  } catch {
    return null;
  }
}

/**
 * Check if the current URL has a hire hash fragment.
 * Returns the decoded config or null.
 */
export function checkUrlForHireLink(): ShareableAgentConfig | null {
  const hash = window.location.hash;
  if (!hash || !hash.startsWith("#hire=")) return null;
  return decodeAgentConfig(hash.slice(1));
}

/**
 * Build a shareable URL for the current office with an agent config encoded in the hash.
 */
export function buildShareUrl(config: ShareableAgentConfig): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#${encodeAgentConfig(config)}`;
}
