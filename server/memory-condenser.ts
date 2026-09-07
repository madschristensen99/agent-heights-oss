/**
 * Memory Condenser — LLM-based conversation summarization.
 *
 * Replaces the naive truncation in cline.ts:compactMessages with a
 * lightweight LLM call that preserves semantic context (task objective,
 * key decisions, tool results, errors, progress state) while dramatically
 * reducing token count.
 *
 * Falls back to naive truncation if the LLM call fails or is disabled.
 */

import { getProviderConfig, resolveModel } from "./providers/api-config.js";

/** Max tokens for the summary LLM call response. */
const SUMMARY_MAX_TOKENS = 800;
/** Max chars of each old message to include in the summarization prompt. */
const PER_MESSAGE_CHAR_LIMIT = 500;
/** Max total chars of the summarization prompt (to avoid huge prompts). */
const MAX_PROMPT_CHARS = 50_000;

const SUMMARY_SYSTEM_PROMPT = `You are a conversation condenser for an AI agent working in a virtual office.
Summarize the following conversation history into a concise but information-dense summary.
Preserve:
- The task objective and any sub-goals
- Key decisions made and their rationale
- Tools used and their important results (file paths, error messages, key findings)
- Errors encountered and how they were resolved (or if they're still unresolved)
- Current progress state — what's done, what's in progress, what's pending
- Any important context the agent needs to continue working effectively

Format as a structured summary with sections. Be concise — omit routine steps.
Do NOT include pleasantries or meta-commentary. Just the facts the agent needs.`;

/** Extract text from a message in any format (cline internal or Anthropic). */
function extractMessageText(msg: any): string {
  const role = msg.role ?? "unknown";
  const content = msg.content;

  if (typeof content === "string") {
    return `[${role}] ${content.slice(0, PER_MESSAGE_CHAR_LIMIT)}`;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) {
        parts.push(`[${role}] ${part.text.slice(0, PER_MESSAGE_CHAR_LIMIT)}`);
      } else if (part.type === "tool-call" || part.type === "tool_use") {
        const name = part.toolName ?? part.name ?? "unknown";
        const input = JSON.stringify(part.input ?? {}).slice(0, 200);
        parts.push(`[${role}] called ${name}(${input})`);
      } else if (part.type === "tool-result" || part.type === "tool_result") {
        const out = part.output ?? part.content;
        const resultText = typeof out === "string" ? out.slice(0, 300) : "[tool result]";
        parts.push(`[${role}] tool result: ${resultText}`);
      }
    }
    return parts.join("\n");
  }

  return `[${role}] [unparseable content]`;
}

/** Naive fallback summary — the old truncation approach. */
export function naiveSummary(oldMessages: any[]): string {
  const parts: string[] = [];
  for (const msg of oldMessages) {
    parts.push(extractMessageText(msg));
  }
  return parts.join("\n");
}

/**
 * Condense old messages into a compact LLM-generated summary.
 *
 * @param oldMessages Messages to summarize (already split off from recent messages)
 * @param agentId For logging
 * @param model Model name to use for the summarization call
 * @returns Structured summary text, or naive fallback if LLM call fails
 */
export async function condenseMessages(
  oldMessages: any[],
  agentId: string,
  model?: string,
): Promise<string> {
  if (oldMessages.length === 0) return "";

  const providerConfig = getProviderConfig();
  if (!providerConfig.apiKey) {
    return naiveSummary(oldMessages);
  }

  // Build the conversation text for summarization
  const conversationText = oldMessages
    .map(extractMessageText)
    .join("\n")
    .slice(0, MAX_PROMPT_CHARS);

  const summaryModel = resolveModel(model ?? "glm-5.3-flash", providerConfig.name);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...providerConfig.headers,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: summaryModel,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: `Summarize this conversation (${oldMessages.length} messages):\n\n${conversationText}` },
        ],
        max_tokens: SUMMARY_MAX_TOKENS,
        temperature: 0.1, // Low temperature for factual summary
        stream: false,
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[condenser:${agentId}] LLM call failed: ${response.status} ${response.statusText}`);
      return naiveSummary(oldMessages);
    }

    const data = await response.json() as any;
    const summary = data?.choices?.[0]?.message?.content?.trim();

    if (!summary || summary.length === 0) {
      console.warn(`[condenser:${agentId}] LLM returned empty summary`);
      return naiveSummary(oldMessages);
    }

    console.log(`[condenser:${agentId}] condensed ${oldMessages.length} messages → ${summary.length} chars via LLM`);
    return summary;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[condenser:${agentId}] LLM call timed out, using naive fallback`);
    } else {
      console.error(`[condenser:${agentId}] LLM call error:`, err?.message ?? err);
    }
    return naiveSummary(oldMessages);
  }
}
