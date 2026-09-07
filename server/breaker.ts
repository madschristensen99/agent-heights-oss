/**
 * Circuit Breaker — graduated escalation for runaway agents.
 *
 * Inspired by Munder Difflin's breaker.ts, adapted for Agent Heights'
 * server-side architecture (no PTY hooks, runs on the health check heartbeat).
 *
 * Escalation ladder: healthy → steering → constrained → stopped
 * One level up per tick, one level down on a healthy tick.
 */

export type BreakerLevel = "healthy" | "steering" | "constrained" | "stopped";

export interface BreakerState {
  level: BreakerLevel;
  reason: string;
  /** Consecutive identical tool call signature count. */
  repeatCount: number;
  /** Last tool call signature (tool name + truncated input). */
  lastToolSig: string | null;
  /** Consecutive API errors with no intervening progress. */
  errorStormCount: number;
  /** Timestamp of last tool call that was distinct from the previous. */
  lastProgressAt: number;
  /** Consecutive health-check ticks with no file changes detected. */
  noProgressBeats: number;
  /** Total tool calls this task. */
  totalToolCalls: number;
  /** Timestamp when the current level was set. */
  levelSetAt: number;
  /** Steering guidance to inject on next prompt. */
  steerNote: string | null;
  /** Tools to deny when constrained. */
  constrainedTools: string[] | null;
}

export interface BreakerConfig {
  enabled: boolean;
  /** Repeated identical tool calls before steering. */
  repeatedToolLimit: number;
  /** Consecutive errors before steering. */
  errorStormLimit: number;
  /** No-progress beats before steering. */
  noProgressBeats: number;
  /** Total tool calls before constraining. */
  totalToolLimit: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  enabled: true,
  repeatedToolLimit: 6,
  errorStormLimit: 4,
  noProgressBeats: 3,
  totalToolLimit: 60,
};

/** Tools that are always allowed even when constrained (read-only / exit). */
const ALLOWED_WHEN_CONSTRAINED = new Set([
  "read_files",
  "list_files",
  "read_shared",
  "list_shared",
  "read_board",
  "read_messages",
  "submit_and_exit",
]);

/** Tools to deny when constrained. */
const CONSTRAINED_TOOLS = [
  "bash",
  "write_files",
  "write_shared",
  "browse_url",
  "browser_click",
  "browser_fill",
];

export function createBreakerState(): BreakerState {
  return {
    level: "healthy",
    reason: "",
    repeatCount: 0,
    lastToolSig: null,
    errorStormCount: 0,
    lastProgressAt: Date.now(),
    noProgressBeats: 0,
    totalToolCalls: 0,
    levelSetAt: Date.now(),
    steerNote: null,
    constrainedTools: null,
  };
}

/** Polling tools exempt from repeat-counting (they legitimately repeat). */
const POLLING_TOOLS = new Set(["read_messages", "read_board", "read_events"]);

export class CircuitBreaker {
  /**
   * Record a tool call. Updates repeat tracking and progress timestamp.
   * Returns true if the tool should be denied (constrained mode + non-allowed tool).
   */
  recordToolUse(state: BreakerState, toolName: string, toolSig: string, config: BreakerConfig): boolean {
    state.totalToolCalls++;

    if (POLLING_TOOLS.has(toolName)) {
      // Polling tools don't count as repeats but do reset progress
      state.lastProgressAt = Date.now();
      state.noProgressBeats = 0;
      return this.shouldDenyTool(state, toolName);
    }

    if (toolSig === state.lastToolSig) {
      state.repeatCount++;
    } else {
      state.repeatCount = 0;
      state.lastToolSig = toolSig;
      state.lastProgressAt = Date.now();
      state.noProgressBeats = 0;
    }

    // Any non-polling tool call is progress
    state.lastProgressAt = Date.now();
    state.noProgressBeats = 0;

    return this.shouldDenyTool(state, toolName);
  }

  /** Record an API error. */
  recordError(state: BreakerState): void {
    state.errorStormCount++;
  }

  /** Record a successful event (text output, tool result). Resets error storm. */
  recordProgress(state: BreakerState): void {
    state.errorStormCount = 0;
    state.lastProgressAt = Date.now();
    state.noProgressBeats = 0;
  }

  /** Check if a tool should be denied based on current breaker level. */
  shouldDenyTool(state: BreakerState, toolName: string): boolean {
    if (state.level === "constrained" || state.level === "stopped") {
      return !ALLOWED_WHEN_CONSTRAINED.has(toolName);
    }
    return false;
  }

  /** Get the list of denied tools for the current state. */
  getDeniedTools(state: BreakerState): string[] | null {
    if (state.level === "constrained" || state.level === "stopped") {
      return [...CONSTRAINED_TOOLS];
    }
    return null;
  }

