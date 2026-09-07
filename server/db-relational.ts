import type { AgentInfo, AgentSchedule, GameSettings, LogEntry, PlayerInfo, PendingTask, TaskCard, WorldState, AgentStatus, AgentRole, OfficeTheme, PlatformEvent, RoomType } from "../shared/types.js";
import type { SaveState } from "./persistence.js";
import type { OfficeStateJSON } from "./office-state.js";
import { supabaseAdmin, isSupabaseConfigured } from "./supabase.js";

/**
 * Relational Persistence implementation.
 *
 * Instead of upserting a megabyte JSONB blob on every change, this class
 * reads/writes individual rows across the relational tables:
 *   - agent_heights_player_info
 *   - agent_heights_game_settings
 *   - agent_heights_rooms + agent_heights_world_state
 *   - agent_heights_agents
 *   - agent_heights_agent_logs
 *   - agent_heights_task_cards
 *
 * Implements the same Persistence interface so AgentManager doesn't change.
 * Writes are still debounced (400ms) for batch operations like setAgents,
 * but individual log appends are written immediately.
 */

const LOG_CAP = 500;

export class RelationalPersistence {
  private userId: string;
  private roomId: string | null = null;
  private state: SaveState;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;
  /** True if load() failed due to a DB error (vs returning null for a new user). */
  public loadError = false;
  private pendingAgents: boolean = false;
  private pendingBoard: boolean = false;
  private pendingSchedules: boolean = false;
  private pendingSettings: boolean = false;
  private pendingPlayer: boolean = false;
  private pendingWorld: boolean = false;
  private pendingPendingTasks: boolean = false;
  private pendingPlatformCredentials: boolean = false;
  private pendingLastRoomType: boolean = false;
  /** Tracks how many logs per agent are already in the DB (for trimming). */
  private syncedLogCount: Map<string, number> = new Map();
  /** Tracks the timestamp of the last persisted log per agent.
   *  Robust against in-memory array trimming (MAX_LOG) — unlike count-based
   *  slicing, timestamp comparison correctly identifies new logs even when
   *  the front of the array has been removed. */
  private syncedLastLogTs: Map<string, number> = new Map();
  /** Per-row dirty tracking — only upsert rows that actually changed. */
  private dirtyAgentIds: Set<string> = new Set();
  private agentSnapshot: Map<string, string> = new Map();
  private dirtyBoardIds: Set<string> = new Set();
  private boardSnapshot: Map<string, string> = new Map();
  private dirtyScheduleIds: Set<string> = new Set();
  private scheduleSnapshot: Map<string, string> = new Map();
  /** Whether the initial load from DB succeeded. When false, flush methods
   *  must NOT delete rows that are absent from in-memory state — otherwise
   *  a transient query failure on boot causes permanent data loss. */
  private loadSucceeded: boolean = false;

  constructor(userId: string) {
    this.userId = userId;
    this.state = {
      player: null,
      agents: [],
      logs: {},
      board: [],
      schedules: [],
      world: { seed: 0, firedAgents: [] },
      pendingTasks: {},
    };
  }

