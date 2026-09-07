/**
 * FIPA-lite Inter-Agent Messaging
 *
 * Replaces the flat post_message tool with structured performatives
 * inspired by FIPA ACL (Agent Communication Language).
 *
 * Performatives:
 * - request: Ask another agent to do something (creates a task)
 * - inform: Share information (inbox only, no task created)
 * - query: Ask a question (creates task only if recipient is idle)
 * - propose: Suggest an approach (creates task only if recipient is idle)
 * - subscribe: Request to be notified when a task completes
 *
 * Priority levels control throttle bypass and delivery ordering.
 */

export type Performative = "request" | "inform" | "query" | "propose" | "subscribe";
export type MessagePriority = "low" | "normal" | "urgent";

export interface AgentMessage {
  ts: number;
  from: string;
  to: string;
  performative: Performative;
  content: string;
  priority: MessagePriority;
  /** Optional subject line for quick scanning. */
  subject?: string;
  /** For subscribe: the task/card ID to watch. */
  refId?: string;
}

export const PERFORMATIVE_DESCRIPTIONS: Record<Performative, string> = {
  request: "Ask another agent to perform a task. The recipient will be assigned a task if they're available.",
  inform: "Share information with a colleague. Goes to their inbox only — no task is created. Use for FYIs, status updates, context sharing.",
  query: "Ask a colleague a question. Creates a task for them only if they're idle. Use when you need information but it's not urgent.",
  propose: "Suggest an approach or idea to a colleague. Creates a task only if they're idle. Use for collaboration suggestions.",
  subscribe: "Request to be notified when a colleague finishes their current task. No task is created — you'll get a reply when they're done.",
};

export const PERFORMATIVE_ICONS: Record<Performative, string> = {
  request: "→",
  inform: "ℹ",
  query: "?",
  propose: "💡",
  subscribe: "🔔",
};

/**
 * Format a structured message for display in the agent's inbox readout.
 * Returns a human-readable string the LLM can understand.
 */
export function formatMessage(m: AgentMessage): string {
  const time = new Date(m.ts).toISOString();
  const icon = PERFORMATIVE_ICONS[m.performative] ?? "•";
  const priorityTag = m.priority === "urgent" ? " [URGENT]" : m.priority === "low" ? " [low]" : "";
  const subject = m.subject ? ` ${m.subject}:` : "";
  return `[${time}] ${icon} From ${m.from}${priorityTag}${subject} ${m.content}`;
}

/**
 * Create a JSONL line for an AgentMessage.
 */
export function messageToLine(m: AgentMessage): string {
  return JSON.stringify(m) + "\n";
}

/**
 * Parse a JSONL line back into an AgentMessage, with backward compat
 * for old-format messages (flat { ts, from, message }).
 */
export function parseMessageLine(line: string): AgentMessage | null {
  try {
    const parsed = JSON.parse(line);
    // Backward compat: old format had { ts, from, message }
    if (parsed.message && !parsed.performative) {
      return {
        ts: parsed.ts,
        from: parsed.from,
        to: "",
        performative: "inform",
        content: parsed.message,
        priority: "normal",
      };
    }
    return parsed as AgentMessage;
  } catch {
    return null;
  }
}

/**
 * Determine whether a performative should create a task for the recipient,
 * given their current status.
 */
export function shouldCreateTask(
  performative: Performative,
  recipientStatus: string,
  priority: MessagePriority,
): boolean {
  // Urgent requests always create tasks
  if (priority === "urgent" && (performative === "request" || performative === "query")) {
    return true;
  }

  switch (performative) {
    case "request":
      return true; // Always create a task for requests
    case "query":
    case "propose":
      // Only create a task if the recipient is idle (not already busy)
      return recipientStatus === "idle" || recipientStatus === "done";
    case "inform":
    case "subscribe":
      return false; // Never create tasks for informs or subscriptions
    default:
      return false;
  }
}

/**
 * Whether this message should bypass the throttle.
 */
export function bypassesThrottle(priority: MessagePriority): boolean {
  return priority === "urgent";
}
