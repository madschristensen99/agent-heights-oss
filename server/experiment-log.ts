/**
 * Experiment Log — tracks agent config changes, MCP installs, model swaps,
 * and hiring/firing events as structured experiment entries.
 *
 * Entries are created automatically when detectable events occur and can be
 * annotated by the user with hypotheses, verdicts, and notes.
 */

import { randomUUID } from "crypto";
import type { ExperimentEntry, AgentInfo } from "../shared/types.js";
import { supabaseAdmin, isSupabaseConfigured } from "./supabase.js";

/** Per-user experiment log, keyed by userId. */
const logs = new Map<string, ExperimentEntry[]>();
const loadedUsers = new Set<string>();

/** Per-user per-agent snapshot of last-known config, for diffing. */
interface AgentSnapshot {
  model: string;
  systemPrompt: string;
  mcpServers: string[];
  tasksDone: number;
}
const snapshots = new Map<string, Map<string, AgentSnapshot>>();

function getLog(userId: string): ExperimentEntry[] {
  let log = logs.get(userId);
  if (!log) {
    log = [];
    logs.set(userId, log);
  }
  // Load from DB if not yet loaded
  if (!loadedUsers.has(userId)) {
    loadedUsers.add(userId);
    if (isSupabaseConfigured) {
      void supabaseAdmin
        .from("heights_cloud_experiment_logs")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100)
        .then(({ data }) => {
          if (data) {
            const entries = data.map((r) => ({
              id: r.id,
              timestamp: new Date(r.created_at).getTime(),
              userId: r.user_id,
              type: r.type,
              agentId: r.agent_id,
              agentName: r.agent_name,
              hypothesis: r.hypothesis,
              setup: r.setup,
              result: r.result,
              verdict: r.verdict,
              notes: r.notes,
            } as ExperimentEntry));
            log!.unshift(...entries);
          }
        })
        .catch((err: unknown) => console.warn(`[experiment-log] failed to load for ${userId}:`, err));
    }
  }
  return log;
}

function persistEntry(userId: string, entry: ExperimentEntry): void {
  if (!isSupabaseConfigured) return;
  void supabaseAdmin
    .from("heights_cloud_experiment_logs")
    .insert({
      id: entry.id,
      user_id: userId,
      type: entry.type,
      agent_id: entry.agentId,
      agent_name: entry.agentName,
      hypothesis: entry.hypothesis,
      setup: JSON.stringify(entry.setup),
      result: JSON.stringify(entry.result),
      verdict: entry.verdict,
      notes: entry.notes,
    })
    .then(() => {})
    .catch((err: unknown) => console.warn(`[experiment-log] failed to persist entry ${entry.id}:`, err));
}

function getSnapshots(userId: string): Map<string, AgentSnapshot> {
  let snaps = snapshots.get(userId);
  if (!snaps) {
    snaps = new Map();
    snapshots.set(userId, snaps);
  }
  return snaps;
}

/** Record an agent hire event. */
export function logAgentHire(
  userId: string,
  agent: AgentInfo,
): ExperimentEntry {
  const entry: ExperimentEntry = {
    id: randomUUID().slice(0, 8),
    timestamp: Date.now(),
    userId,
    type: "agent_hire",
    agentId: agent.id,
    agentName: agent.name,
    hypothesis: `Will ${agent.name} (${agent.model}) be effective at assigned tasks?`,
    setup: {
      before: "(no agent)",
      after: `model: ${agent.model}, prompt: ${agent.systemPrompt?.slice(0, 100) ?? "(default)"}`,
    },
    result: { successRate: null, avgTime: null, tasksCompleted: null },
    verdict: "pending",
    notes: "",
  };

  const log = getLog(userId);
  log.unshift(entry);
  if (log.length > 100) log.length = 100;
  persistEntry(userId, entry);

  // Snapshot the new agent's config
  const snaps = getSnapshots(userId);
  snaps.set(agent.id, {
    model: agent.model,
    systemPrompt: agent.systemPrompt ?? "",
    mcpServers: (agent as unknown as { mcpServers?: string[] }).mcpServers ?? [],
    tasksDone: agent.tasksDone,
  });

  return entry;
}