  async load(): Promise<SaveState | null> {
    if (!isSupabaseConfigured) return null;
    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this._loadInner().then((r) => {
          if (timeoutId) clearTimeout(timeoutId);
          return r;
        }),
        new Promise<SaveState | null>((resolve) => {
          timeoutId = setTimeout(() => {
            console.warn(`[db-rel] load timed out for user ${this.userId} — returning defaults`);
            resolve(null);
          }, 5_000);
        }),
      ]);
      return result;
    } catch (err) {
      console.error("[db-rel] load failed:", err);
      return null;
    }
  }

  private async _loadInner(): Promise<SaveState | null> {
      // ── Parallel load: user-level queries don't depend on roomId ───────
      // Only world_state needs roomId, so we fetch the room in parallel with
      // the 6 user-level queries, then fetch world_state after room resolves.
      // Use order+limit(1) instead of maybeSingle() to handle the case where
      // multiple rooms exist (can happen if room creation was called multiple
      // times due to a previous bug). maybeSingle() errors on >1 row.
      const roomPromise = supabaseAdmin
        .from("agent_heights_rooms")
        .select("id, seed, theme")
        .eq("owner_id", this.userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const [
        playerRes,
        settingsRes,
        agentsRes,
        cardRowsRes,
        scheduleRowsRes,
        mailRowsRes,
        roomRes,
      ] = await Promise.all([
        supabaseAdmin
          .from("agent_heights_player_info")
          .select("name, workspace, appearance")
          .eq("user_id", this.userId)
          .maybeSingle(),
        supabaseAdmin
          .from("agent_heights_game_settings")
          .select("cline_max_iterations, cline_auto_approve, cline_review_handoff, game_idle_wander, game_theme, railway_enabled, mailbox_platforms")
          .eq("user_id", this.userId)
          .maybeSingle(),
        supabaseAdmin
          .from("agent_heights_agents")
          .select("*")
          .eq("owner_id", this.userId)
          .eq("archived", false),
        supabaseAdmin
          .from("agent_heights_task_cards")
          .select("*")
          .eq("owner_id", this.userId),
        supabaseAdmin
          .from("agent_heights_schedules")
          .select("*")
          .eq("owner_id", this.userId),
        supabaseAdmin
          .from("agent_heights_mail_events")
          .select("platform, direction, sender, text, timestamp, status")
          .eq("user_id", this.userId)
          .order("timestamp", { ascending: false })
          .limit(500),
        roomPromise,
      ]);

      // ── Error checks: if any critical query failed, abort load entirely.
      // Returning null signals to the AgentManager constructor that no saved
      // state was loaded, so it starts fresh without triggering a destructive
      // flush that would delete existing DB rows.
      if (roomRes.error) {
        console.error(`[db-rel] load aborted for user ${this.userId}: room query failed:`, roomRes.error);
        this.loadError = true;
        return null;
      }
      if (agentsRes.error) {
        console.error(`[db-rel] load aborted for user ${this.userId}: agents query failed:`, agentsRes.error);
        this.loadError = true;
        return null;
      }
      if (cardRowsRes.error) {
        console.error(`[db-rel] load aborted for user ${this.userId}: task_cards query failed:`, cardRowsRes.error);
        this.loadError = true;
        return null;
      }
      if (scheduleRowsRes.error) {
        console.error(`[db-rel] load aborted for user ${this.userId}: schedules query failed:`, scheduleRowsRes.error);
        this.loadError = true;
        return null;
      }
      // player and settings are non-critical — null/undefined is fine for those.
      if (playerRes.error) {
        console.warn(`[db-rel] player_info query failed for user ${this.userId}:`, playerRes.error);
      }
      if (settingsRes.error) {
        console.warn(`[db-rel] game_settings query failed for user ${this.userId}:`, settingsRes.error);
      }
      if (mailRowsRes.error) {
        console.warn(`[db-rel] mail_events query failed for user ${this.userId}:`, mailRowsRes.error);
      }

      // Resolve room — create if missing
      let room = roomRes.data;
      if (!room) {
        const { data: newRoom, error: roomErr } = await supabaseAdmin
          .from("agent_heights_rooms")
          .insert({ owner_id: this.userId, name: "My Office", seed: 0, theme: "classic" })
          .select("id, seed, theme")
          .single();
        if (roomErr || !newRoom) return null;
        room = newRoom;
      }
      this.roomId = room.id;

      // Fetch world_state now that roomId is known (1 extra round-trip, but
      // only for users with a room — first-time users skip this).
      const worldRowRes = await supabaseAdmin
        .from("agent_heights_world_state")
        .select("seed, fired_agents, chunk_overrides, pending_tasks, vacationed_agents, office_overrides, platform_credentials, last_room_type")
        .eq("room_id", this.roomId)
        .maybeSingle();

      if (worldRowRes.error) {
        console.warn(`[db-rel] world_state query failed for user ${this.userId}:`, worldRowRes.error);
      }

      const playerRow = playerRes.data;
      const player: PlayerInfo | null = playerRow
        ? { name: playerRow.name, workspace: playerRow.workspace, appearance: playerRow.appearance ?? null }
        : null;

      const settingsRow = settingsRes.data;
      const settings: GameSettings | undefined = settingsRow
        ? {
            cline: {
              maxIterations: settingsRow.cline_max_iterations,
              autoApproveCommands: settingsRow.cline_auto_approve,
              reviewBeforeHandoff: settingsRow.cline_review_handoff ?? false,
            },
            game: {
              idleWander: settingsRow.game_idle_wander,
              theme: settingsRow.game_theme as OfficeTheme,
            },
            railway: { enabled: settingsRow.railway_enabled },
            mailboxPlatforms: settingsRow.mailbox_platforms ?? [null, null, null, null, null, null],
          }
        : undefined;

      const agents: AgentInfo[] = (agentsRes.data ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        title: r.title,
        provider: r.provider,
        model: r.model,
        status: r.status as AgentStatus,
        task: r.task,
        deskIndex: r.desk_index,
        sprite: r.sprite,
        appearance: r.appearance ?? null,
        accent: r.accent,
        systemPrompt: r.system_prompt,
        role: r.role as AgentRole,
        sessionId: r.session_id,
        tasksDone: r.tasks_done,
        mcpServers: r.mcp_servers ?? undefined,
        ...(r.extra_fields ?? {}),
      }));

      // Load logs (depends on agents) — capped at LOG_CAP per agent
      const logs: Record<string, LogEntry[]> = {};
      if (agents.length > 0) {
        const agentIds = agents.map((a) => a.id);
        const { data: logRows, error: logErr } = await supabaseAdmin
          .from("agent_heights_agent_logs")
          .select("agent_id, ts, kind, text")
          .in("agent_id", agentIds)
          .eq("archived", false)
          .order("ts", { ascending: true })
          .limit(LOG_CAP * agentIds.length);

        if (logErr) {
          console.warn(`[db-rel] agent_logs query failed for user ${this.userId}:`, logErr);
        }

        for (const row of logRows ?? []) {
          if (!logs[row.agent_id]) logs[row.agent_id] = [];
          if (logs[row.agent_id].length < LOG_CAP) {
            logs[row.agent_id].push({ ts: row.ts, kind: row.kind, text: row.text });
          }
        }
      }

      const board: TaskCard[] = (cardRowsRes.data ?? []).map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status as any,
        assignedAgentId: r.assigned_agent_id ?? null,
        createdAt: r.created_at,
      }));

      const schedules: AgentSchedule[] = (scheduleRowsRes.data ?? []).map((r: any) => ({
        id: r.id,
        agentId: r.agent_id,
        name: r.name,
        task: r.task,
        cronExpression: r.cron_expression,
        enabled: r.enabled,
        lastRunAt: r.last_run_at ?? null,
        nextRunAt: r.next_run_at,
        runCount: r.run_count,
        handoffTo: r.handoff_to ?? null,
        createdAt: r.created_at,
        consecutiveFailures: r.consecutive_failures ?? 0,
        chainTo: r.chain_to ?? null,
      }));

      const worldRow = worldRowRes.data;
      const world: WorldState = worldRow
        ? { seed: worldRow.seed, firedAgents: worldRow.fired_agents ?? [], vacationedAgents: (worldRow as any).vacationed_agents ?? [], chunkOverrides: worldRow.chunk_overrides ?? {} }
        : { seed: room.seed, firedAgents: [] };

      // Load pending tasks (stored as JSONB on world_state)
      const pendingTasksMap: Record<string, PendingTask[]> = {};
      if ((worldRow as any)?.pending_tasks && typeof (worldRow as any).pending_tasks === "object") {
        for (const [agentId, tasks] of Object.entries((worldRow as any).pending_tasks as Record<string, unknown>)) {
          if (Array.isArray(tasks)) {
            pendingTasksMap[agentId] = tasks as PendingTask[];
          }
        }
      }

      const mailEvents: PlatformEvent[] = (mailRowsRes.data ?? []).map((r: any) => ({
        platform: r.platform,
        direction: r.direction,
        sender: r.sender,
        text: r.text,
        timestamp: r.timestamp,
      }));

      // Load platform credentials (stored as JSONB on world_state)
      const platformCredentials: Record<string, string> = {};
      if ((worldRow as any)?.platform_credentials && typeof (worldRow as any).platform_credentials === "object") {
        for (const [k, v] of Object.entries((worldRow as any).platform_credentials as Record<string, unknown>)) {
          if (typeof v === "string") platformCredentials[k] = v;
        }
      }

      this.state = { player, agents, logs, settings, board, schedules, world, pendingTasks: pendingTasksMap, mailEvents, platformCredentials };
      // Load lastRoomType from world_state row if present
      if ((worldRow as any)?.last_room_type) {
        this.state.lastRoomType = (worldRow as any).last_room_type as RoomType;
      }
      // Initialize synced log counts and last-log timestamps from loaded data.
      // syncedLastLogTs is the key field for detecting new logs — it's robust
      // against in-memory array trimming (MAX_LOG) unlike count-based slicing.
      this.syncedLogCount.clear();
      this.syncedLastLogTs.clear();
      for (const [agentId, agentLogs] of Object.entries(logs)) {
        this.syncedLogCount.set(agentId, agentLogs.length);
        if (agentLogs.length > 0) {
          this.syncedLastLogTs.set(agentId, agentLogs[agentLogs.length - 1].ts);
        }
      }
      // Initialize per-row snapshots so we only upsert changed rows
      this.agentSnapshot.clear();
      for (const a of agents) this.agentSnapshot.set(a.id, JSON.stringify(a));
      this.boardSnapshot.clear();
      for (const c of board) this.boardSnapshot.set(c.id, JSON.stringify(c));
      this.scheduleSnapshot.clear();
      for (const s of schedules) this.scheduleSnapshot.set(s.id, JSON.stringify(s));
      this.dirtyAgentIds.clear();
      this.dirtyBoardIds.clear();
      this.dirtyScheduleIds.clear();
      this.loadSucceeded = true;
      return this.state;
  }

  setPlayer(player: PlayerInfo): void {
    this.state.player = player;
    this.pendingPlayer = true;
    this.schedule();
  }

  setAgents(agents: AgentInfo[], logs: Record<string, LogEntry[]>): void {
    this.state.agents = agents;
    this.state.logs = logs;
    // Per-row dirty check: compare each agent to its snapshot
    for (const a of agents) {
      const serialized = JSON.stringify(a);
      if (this.agentSnapshot.get(a.id) !== serialized) {
        this.dirtyAgentIds.add(a.id);
      }
    }
    this.pendingAgents = true;
    this.schedule();
  }

  setSettings(settings: GameSettings): void {
    this.state.settings = settings;
    this.pendingSettings = true;
    this.schedule();
  }

  setBoard(board: TaskCard[]): void {
    this.state.board = board;
    // Per-row dirty check
    for (const c of board) {
      const serialized = JSON.stringify(c);
      if (this.boardSnapshot.get(c.id) !== serialized) {
        this.dirtyBoardIds.add(c.id);
      }
    }
    this.pendingBoard = true;
    this.schedule();
  }

  setSchedules(schedules: AgentSchedule[]): void {
    this.state.schedules = schedules;
    // Per-row dirty check
    for (const s of schedules) {
      const serialized = JSON.stringify(s);
      if (this.scheduleSnapshot.get(s.id) !== serialized) {
        this.dirtyScheduleIds.add(s.id);
      }
    }
    this.pendingSchedules = true;
    this.schedule();
  }

  setWorld(world: WorldState): void {
    this.state.world = world;
    this.pendingWorld = true;
    this.schedule();
  }

  getWorld(): WorldState {
    return this.state.world ?? { seed: 0, firedAgents: [] };
  }

  setPendingTasks(tasks: Record<string, PendingTask[]>): void {
    this.state.pendingTasks = tasks;
    this.pendingPendingTasks = true;
    this.schedule();
  }

  getPendingTasks(): Record<string, PendingTask[]> {
    return this.state.pendingTasks ?? {};
  }

  clearPendingTasks(): void {
    this.state.pendingTasks = {};
    this.pendingPendingTasks = true;
    this.schedule();
  }

  setPlatformCredentials(creds: Record<string, string>): void {
    this.state.platformCredentials = creds;
    this.pendingPlatformCredentials = true;
    this.schedule();
  }

  getPlatformCredentials(): Record<string, string> {
    return this.state.platformCredentials ?? {};
  }

  setOfficeState(state: OfficeStateJSON): void {
    this.state.officeState = state;
    this.schedule();
  }

  getLastRoomType(): RoomType | undefined {
    return this.state.lastRoomType;
  }

  setLastRoomType(roomType: RoomType): void {
    this.state.lastRoomType = roomType;
    this.pendingLastRoomType = true;
    this.schedule();
  }

  flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // If a debounced flush is already running, await it first, then run
    // our own flush to ensure the latest state is written.
    if (this.flushInFlight) {
      const prev = this.flushInFlight;
      this.flushInFlight = (async () => {
        await prev.catch(() => {});
        await this.flush();
      })();
      return this.flushInFlight;
    }
    this.flushInFlight = this.flush();
    return this.flushInFlight;
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushInFlight = this.flush();
      void this.flushInFlight.then(() => {
        this.flushInFlight = null;
      }).catch(() => {
        this.flushInFlight = null;
      });
    }, 3000);
  }

  private async flush(): Promise<void> {
    if (!isSupabaseConfigured || !this.roomId) return;

    if (this.pendingPlayer && this.state.player) {
      this.pendingPlayer = false;
      try {
        await supabaseAdmin
          .from("agent_heights_player_info")
          .upsert({
            user_id: this.userId,
            name: this.state.player.name,
            workspace: this.state.player.workspace,
            appearance: this.state.player.appearance ?? null,
          });
      } catch (err) {
        console.error("[db-rel] setPlayer failed:", err);
      }
    }

    if (this.pendingSettings && this.state.settings) {
      this.pendingSettings = false;
      try {
        await supabaseAdmin
          .from("agent_heights_game_settings")
          .upsert({
            user_id: this.userId,
            cline_max_iterations: this.state.settings.cline.maxIterations,
            cline_auto_approve: this.state.settings.cline.autoApproveCommands,
            cline_review_handoff: this.state.settings.cline.reviewBeforeHandoff,
            game_idle_wander: this.state.settings.game.idleWander,
            game_theme: this.state.settings.game.theme,
            railway_enabled: this.state.settings.railway.enabled,
            mailbox_platforms: this.state.settings.mailboxPlatforms,
          });
      } catch (err) {
        console.error("[db-rel] setSettings failed:", err);
      }
    }

    // Merge all world_state upserts into a single query when multiple are pending
    const worldPending = this.pendingWorld || this.pendingPendingTasks || this.pendingPlatformCredentials || this.pendingLastRoomType;
    if (worldPending) {
      const upsertData: Record<string, unknown> = {
        room_id: this.roomId,
        owner_id: this.userId,
      };
      if (this.pendingWorld && this.state.world) {
        upsertData.seed = this.state.world.seed;
        upsertData.fired_agents = this.state.world.firedAgents;
        upsertData.vacationed_agents = this.state.world.vacationedAgents ?? [];
        upsertData.chunk_overrides = this.state.world.chunkOverrides ?? {};
      }
      if (this.pendingPendingTasks) {
        upsertData.pending_tasks = this.state.pendingTasks ?? {};
      }
      if (this.pendingPlatformCredentials) {
        upsertData.platform_credentials = this.state.platformCredentials ?? {};
      }
      if (this.pendingLastRoomType) {
        upsertData.last_room_type = this.state.lastRoomType ?? null;
      }
      try {
        const result = await supabaseAdmin
          .from("agent_heights_world_state")
          .upsert(upsertData, { onConflict: "room_id" });
        if (result.error) {
          console.error(`[db-rel] world_state upsert error for user ${this.userId}:`, result.error);
          // Retry: leave pending flags as-is
        } else {
          if (this.pendingWorld) this.pendingWorld = false;
          if (this.pendingPendingTasks) this.pendingPendingTasks = false;
          if (this.pendingPlatformCredentials) this.pendingPlatformCredentials = false;
          if (this.pendingLastRoomType) this.pendingLastRoomType = false;
        }
      } catch (err) {
        console.error("[db-rel] world_state upsert failed:", err);
        // Leave pending flags as-is for retry
      }
    }

    if (this.pendingAgents) {
      this.pendingAgents = false;
      await this.flushAgents();
    }

    if (this.pendingBoard) {
      this.pendingBoard = false;
      await this.flushBoard();
    }

    if (this.pendingSchedules) {
      this.pendingSchedules = false;
      await this.flushSchedules();
    }
  }

  private async flushAgents(): Promise<void> {
    if (!this.roomId) {
      console.warn(`[db-rel] flushAgents SKIP: roomId is null for user ${this.userId}`);
      return;
    }
    const agents = this.state.agents;
    const logs = this.state.logs;

    // Only upsert agents that actually changed (per-row dirty tracking).
    // ALSO include agents that have logs to sync but aren't yet in agentSnapshot
    // (never been upserted to DB) — without this, log insertion hits FK violation.
    const agentsWithLogsToSync = agents.filter((a) => {
      const agentLogs = logs[a.id] ?? [];
      if (agentLogs.length === 0) return false;
      const lastTs = this.syncedLastLogTs.get(a.id) ?? 0;
      return agentLogs.some((l) => l.ts > lastTs);
    });
    const agentsNeedingUpsert = new Set(this.dirtyAgentIds);
    for (const a of agentsWithLogsToSync) {
      if (!this.agentSnapshot.has(a.id)) {
        agentsNeedingUpsert.add(a.id);
      }
    }
    const dirtyAgents = agents.filter((a) => agentsNeedingUpsert.has(a.id));
    const rows = dirtyAgents.map((a) => {
      const { id, name, title, provider, model, status, task, deskIndex, sprite, appearance, accent, systemPrompt, role, sessionId, tasksDone, mcpServers, ...extra } = a;
      return {
        id,
        room_id: this.roomId,
        owner_id: this.userId,
        name,
        title,
        provider,
        model,
        status,
        task,
        desk_index: deskIndex,
        sprite,
        appearance,
        accent,
        system_prompt: systemPrompt,
        role,
        session_id: sessionId,
        tasks_done: tasksDone,
        mcp_servers: mcpServers ?? null,
        extra_fields: extra,
        archived: false,
      };
    });

    let upsertSucceeded = true;
    if (rows.length > 0) {
      try {
        const upsertResult = await supabaseAdmin.from("agent_heights_agents").upsert(rows);
        if (upsertResult.error) {
          console.error(`[db-rel] upsert agents error for user ${this.userId} (${rows.length} rows):`, upsertResult.error);
          upsertSucceeded = false;
        } else {
          // Update snapshots for successfully upserted rows
          for (const a of dirtyAgents) {
            this.agentSnapshot.set(a.id, JSON.stringify(a));
          }
        }
      } catch (err) {
        console.error(`[db-rel] upsert agents failed for user ${this.userId}:`, err);
        upsertSucceeded = false;
      }
    }
    // Clear dirty set regardless — if upsert failed, next setAgents will re-detect changes
    this.dirtyAgentIds.clear();

    // Reconciliation removed. The fire() method explicitly calls
    // archiveAgent() for each fired agent — no bulk reconciliation needed.
    // The old reconciliation archived ANY agent in the DB not in the current
    // in-memory list, which caused data loss when an agent wasn't loaded
    // (e.g. was archived=true at load time, then un-archived manually).

    // Sync logs — use timestamp-based detection for new logs.
    // This is robust against in-memory array trimming (MAX_LOG): even after
    // the front of the array is removed, logs with ts > syncedLastLogTs are
    // correctly identified as new. The old count-based slice(existingCount)
    // broke once the array hit MAX_LOG because slice(500) on a 500-length
    // array returned [], silently dropping all new logs from DB persistence.
    //
    // CRITICAL: We insert logs per-agent because the bulk_insert_agent_logs RPC
    // uses a single INSERT statement — if any agent_id violates the foreign key
    // constraint (agent must exist in agent_heights_agents), the ENTIRE batch
    // fails, silently dropping logs for ALL agents.
    // Skip log insertion if upsert failed — logs would hit FK violation.
    // Agents already in agentSnapshot (loaded from DB or previously upserted)
    // are safe to insert logs for even if this upsert failed.
    const agentsWithLogs = agents.filter((a) => {
      if ((logs[a.id] ?? []).length === 0) return false;
      if (!upsertSucceeded && !this.agentSnapshot.has(a.id)) return false;
      return true;
    });
    if (agentsWithLogs.length > 0) {
      const trimNeeded: Array<{ agentId: string; trimCount: number }> = [];

      for (const agent of agentsWithLogs) {
        const agentLogs = logs[agent.id] ?? [];
        const lastTs = this.syncedLastLogTs.get(agent.id) ?? 0;

        // Filter by timestamp: any log newer than the last persisted one is new.
        const newLogs = agentLogs.filter((l) => l.ts > lastTs);

        if (newLogs.length > 0) {
          const newLogRows = newLogs.map((l) => ({
            agent_id: agent.id,
            owner_id: this.userId,
            ts: l.ts,
            kind: l.kind,
            text: l.text,
            archived: false,
          }));

          // Insert per-agent so one agent's failure doesn't drop others' logs
          // Pass array directly — JSON.stringify causes double-encoding (scalar string
          // instead of json array), producing "cannot call json_populate_recordset on a scalar"
          try {
            const result = await supabaseAdmin.rpc("bulk_insert_agent_logs", { payload: newLogRows });
            if (result.error) {
              console.error(`[db-rel] insert logs error for agent ${agent.id} (${newLogRows.length} rows) user ${this.userId}:`, result.error);
            } else {
              // Only update syncedLastLogTs AFTER successful insert
              this.syncedLastLogTs.set(agent.id, newLogs[newLogs.length - 1].ts);
              this.syncedLogCount.set(agent.id, agentLogs.length);
            }
          } catch (err) {
            console.error(`[db-rel] insert logs failed for agent ${agent.id} (${newLogRows.length} rows) user ${this.userId}:`, err);
          }
        }

        const totalCount = this.syncedLogCount.get(agent.id) ?? agentLogs.length;
        if (totalCount > LOG_CAP) {
          trimNeeded.push({
            agentId: agent.id,
            trimCount: totalCount - LOG_CAP,
          });
        }
      }

      // Batch trim: query oldest logs for agents that need trimming, then batch delete
      if (trimNeeded.length > 0) {
        const allIdsToDelete: string[] = [];
        for (const { agentId, trimCount } of trimNeeded) {
          try {
            const { data: oldLogs } = await supabaseAdmin
              .from("agent_heights_agent_logs")
              .select("id")
              .eq("agent_id", agentId)
              .eq("archived", false)
              .order("ts", { ascending: true })
              .limit(trimCount);
            if (oldLogs && oldLogs.length > 0) {
              allIdsToDelete.push(...oldLogs.map((r: any) => r.id));
            }
          } catch (err) {
            console.error(`[db-rel] trim query for ${agentId} failed:`, err);
          }
        }
        if (allIdsToDelete.length > 0) {
          try {
            await supabaseAdmin
              .from("agent_heights_agent_logs")
              .delete()
              .in("id", allIdsToDelete);
          } catch (err) {
            console.error(`[db-rel] batch trim logs failed (${allIdsToDelete.length} ids):`, err);
          }
        }
      }
    }
  }

  private async flushBoard(): Promise<void> {
    if (!this.roomId) return;
    const board = this.state.board ?? [];

    // Only upsert cards that actually changed
    const dirtyCards = board.filter((c) => this.dirtyBoardIds.has(c.id));
    const rows = dirtyCards.map((c) => ({
      id: c.id,
      room_id: this.roomId,
      owner_id: this.userId,
      title: c.title,
      description: c.description,
      status: c.status,
      assigned_agent_id: c.assignedAgentId ?? null,
      created_at: c.createdAt,
    }));

    if (rows.length > 0) {
      try {
        await supabaseAdmin.from("agent_heights_task_cards").upsert(rows);
        for (const c of dirtyCards) {
          this.boardSnapshot.set(c.id, JSON.stringify(c));
        }
      } catch (err) {
        console.error("[db-rel] upsert board failed:", err);
      }
    }
    this.dirtyBoardIds.clear();

    // Delete cards that no longer exist — only if load succeeded AND we have
    // a non-empty currentIds list. Never delete ALL cards (the empty-list
    // branch was a data-loss risk similar to the agents bug).
    if (this.loadSucceeded) {
      const currentIds = board.map((c) => c.id);
      if (currentIds.length > 0) {
        try {
          await supabaseAdmin
            .from("agent_heights_task_cards")
            .delete()
            .eq("owner_id", this.userId)
            .not("id", "in", `(${currentIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`);
        } catch (err) {
          console.error("[db-rel] delete stale cards failed:", err);
        }
      }
    }
  }

  private async flushSchedules(): Promise<void> {
    if (!this.roomId) return;
    const schedules = this.state.schedules ?? [];

    // Only upsert schedules that actually changed
    const dirtySchedules = schedules.filter((s) => this.dirtyScheduleIds.has(s.id));
    const rows = dirtySchedules.map((s) => ({
      id: s.id,
      agent_id: s.agentId,
      owner_id: this.userId,
      room_id: this.roomId,
      name: s.name,
      task: s.task,
      cron_expression: s.cronExpression,
      enabled: s.enabled,
      last_run_at: s.lastRunAt,
      next_run_at: s.nextRunAt,
      run_count: s.runCount,
      handoff_to: s.handoffTo,
      created_at: s.createdAt,
      consecutive_failures: s.consecutiveFailures ?? 0,
      chain_to: s.chainTo ?? null,
    }));

    if (rows.length > 0) {
      try {
        await supabaseAdmin.from("agent_heights_schedules").upsert(rows);
        for (const s of dirtySchedules) {
          this.scheduleSnapshot.set(s.id, JSON.stringify(s));
        }
      } catch (err) {
        console.error("[db-rel] upsert schedules failed:", err);
      }
    }
    this.dirtyScheduleIds.clear();

    // Delete schedules that no longer exist — only if load succeeded AND we
    // have a non-empty currentIds list. Never delete ALL schedules.
    if (this.loadSucceeded) {
      const currentIds = schedules.map((s) => s.id);
      if (currentIds.length > 0) {
        try {
          await supabaseAdmin
            .from("agent_heights_schedules")
            .delete()
            .eq("owner_id", this.userId)
            .not("id", "in", `(${currentIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`);
        } catch (err) {
          console.error("[db-rel] delete stale schedules failed:", err);
        }
      }
    }
  }

  async saveMessages(agentId: string, messages: unknown[]): Promise<void> {
    if (!isSupabaseConfigured || !this.roomId) return;
    try {
      // Delete existing non-archived messages for this agent and re-insert
      // Archived messages are preserved as an audit trail
      await supabaseAdmin
        .from("agent_heights_conversation_messages")
        .delete()
        .eq("agent_id", agentId)
        .eq("archived", false);

      if (messages.length === 0) return;

      const rows = messages.map((msg: any, i: number) => ({
        agent_id: agentId,
        owner_id: this.userId,
        seq: i,
        role: msg.role ?? "unknown",
        content: msg.content ?? msg,
        archived: false,
      }));

      await supabaseAdmin
        .from("agent_heights_conversation_messages")
        .insert(rows);
    } catch (err) {
      console.error(`[db-rel] saveMessages for ${agentId} failed:`, err);
    }
  }

  async loadMessages(agentId: string): Promise<unknown[]> {
    if (!isSupabaseConfigured || !this.roomId) return [];
    try {
      const { data, error } = await supabaseAdmin
        .from("agent_heights_conversation_messages")
        .select("role, content")
        .eq("agent_id", agentId)
        .eq("archived", false)
        .order("seq", { ascending: true });

      if (error || !data) return [];

      return data.map((row: any) => ({
        role: row.role,
        content: row.content,
      }));
    } catch (err) {
      console.error(`[db-rel] loadMessages for ${agentId} failed:`, err);
      return [];
    }
  }

  async loadArchivedMessages(agentId: string, limit = 50): Promise<{ role: string; content: string; ts: string }[]> {
    if (!isSupabaseConfigured || !this.roomId) return [];
    try {
      const { data, error } = await supabaseAdmin
        .from("agent_heights_conversation_messages")
        .select("role, content, ts")
        .eq("agent_id", agentId)
        .eq("archived", true)
        .order("ts", { ascending: false })
        .limit(limit);

      if (error || !data) return [];

      return data.map((row: any) => ({
        role: row.role,
        content: typeof row.content === "string" ? row.content : JSON.stringify(row.content),
        ts: row.ts,
      }));
    } catch (err) {
      console.error(`[db-rel] loadArchivedMessages for ${agentId} failed:`, err);
      return [];
    }
  }

  async clearMessages(agentId: string): Promise<void> {
    if (!isSupabaseConfigured || !this.roomId) return;
    try {
      // Soft-delete: archive messages instead of hard-deleting
      await supabaseAdmin
        .from("agent_heights_conversation_messages")
        .update({ archived: true })
        .eq("agent_id", agentId)
        .eq("archived", false);
    } catch (err) {
      console.error(`[db-rel] clearMessages for ${agentId} failed:`, err);
    }
  }

  async insertMailEvent(ev: PlatformEvent): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      await supabaseAdmin
        .from("agent_heights_mail_events")
        .insert({
          user_id: this.userId,
          platform: ev.platform,
          direction: ev.direction,
          sender: ev.sender,
          text: ev.text,
          timestamp: ev.timestamp,
          status: 'new',
        });
    } catch (err) {
      console.error("[db-rel] insertMailEvent failed:", err);
    }
  }

  async markMailHandled(platform: string): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      await supabaseAdmin
        .from("agent_heights_mail_events")
        .update({ status: 'handled' })
        .eq("user_id", this.userId)
        .eq("platform", platform)
        .eq("status", 'new');
    } catch (err) {
      console.error("[db-rel] markMailHandled failed:", err);
    }
  }

  async clearLogs(agentId: string): Promise<void> {
    if (!isSupabaseConfigured || !this.roomId) return;
    if (this.state.logs) this.state.logs[agentId] = [];
    this.syncedLogCount.set(agentId, 0);
    this.syncedLastLogTs.delete(agentId);
    try {
      // Soft-delete: archive logs instead of hard-deleting
      await supabaseAdmin
        .from("agent_heights_agent_logs")
        .update({ archived: true })
        .eq("agent_id", agentId)
        .eq("archived", false);
    } catch (err) {
      console.error(`[db-rel] clearLogs for ${agentId} failed:`, err);
    }
  }

  async archiveAgent(agentId: string): Promise<void> {
    if (!isSupabaseConfigured || !this.roomId) return;
    try {
      const { error } = await supabaseAdmin
        .from("agent_heights_agents")
        .update({ archived: true })
        .eq("id", agentId)
        .eq("owner_id", this.userId);
      if (error) {
        console.error(`[db-rel] archiveAgent failed for ${agentId}:`, error);
      }
    } catch (err) {
      console.error(`[db-rel] archiveAgent exception for ${agentId}:`, err);
    }
  }

  async unarchiveAgent(agentId: string): Promise<void> {
    if (!isSupabaseConfigured || !this.roomId) return;
    try {
      const { error } = await supabaseAdmin
        .from("agent_heights_agents")
        .update({ archived: false })
        .eq("id", agentId)
        .eq("owner_id", this.userId);
      if (error) {
        console.error(`[db-rel] unarchiveAgent failed for ${agentId}:`, error);
      }
    } catch (err) {
      console.error(`[db-rel] unarchiveAgent exception for ${agentId}:`, err);
    }
  }
}