  /**
   * Evaluate breaker state and return escalation/de-escalation decisions.
   * Called once per health-check tick per working/thinking agent.
   */
  tick(state: BreakerState, config: BreakerConfig, now: number): BreakerDecision {
    if (!config.enabled) return { action: "none", steerNote: null, denyTools: null };

    const trips: string[] = [];

    // Check trip conditions
    if (state.repeatCount >= config.repeatedToolLimit) {
      trips.push(`repeated tool calls (${state.repeatCount}x)`);
    }
    if (state.errorStormCount >= config.errorStormLimit) {
      trips.push(`error storm (${state.errorStormCount} consecutive errors)`);
    }
    if (state.totalToolCalls >= config.totalToolLimit) {
      trips.push(`total tool call budget exhausted (${state.totalToolCalls})`);
    }

    // No-progress detection: if no tool calls or progress events in the last interval,
    // but the agent is still "working" — it may be stuck generating without acting.
    const staleMs = now - state.lastProgressAt;
    if (staleMs > 120_000 && state.totalToolCalls > 0) {
      state.noProgressBeats++;
      if (state.noProgressBeats >= config.noProgressBeats) {
        trips.push(`no progress for ${Math.round(staleMs / 1000)}s (${state.noProgressBeats} beats)`);
      }
    }

    // Escalate
    if (trips.length > 0) {
      const reason = trips.join("; ");
      switch (state.level) {
        case "healthy":
          return this.escalate(state, "steering", reason, now);
        case "steering":
          return this.escalate(state, "constrained", reason, now);
        case "constrained":
          return this.escalate(state, "stopped", reason, now);
        case "stopped":
          return { action: "stop", steerNote: null, denyTools: this.getDeniedTools(state) };
      }
    }

    // De-escalate on a healthy tick (no trips)
    if (state.level !== "healthy") {
      return this.deEscalate(state, now);
    }

    return { action: "none", steerNote: null, denyTools: null };
  }

  private escalate(state: BreakerState, newLevel: BreakerLevel, reason: string, now: number): BreakerDecision {
    state.level = newLevel;
    state.reason = reason;
    state.levelSetAt = now;

    // Reset the counters that triggered the escalation so we don't immediately re-trip
    state.repeatCount = 0;
    state.errorStormCount = 0;
    state.noProgressBeats = 0;

    switch (newLevel) {
      case "steering":
        state.steerNote = `⚠ Circuit breaker (steering): ${reason}. Try a different approach — avoid repeating the same tool calls. Reconsider your strategy and use different tools or inputs.`;
        return { action: "steer", steerNote: state.steerNote, denyTools: null };
      case "constrained":
        state.constrainedTools = [...CONSTRAINED_TOOLS];
        state.steerNote = `⚠ Circuit breaker (constrained): ${reason}. Write operations are now blocked. Use read_files to inspect your work, then call submit_and_exit with your findings.`;
        return { action: "constrain", steerNote: state.steerNote, denyTools: state.constrainedTools };
      case "stopped":
        state.steerNote = null;
        return { action: "stop", steerNote: null, denyTools: null };
      default:
        return { action: "none", steerNote: null, denyTools: null };
    }
  }

  private deEscalate(state: BreakerState, now: number): BreakerDecision {
    const oldLevel = state.level;
    switch (oldLevel) {
      case "steering":
        state.level = "healthy";
        state.reason = "";
        state.steerNote = null;
        state.levelSetAt = now;
        return { action: "none", steerNote: null, denyTools: null };
      case "constrained":
        state.level = "steering";
        state.reason = "Recovering from constrained — monitoring";
        state.constrainedTools = null;
        state.steerNote = null;
        state.levelSetAt = now;
        return { action: "steer", steerNote: null, denyTools: null };
      case "stopped":
        // Don't auto-de-escalate from stopped — requires manual reset
        return { action: "stop", steerNote: null, denyTools: null };
      default:
        return { action: "none", steerNote: null, denyTools: null };
    }
  }

  /** Reset breaker to healthy (e.g. on new task start). */
  reset(state: BreakerState): void {
    state.level = "healthy";
    state.reason = "";
    state.repeatCount = 0;
    state.lastToolSig = null;
    state.errorStormCount = 0;
    state.lastProgressAt = Date.now();
    state.noProgressBeats = 0;
    state.totalToolCalls = 0;
    state.levelSetAt = Date.now();
    state.steerNote = null;
    state.constrainedTools = null;
  }
}

export interface BreakerDecision {
  action: "none" | "steer" | "constrain" | "stop";
  steerNote: string | null;
  denyTools: string[] | null;
}