/** Record an agent fire event. */
export function logAgentFire(
  userId: string,
  agent: AgentInfo,
): ExperimentEntry {
  const snaps = getSnapshots(userId);
  const prev = snaps.get(agent.id);

  const entry: ExperimentEntry = {
    id: randomUUID().slice(0, 8),
    timestamp: Date.now(),
    userId,
    type: "agent_fire",
    agentId: agent.id,
    agentName: agent.name,
    hypothesis: prev
      ? `Was ${agent.name} (${prev.model}) worth keeping? Completed ${agent.tasksDone} tasks.`
      : `Was ${agent.name} worth keeping?`,
    setup: {
      before: prev
        ? `model: ${prev.model}, tasks: ${agent.tasksDone}`
        : "active agent",
      after: "(fired — walked out the door)",
    },
    result: {
      successRate: null,
      avgTime: null,
      tasksCompleted: agent.tasksDone,
    },
    verdict: "inconclusive",
    notes: "",
  };

  const log = getLog(userId);
  log.unshift(entry);
  if (log.length > 100) log.length = 100;
  persistEntry(userId, entry);

  snaps.delete(agent.id);

  return entry;
}

/** Record an agent recruit (re-hire from fired) event. */
export function logAgentRecruit(
  userId: string,
  agent: AgentInfo,
): ExperimentEntry {
  const entry: ExperimentEntry = {
    id: randomUUID().slice(0, 8),
    timestamp: Date.now(),
    userId,
    type: "agent_hire",
    agentId: agent.id,
    agentName: agent.name,
    hypothesis: `Will re-hiring ${agent.name} (${agent.model}) with previous experience (${agent.tasksDone} tasks done) outperform a fresh hire?`,
    setup: {
      before: "(fired — was in the Labyrinth)",
      after: `model: ${agent.model}, tasks done: ${agent.tasksDone}, prompt: ${agent.systemPrompt?.slice(0, 100) ?? "(default)"}`,
    },
    result: { successRate: null, avgTime: null, tasksCompleted: agent.tasksDone },
    verdict: "pending",
    notes: "",
  };

  const log = getLog(userId);
  log.unshift(entry);
  if (log.length > 100) log.length = 100;
  persistEntry(userId, entry);

  // Snapshot the rehired agent's config
  const snaps = getSnapshots(userId);
  snaps.set(agent.id, {
    model: agent.model,
    systemPrompt: agent.systemPrompt ?? "",
    mcpServers: (agent as unknown as { mcpServers?: string[] }).mcpServers ?? [],
    tasksDone: agent.tasksDone,
  });

  return entry;
}
export function detectConfigChange(
  userId: string,
  agent: AgentInfo,
): ExperimentEntry | null {
  const snaps = getSnapshots(userId);
  const prev = snaps.get(agent.id);

  // Update snapshot
  const current: AgentSnapshot = {
    model: agent.model,
    systemPrompt: agent.systemPrompt ?? "",
    mcpServers: (agent as unknown as { mcpServers?: string[] }).mcpServers ?? [],
    tasksDone: agent.tasksDone,
  };

  if (!prev) {
    snaps.set(agent.id, current);
    return null;
  }

  // Check for model swap
  if (prev.model !== current.model) {
    const entry: ExperimentEntry = {
      id: randomUUID().slice(0, 8),
      timestamp: Date.now(),
      userId,
      type: "model_swap",
      agentId: agent.id,
      agentName: agent.name,
      hypothesis: `Will ${current.model} perform better than ${prev.model} on ${agent.name}'s tasks?`,
      setup: {
        before: `model: ${prev.model}`,
        after: `model: ${current.model}`,
      },
      result: { successRate: null, avgTime: null, tasksCompleted: null },
      verdict: "pending",
      notes: "",
    };

    const log = getLog(userId);
    log.unshift(entry);
    if (log.length > 100) log.length = 100;
    persistEntry(userId, entry);

    snaps.set(agent.id, current);
    return entry;
  }

  // Check for system prompt change
  if (prev.systemPrompt !== current.systemPrompt) {
    const entry: ExperimentEntry = {
      id: randomUUID().slice(0, 8),
      timestamp: Date.now(),
      userId,
      type: "config_change",
      agentId: agent.id,
      agentName: agent.name,
      hypothesis: `Will the new system prompt improve ${agent.name}'s performance?`,
      setup: {
        before: `prompt: ${prev.systemPrompt.slice(0, 80)}...`,
        after: `prompt: ${current.systemPrompt.slice(0, 80)}...`,
      },
      result: { successRate: null, avgTime: null, tasksCompleted: null },
      verdict: "pending",
      notes: "",
    };

    const log = getLog(userId);
    log.unshift(entry);
    if (log.length > 100) log.length = 100;
    persistEntry(userId, entry);

    snaps.set(agent.id, current);
    return entry;
  }

  // Check for MCP server changes
  const prevMcp = new Set(prev.mcpServers);
  const currMcp = new Set(current.mcpServers);
  const added = [...currMcp].filter((s) => !prevMcp.has(s));
  if (added.length > 0) {
    const entry: ExperimentEntry = {
      id: randomUUID().slice(0, 8),
      timestamp: Date.now(),
      userId,
      type: "mcp_install",
      agentId: agent.id,
      agentName: agent.name,
      hypothesis: `Will adding ${added.join(", ")} to ${agent.name} unlock better task outcomes?`,
      setup: {
        before: `MCP: ${prev.mcpServers.join(", ") || "(none)"}`,
        after: `MCP: ${current.mcpServers.join(", ")}`,
      },
      result: { successRate: null, avgTime: null, tasksCompleted: null },
      verdict: "pending",
      notes: "",
    };

    const log = getLog(userId);
    log.unshift(entry);
    if (log.length > 100) log.length = 100;
    persistEntry(userId, entry);
  }

  snaps.set(agent.id, current);
  return null;
}

/** Get all experiment entries for a user. */
export function getEntries(userId: string): ExperimentEntry[] {
  return getLog(userId);
}

/** Update an experiment entry (hypothesis, verdict, notes). */
export function updateEntry(
  userId: string,
  entryId: string,
  updates: { hypothesis?: string; verdict?: string; notes?: string },
): ExperimentEntry | null {
  const log = getLog(userId);
  const entry = log.find((e) => e.id === entryId);
  if (!entry) return null;
  if (updates.hypothesis !== undefined) entry.hypothesis = updates.hypothesis;
  if (updates.verdict !== undefined) entry.verdict = updates.verdict as ExperimentEntry["verdict"];
  if (updates.notes !== undefined) entry.notes = updates.notes;
  // Persist update to DB
  if (isSupabaseConfigured) {
    void supabaseAdmin
      .from("heights_cloud_experiment_logs")
      .update({
        hypothesis: entry.hypothesis,
        verdict: entry.verdict,
        notes: entry.notes,
      })
      .eq("id", entryId)
      .eq("user_id", userId)
      .then(() => {})
      .catch((err: unknown) => console.warn(`[experiment-log] failed to update entry ${entryId}:`, err));
  }
  return entry;
}

/** Clear the log for a user (on session end / logout). */
export function clearLog(userId: string): void {
  logs.delete(userId);
  loadedUsers.delete(userId);
  snapshots.delete(userId);
  // Delete from DB
  if (isSupabaseConfigured) {
    void supabaseAdmin
      .from("heights_cloud_experiment_logs")
      .delete()
      .eq("user_id", userId)
      .then(() => {})
      .catch((err: unknown) => console.warn(`[experiment-log] failed to clear for ${userId}:`, err));
  }
}

/** Minimum tasks before auto-suggesting a verdict. */
const MIN_TASKS_FOR_VERDICT = 3;

/** Suggest a verdict based on success rate. Only suggests if the entry is still "pending". */
function autoSuggestVerdict(entry: ExperimentEntry): ExperimentEntry["verdict"] {
  if (entry.verdict !== "pending") return entry.verdict;
  if (entry.result.successRate === null) return "pending";
  if (entry.result.tasksCompleted !== null && entry.result.tasksCompleted < MIN_TASKS_FOR_VERDICT) return "pending";

  const rate = entry.result.successRate;
  if (rate >= 0.7) return "confirmed";
  if (rate < 0.3) return "refuted";
  return "inconclusive";
}

/**
 * Backfill experiment results for all pending entries associated with an agent.
 * Called on task completion — fills in successRate, avgTime, tasksCompleted
 * from the agent's task history, and auto-suggests a verdict when enough data exists.
 * Returns entries that were updated (so the caller can push them to the client).
 */
export function backfillExperimentResults(
  userId: string,
  agentId: string,
  taskHistory: { task: string; success: boolean; ts: number; durationMs: number }[],
): ExperimentEntry[] {
  const log = getLog(userId);
  const updated: ExperimentEntry[] = [];

  // Only consider entries for this agent that are still pending and have null results
  const pendingEntries = log.filter(
    (e) => e.agentId === agentId && e.verdict === "pending" && e.result.successRate === null,
  );

  if (pendingEntries.length === 0) return updated;

  // Compute aggregate stats from task history
  const recentHistory = taskHistory.slice(0, 20);
  const successCount = recentHistory.filter((h) => h.success).length;
  const totalDuration = recentHistory.reduce((sum, h) => sum + h.durationMs, 0);
  const successRate = recentHistory.length > 0 ? successCount / recentHistory.length : null;
  const avgTime = recentHistory.length > 0 ? totalDuration / recentHistory.length / 60000 : null; // minutes
  const tasksCompleted = recentHistory.length;

  for (const entry of pendingEntries) {
    // Only backfill if there are enough tasks to be meaningful
    if (tasksCompleted < 1) continue;

    entry.result = {
      successRate,
      avgTime: avgTime !== null ? Math.round(avgTime * 100) / 100 : null,
      tasksCompleted,
    };

    // Auto-suggest verdict after enough tasks
    if (tasksCompleted >= MIN_TASKS_FOR_VERDICT) {
      const suggested = autoSuggestVerdict(entry);
      if (suggested !== "pending") {
        entry.verdict = suggested;
      }
    }

    updated.push(entry);

    // Persist the updated result + verdict
    if (isSupabaseConfigured) {
      void supabaseAdmin
        .from("heights_cloud_experiment_logs")
        .update({
          result: JSON.stringify(entry.result),
          verdict: entry.verdict,
        })
        .eq("id", entry.id)
        .eq("user_id", userId)
        .then(() => {})
        .catch((err: unknown) => console.warn(`[experiment-log] failed to backfill entry ${entry.id}:`, err));
    }
  }

  return updated;
}

/** Get summary stats across all experiment entries for a user. */
export function getExperimentStats(userId: string): {
  total: number;
  confirmed: number;
  refuted: number;
  inconclusive: number;
  pending: number;
  avgSuccessRate: number | null;
} {
  const log = getLog(userId);
  const total = log.length;
  if (total === 0) {
    return { total: 0, confirmed: 0, refuted: 0, inconclusive: 0, pending: 0, avgSuccessRate: null };
  }

  const confirmed = log.filter((e) => e.verdict === "confirmed").length;
  const refuted = log.filter((e) => e.verdict === "refuted").length;
  const inconclusive = log.filter((e) => e.verdict === "inconclusive").length;
  const pending = log.filter((e) => e.verdict === "pending").length;

  const withRates = log.filter((e) => e.result.successRate !== null);
  const avgSuccessRate = withRates.length > 0
    ? withRates.reduce((sum, e) => sum + (e.result.successRate ?? 0), 0) / withRates.length
    : null;

  return { total, confirmed, refuted, inconclusive, pending, avgSuccessRate };
}
