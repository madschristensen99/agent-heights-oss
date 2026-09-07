# IDE Bridge — External Coding Tool Visibility in the Office

> *Your office shouldn't be blind to what you're doing outside it.*

Software engineers already use AI coding tools — Cursor, Windsurf, VS Code,
Claude Code, Codex, Aider. Agent Heights agents work in `ag/workspace/`, a
completely separate world from the user's real IDE. The office feels
disconnected from the actual work happening on the user's machine.

The IDE Bridge closes that gap. It streams real-time activity from any
external coding tool into the office, visualizes it as a **contractor desk**
or **terminal station**, feeds events into the office feed, and makes the
user's current context available to AH agents when assigning tasks.

The office becomes a unified command center: your real work + your AI
agents, all visible in one place.

---

## 0. T3 Code Inspiration

We studied [T3 Code](https://github.com/pingdotgg/t3code) — an open-source
"agent harness control surface" by Theo that lets you control Claude Code,
Codex, Cursor, Grok Build, and OpenCode from a single web/desktop/mobile app.

T3 Code solves a related but different problem: **controlling** external agent
CLIs from one UI. We're solving **visibility** — seeing what those tools are
doing from inside the Agent Heights office. But several of their patterns are
directly useful:

### What We're Borrowing

1. **Pairing flow** (replaces `AH_TOKEN` env var) — User clicks "Connect IDE"
   in the AH app, gets a QR code, runs `ah pair <code>` in terminal. No token
   copying. T3 Code does this with `t3 pair`.

2. **Provider driver pattern** — Instead of treating all CLI tools the same,
   each tool (Claude Code, Codex, Aider, Cursor) gets a driver with its own
   output parser. T3 Code calls these "provider drivers" — each declares its
   kind, config schema, and creates a scoped adapter. This makes `ah wrap`
   parsing per-tool instead of generic regex.

3. **Git-ref checkpointing** — Capture a git checkpoint (hidden ref) at
   session start and end. Diff the refs to get **exact** file changes — not
   estimated line counts. T3 Code brackets every turn with git checkpoints
   for precise diffs and reverts.

4. **Permission modes** — Instead of just allowlist/blocklist config, users
   pick a visibility mode: Full (all events), Metadata only (no commands),
   Git-only (branch + commits only), Anonymous (aggregate stats only).
   T3 Code has Supervised / Auto-accept / Auto / Full access for agent
   execution permissions — we adapt the concept for visibility control.

5. **Source control integration** — Surface PR/MR activity in the office
   feed. "Claude Code opened PR #42: fix auth flow" as a feed event. T3 Code
   integrates with GitHub/GitLab/Bitbucket/Azure for PR creation and review.

### What We're NOT Borrowing

- **Effect RPC framework** — our hand-rolled JSON WS protocol is fine for
  this scope
- **Event-sourced orchestration engine** — over-engineered for ephemeral
  session tracking (we may revisit for Phase 3 analytics)
- **Tailscale remote access** — AH server is already remote (Railway)
- **Desktop/mobile control apps** — AH already has web + Capacitor iOS

---

## 0.5 Current State (What's Already Built)

The IDE Bridge is **not a greenfield project** — the full pipeline is
already implemented and working end-to-end. Here's what exists today:

### Already Built ✅

- **`ah-cli` package** (`ah-cli/src/`)
  - `cli.ts` — entry point with `watch`, `wrap`, `hook` subcommands
  - `ws-client.ts` — `BridgeClient` class: WebSocket connection, reconnection,
    event queuing/flushing, idle detection
  - `watch.ts` — file watcher + git branch polling → `file_edit` + `git_branch` events
  - `wrap.ts` — command wrapper → `command` events (start + exit code)
  - `hook.ts` + `hook-cli.ts` — Claude Code hook receiver

- **Server** (`server/ide-bridge.ts` — 415 lines)
  - `IdeBridge` class with full session lifecycle: connect, activity, disconnect
  - In-memory session store per userId with 60s grace period
  - Supabase token verification on connect
  - Broadcasts `external_session_update` + `external_feed_event` to room
  - Org-level session sharing with privacy filtering (`full` / `branch_only` / `hidden`)
  - `getContextSummary()` — injects live dev context into agent system prompts
  - `matchBranchToCardId()` — links git branches to sprint board cards
  - Velocity snapshots to DB every 5 minutes
  - Wired into `server/index.ts`: WS handlers for all `external_*` messages

- **Shared types** (`shared/types.ts`)
  - `ExternalTool`, `ExternalSession`, `ExternalEvent`, `OrgExternalSession`
  - `IdeBridgeVisibility` (full / branch_only / hidden)
  - All `ClientMsg` and `ServerMsg` types for bridge messages
  - `ExternalEvent` already supports 12 event types: `file_edit`, `file_save`,
    `git_commit`, `git_branch`, `test_run`, `test_result`, `command`,
    `ai_completion`, `ai_chat`, `session_start`, `session_end`, `error`

- **Client store** (`client/src/store.ts`)
  - `externalSessions` Map + `orgExternalSessions` Map
  - All WS handlers: sync, update, remove, feed events (personal + org)
  - `ideBridgeVisibility` state + `showTerminalStations` toggle

- **Client scene** (`client/src/game/scene.ts`)
  - `TerminalStation` rendering: CRT terminal desks with tool icons, file labels,
    status glows, activity text
  - `WallDashboard`: aggregate stats across all sessions (personal + org)
  - Syncs on both personal and org session changes

- **Client HUD** (`client/src/ui/hud.ts`)
  - "🖥️ IDE" button in topbar
  - `openIdeBridgePanel()`: active sessions list, connection instructions
    (`ah watch` command with host + token), privacy settings, terminal
    station toggle, velocity trends, standup summaries

### The Real Gap ❌

The **entire pipeline works** — the server, types, client store, scene
rendering, and HUD are all live. The gap is that the **CLI tools only send
2 of the 12 possible event types**:

| Event Type | `ah watch` | `ah wrap` | `ah-hook` | Server handles it? |
|---|---|---|---|---|
| `file_edit` | ✅ | ❌ | ✅ (if hook fires) | ✅ |
| `git_branch` | ✅ | ❌ | ❌ | ✅ |
| `command` | ❌ | ✅ start + exit | ❌ | ✅ |
| `git_commit` | ❌ | ❌ | ❌ (has type, no detection) | ✅ |
| `test_run` | ❌ | ❌ | ❌ | ✅ |
| `test_result` | ❌ | ❌ | ❌ | ✅ |
| `error` | ❌ | ✅ (exit code) | ❌ | ✅ |
| `ai_completion` | ❌ | ❌ | ❌ | ✅ |
| `ai_chat` | ❌ | ❌ | ❌ | ✅ |
| `session_start` | ❌ | ❌ | ❌ | ✅ (server creates it) |
| `session_end` | ❌ | ❌ | ❌ | ✅ (server creates it) |
| `file_save` | ❌ | ❌ | ❌ | ✅ |

**The server already broadcasts all of these. The client already renders
them. The `ExternalEvent` type already defines them. The CLI just isn't
sending them yet.**

This means the next phase of work is **CLI-only changes** — no server,
type, or client work needed to get richer events flowing.

---

## 1. What It Looks Like in the Office

### 1.1 Contractor Desk (IDE Tools)

A new desk type for VS Code / Cursor / Windsurf sessions. Placed in the
office alongside agent desks. Features:

- **Monitor** showing live IDE state: current file name, language icon,
  cursor position, lines changed, git branch
- **Matrix rain effect** (reusing `monitorMatrixOverlays`) with a **cyan
  tint** to distinguish "you" from agents (agents stay green)
- **Status indicator**: idle (dim), typing (pulsing), debugging (red tint),
  running tests (yellow)
- **Speech bubble** with periodic activity: "Editing auth.ts", "Running
  tests", "Git commit: fix login bug"

### 1.2 Terminal Station (CLI Tools)

A distinct desk type for Claude Code, Codex, Aider, and other terminal-native
tools. Retro CRT terminal aesthetic (green/amber phosphor) vs the blue LCD
monitors of regular agents.

The terminal shows:

- **Tool name + icon**: `🟠 Claude Code`, `🟢 Codex`, `🔵 Aider`
- **Current activity**: "Editing src/auth.ts", "Running npm test",
  "Searching for 'authToken'"
- **Session timer**: how long the CLI session has been active
- **File change counter**: `+127 -43 lines across 4 files`
- **Status light**: active (pulsing), waiting for input (dim), error (red)

### 1.3 Wall Dashboard

A wall-mounted screen (reuses projector surface or a new wall display)
showing aggregate metrics across all external sessions:

```
┌─────────────────────────────────────┐
│  EXTERNAL TOOLS                     │
│                                     │
│  🟠 Claude Code    12m active       │
│     4 files changed, 127 lines      │
│                                     │
│  🟢 Codex          5m active        │
│     1 file changed, 45 lines        │
│                                     │
│  🖥️ Cursor         active now       │
│     Editing: src/payment.ts         │
│                                     │
│  Total today: 5 files, 172 lines    │
│                                     │
│  ─── Language Breakdown ───         │
│  TypeScript 60% ████████░░          │
│  Python     30% ████░░░░░░          │
│  Other      10% █░░░░░░░░░          │
│                                     │
│  ─── Activity Sparkline ───         │
│  ▁▂▃▅▇▆▄▃▅▇█▇▅▃▂▁                  │
└─────────────────────────────────────┘
```

Additional panels:

- **Files changed today** with sparkline
- **Lines written/removed** (GitHub contribution graph style)
- **AI interactions**: completions accepted/rejected, chat messages sent
- **Language breakdown**: donut chart
- **Time spent**: active coding time this session
- **Git activity**: commits, branch switches
- **Open PRs** across all sessions (requires source control integration,
  see §2.5)

### 1.4 Office Feed Integration

External tool events flow into the existing office feed alongside agent
activity:

```
🟠 Claude Code: Editing src/auth.ts (+12 -3)
🟠 Claude Code: Running npm test auth.test.ts
🟠 Claude Code: ✅ All tests passed (8/8)
🟢 Codex: Created src/payment.ts (+45 lines)
🟢 Codex: Git commit "add payment module"
🖥️ Cursor: Saved src/index.ts (+5 -1)
🖥️ Cursor: Switched to branch feature/payment-flow
🟠 Claude Code: Opened PR #42 "fix auth flow" (github.com/.../pull/42)
```

This creates a unified timeline of everything happening across the user's
entire dev stack.

### 1.5 Agent Context (Killer Feature)

When a user assigns a task to an AH agent, the agent's system prompt
includes context from active external sessions:

> "External tool Claude Code is currently editing `src/auth.ts` on branch
> `feature/payment-fix`. It has made 3 file changes and run 2 test suites
> in the last 10 minutes. The user is also running Cursor with
> `src/payment.ts` open."

This means the user can say "fix the test that's failing" and the agent
already knows which file and which test. No more copy-pasting context.

### 1.6 Cross-Tool Analytics

If the user has multiple sessions open (Cursor for frontend, Claude Code
for backend), each gets its own desk. The wall dashboard aggregates across
all of them. Future: "Claude Code vs your AH agents — who ships more?"

---

## 2. Bridge Strategies by Tool Category

### 2.1 VS Code Ecosystem (Cursor, Windsurf, VS Code)

**Mechanism**: VS Code extension (`ah-bridge`)

All three editors are VS Code forks and support the same extension API.

**What it tracks** (all opt-in, configurable):

- Active file path + language
- Edit events (throttled to 1/sec, sends diff line counts — not content)
- Save events (file name + line delta)
- Git branch changes + commits
- Terminal commands + exit codes (test runs detected by command pattern)
- AI interactions (accepted completions, chat panel messages — via VS Code
  command interception)
- Active/inactive states (window focus)

**Privacy**: No file content is sent. Only metadata: file names, line
counts, language, git info, command names. Users can configure
allowlists/blocklists for paths.

### 2.2 Claude Code (Terminal CLI)

**Mechanism**: Claude Code hooks system

Claude Code has a first-class hooks system. Configure
`~/.claude/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": "ah-hook $TOOL_NAME $FILE_PATH",
    "Notification": "ah-hook --event notification --message \"$MESSAGE\"",
    "Stop": "ah-hook --event session-end"
  }
}
```

This gives us **everything**: every file edit, every shell command, every
search, session start/stop. We ship a tiny `ah-hook` script that forwards
these events to the AH server via WebSocket.

**Data we get**: tool name, file paths, command strings, session lifecycle,
diffs (if we want them).

**This is the cleanest integration of any external tool** — better than
even the VS Code extension. Zero ongoing friction after one-time config.

### 2.3 Codex, Aider, and Other CLI Tools

Three layered strategies, users pick their comfort level:

#### `ah watch` — Universal Daemon (Zero Friction)

```bash
# Terminal 1: start the bridge
ah watch

# Terminal 2: use whatever tool you want
claude "fix the auth tests"
codex "refactor the payment module"
aider --stream
```

**What it does**:

- **File watcher** (`chokidar` / `inotify`) — detects file creates/edits/
  deletes in real time
- **Git monitor** — polls `git status` + `git log` every few seconds for
  branch changes, commits, staged files
- **Process detector** — checks if `claude`, `codex`, `aider`, etc. are
  running in any terminal session
- **Terminal output capture** (optional) — if run as `ah wrap claude`,
  wraps the command and parses stdout for events
- Streams everything to AH server via WebSocket

**Data**: file changes (names + line deltas), git activity, which tool is
active, rough activity timeline.

**Limitations**: Can't see the conversation between user and CLI tool.
Can't distinguish "AI made this edit" from "user made this edit" unless
wrapping the command.

#### `ah wrap <command>` — Wrapper Mode with Per-Tool Drivers

```bash
ah wrap claude "fix the auth tests"
ah wrap codex "refactor the payment module"
ah wrap aider --stream
```

Wraps the CLI tool, captures stdout/stderr, and parses output using a
**provider driver** specific to that tool. Each driver knows its tool's
output format:

- **ClaudeCodeDriver** — parses Claude Code's structured output (file
  edits, tool calls, search queries, command execution)
- **CodexDriver** — parses Codex CLI output format
- **AiderDriver** — parses Aider's edit announcements and commit messages
- **CursorDriver** — parses Cursor CLI agent output
- **GenericDriver** — fallback regex-based parser for unknown tools

A driver implements:
```typescript
interface ProviderDriver {
  kind: ExternalTool;
  parseOutput(line: string): ExternalEvent | null;
  detectSession(): boolean;  // is this tool currently running?
  normalizeEvent(raw: unknown): ExternalEvent;
}
```

**Data**: everything `ah watch` gives us, plus conversation-level
visibility — what the user asked for and what the tool did about it.

**Limitations**: Requires the user to prefix their commands with `ah wrap`.
Output format changes break parsers — drivers are best-effort, `ah watch`
(file watching) is the format-agnostic fallback.

#### Claude Code Hooks (Zero Friction, Richest)

As described in §2.2. Configure once in `~/.claude/hooks.json`, get full
tool-call visibility forever.

### 2.4 Git-Ref Checkpointing (Exact Diffs)

Inspired by T3 Code's checkpoint system. Instead of estimating line changes
by counting file lines before/after (current `ah watch` approach), we capture
actual git state at session boundaries:

```bash
# Session start
git stash create  # → returns stash SHA (working tree snapshot)
# ... user works with Claude Code / Codex / Aider ...
# Session end
git stash create  # → returns stash SHA (final working tree)
git diff <start-sha> <end-sha> --stat  # exact file-level diff
```

The bridge stores these as hidden git refs (`refs/ah-sessions/<id>`).
This gives us:

- **Exact file-level diffs** — not line-count estimates
- **Per-file line counts** — `src/auth.ts: +12 -3, src/index.ts: +5 -1`
- **New vs modified vs deleted files** — precise categorization
- **Revert capability** — `git diff` against the checkpoint ref

Works with all bridge strategies (`ah watch`, `ah wrap`, hooks). The
checkpoint is captured on `external_connect` and `external_disconnect`.

### 2.5 Source Control Integration

Inspired by T3 Code's GitHub/GitLab/Bitbucket/Azure integration. When a
bridge session detects git push or PR creation, it surfaces the event in
the office feed:

```
🟠 Claude Code: Pushed 3 commits to feature/auth-fix
🟠 Claude Code: Opened PR #42 "fix auth flow"
🟢 Codex: PR #38 approved by @teammate
```

**How it works**:
- `ah watch` polls `git log --remotes` for new pushes
- If GitHub CLI (`gh`) is installed, `ah wrap` detects `gh pr create` calls
- Server can also poll GitHub API (using existing OAuth config) for open
  PRs on the current branch
- Wall dashboard shows open PRs across all sessions

**Requires**: GitHub OAuth (already configured for MCP servers) or `gh` CLI
installed locally. GitLab/Bitbucket support follows the same pattern.

### 2.6 Richness vs Friction Summary

```
                    Friction    Data Richness
                    ────────    ──────────────
Claude Code Hooks   zero        highest (every tool call)
ah wrap <cmd>       low         high (conversation + output, per-tool driver)
VS Code extension   low         high (cursor + edits + AI events)
ah watch            zero        moderate (files + git + process)

+ Git-ref checkpointing works with all strategies → exact diffs always
+ Source control integration works with all strategies → PR events in feed
```

---

## 3. Architecture

### 3.1 Package Structure

```
ah-bridge/                        # VS Code extension (Cursor/Windsurf/VS Code)
  src/
    extension.ts                  # Activation, WS connection to AH server
    activity-tracker.ts           # File open/edit/save, cursor, language
    git-tracker.ts                # Branch changes, commits, staged files
    ai-tracker.ts                 # Detect AI completions (Cursor/Windsurf/Copilot)
    terminal-tracker.ts           # Command execution, test results
    ws-client.ts                  # WebSocket client → AH server
  package.json                    # VS Code extension manifest

ah-cli/                           # npm package for CLI bridge (ALREADY EXISTS)
  src/
    cli.ts                        # Entry point, arg parsing
    watch.ts                      # `ah watch` — file watcher + git monitor daemon
    wrap.ts                       # `ah wrap <cmd>` — command wrapper with output capture
    hook.ts                       # `ah-hook` — Claude Code hook receiver
    hook-cli.ts                   # Standalone hook binary entry point
    ws-client.ts                  # Shared WebSocket client → AH server
    pair.ts                       # `ah pair <code>` — QR pairing flow (NEW)
    checkpoint.ts                 # Git-ref checkpoint capture/restore (NEW)
    drivers/                      # Per-tool output parsers (NEW)
      types.ts                    # ProviderDriver interface
      claude-code.ts              # Claude Code output parser
      codex.ts                    # Codex CLI output parser
      aider.ts                    # Aider output parser
      cursor.ts                   # Cursor CLI output parser
      generic.ts                  # Fallback regex parser
  package.json                    # bin: { ah: "./dist/cli.js", ah-hook: ... }
  README.md
```

### 3.2 Server Side (ALREADY BUILT)

```
server/
  ide-bridge.ts                   # ✅ EXISTS — 415-line IdeBridge class
                                  # Session store, WS handlers, org sharing,
                                  # agent context injection, velocity snapshots,
                                  # sprint board branch matching
  ide-pairing.ts                  # Pairing token generation + validation (NEW)
```

The server treats external sessions like lightweight "virtual agents" —
they get a desk slot, appear in the roster, but have no task lifecycle.
They're display-only.

**Already implemented** in `ide-bridge.ts`:
- `handleConnect()` — token verification, session creation, room broadcast
- `handleActivity()` — state updates, event accumulation, feed broadcast
- `handleDisconnect()` — grace period, cleanup, org notification
- `getSessionsForUser()` / `syncSessions()` — full sync on room join
- `getOrgSessionsForUser()` / `syncOrgSessions()` — org-level sharing
- `setVisibility()` / `getVisibility()` — privacy controls (full/branch_only/hidden)
- `getContextSummary()` — live dev context for agent system prompts
- `matchBranchToCardId()` — links git branches to sprint board task cards
- `getSnapshotsForVelocity()` — DB persistence for velocity tracking

**Pairing flow** (replaces `AH_TOKEN` env var) — NOT YET BUILT:
1. User clicks "Connect IDE" in the AH app → server generates a one-time
   pairing token (short-lived, 5 min TTL) → displays as QR code
2. User runs `ah pair <code>` in terminal → CLI exchanges pairing token
   for a session token → stores it locally for future use
3. No token copying, no env var setup. Re-pair anytime from the app.

### 3.3 Client Side (ALREADY BUILT)

- **`scene.ts`** ✅: `TerminalStation` rendering with CRT terminal desks,
  tool icons, file labels, status glows. `WallDashboard` for aggregate
  stats. Syncs on personal + org session changes.
- **`hud.ts`** ✅: "🖥️ IDE" button in topbar. `openIdeBridgePanel()` with
  active sessions, connection instructions, privacy settings, terminal
  station toggle, velocity trends, standup summaries.
- **`store.ts`** ✅: `externalSessions` + `orgExternalSessions` Maps, all
  WS handlers (sync, update, remove, feed events), `ideBridgeVisibility`
  state, `showTerminalStations` toggle.
- **`net.ts`** ✅: Bridge message types in `SILENT_MSG_TYPES`.

### 3.4 Data Flow

```
VS Code / Cursor / Windsurf          Claude Code          Codex / Aider
  ↓ (extension)                        ↓ (hooks)           ↓ (ah watch / ah wrap)
  ↓ WebSocket                           ↓ WebSocket          ↓ WebSocket
  ↓                                     ↓                    ↓
  └────────────── AH Server (ide-bridge.ts) ─────────────────┘
                    ↓ Broadcasts to room
                    ↓
              AH Client (scene.ts + store.ts)
                    ↓ Renders contractor desk / terminal station
                    ↓ Adds events to office feed
                    ↓ Makes context available to agent system prompts
```

### 3.5 Shared Protocol (ALREADY BUILT)

Types in `shared/types.ts` (all implemented):

```typescript
type ExternalTool = "vscode" | "cursor" | "windsurf"
                  | "claude-code" | "codex" | "aider" | "unknown";

interface ExternalSession {
  sessionId: string;
  userId: string;
  tool: ExternalTool;
  state: "active" | "idle" | "error" | "disconnected";
  currentFile?: string;
  language?: string;
  gitBranch?: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  lastActivity: number;
  events: ExternalEvent[];
}

interface ExternalEvent {
  type: "file_edit" | "file_save" | "git_commit" | "git_branch"
      | "test_run" | "test_result" | "command" | "ai_completion"
      | "ai_chat" | "session_start" | "session_end" | "error";
  timestamp: number;
  file?: string;
  linesAdded?: number;
  linesRemoved?: number;
  message?: string;
  success?: boolean;
}
```

`ClientMsg` types (from bridge tools to server) — all implemented:

- `external_connect` — session start (tool, sessionId, token, currentFile, language, gitBranch)
- `external_activity` — heartbeat with current state + recent events
- `external_disconnect` — session end
- `set_ide_bridge_privacy` — change visibility level

`ServerMsg` types (server → game client) — all implemented:

- `external_session_update` — broadcast to room (terminal station state)
- `external_session_removed` — desk removed
- `external_feed_event` — office feed entry
- `external_sessions_sync` — full sync on room join
- `org_external_sessions_sync` / `org_external_session_update` /
  `org_external_session_removed` / `org_external_feed_event` — org sharing
- `ide_bridge_privacy` — current visibility setting

### 3.6 Agent Context Injection (ALREADY BUILT)

`IdeBridge.getContextSummary()` in `server/ide-bridge.ts:303` generates a
live context block from active sessions. The output looks like:

```
=== LIVE DEVELOPMENT CONTEXT ===
Your boss is currently working with external coding tools:
  • Your boss is using Claude Code (actively coding — editing src/auth.ts
    [branch: feature/auth-fix] (3 files, +127/-43 lines))
  • Your boss is using Cursor (idle — editing src/payment.ts)
You can reference what they're working on if relevant to their task.
Do NOT mention file contents — you only know metadata (file names, line
counts, git branch).
=== END LIVE DEVELOPMENT CONTEXT ===
```

This is appended to agent system prompts when external sessions are active.
Opt-in per agent (checkbox in hire dialog: "Receive external IDE context").

---

## 4. Privacy

### 4.1 Permission Modes

Inspired by T3 Code's permission modes (Supervised / Auto-accept / Auto /
Full access), but adapted for **visibility control** instead of execution
control. Users pick a mode when connecting a bridge session:

- **Full visibility** — all events streamed: file names, line counts,
  commands, git activity, test results. Default mode.
- **Metadata only** — file names + line counts + git info, but no command
  strings or terminal output. For users who want activity tracking without
  sharing what they're typing.
- **Git-only** — only branch changes, commits, and PR events. No
  file-level tracking at all. Minimalist mode.
- **Anonymous** — aggregate stats only (files changed count, total lines,
  active time). No file names, no commands, no git details. For users who
  want the wall dashboard to show "something is happening" without
  revealing what.

Mode is set via `--mode` flag: `ah watch --mode metadata-only`

### 4.2 Core Privacy Principles

- **No file content is ever sent.** Only metadata: file names, line counts,
  language, git branch, command names, exit codes.
- **All tracking is opt-in.** The extension/CLI prompts for consent on
  first run.
- **Path allowlist/blocklist.** Users can exclude directories (e.g.
  `node_modules`, `.env` files, proprietary paths).
- **Data is ephemeral.** External session state lives in memory only. It
  is not persisted to the database. Feed events follow the same retention
  as existing agent feed events. Git-ref checkpoints are local only —
  never sent to the server, only the diff stats are transmitted.
- **No AI conversation content.** We track "AI completion accepted" as a
  counter, not the content of the completion. We track "chat message sent"
  as a timestamp, not the message text.

---

## 5. Phased Plan

### Phase 0: Richer CLI Events — The Real Quick Win (~1-2 days)

**Goal**: Make the CLI tools send the rich events the pipeline already
supports. **No server, type, or client changes needed** — just upgrade
the 3 existing CLI files.

- [ ] `wrap.ts` — capture stdout instead of `stdio: "inherit"`
  - Pipe stdout/stderr through a line parser
  - Detect common patterns: file edits ("Editing src/auth.ts"), commands
    ("Running: npm test"), errors, test results ("8/8 passed", "3 failed")
  - Send rich `ExternalEvent`s for each parsed line
  - Still pass output to terminal so user sees everything normally
  - This is the **biggest single win** — unlocks `test_run`, `test_result`,
    `error`, and tool-specific events from one change
- [ ] `watch.ts` — git commit detection
  - Poll `git log --oneline -1` every few seconds (already polls branch)
  - When SHA changes, send `git_commit` event with commit message
  - Already detects branch switches — just adds commit tracking
- [ ] `hook.ts` — smarter Claude Code payload parsing
  - Claude Code hooks send structured JSON with tool name, file path, action
  - Parse the actual payload format instead of just forwarding `data.event`
  - Extract file paths, tool names, success/failure from structured fields

### Phase 1: Pairing + Checkpoints + Permission Modes (~1-2 days)

**Goal**: Smooth onboarding and better data quality. These enhance the
existing `ah-cli` package.

- [ ] `ah pair <code>` — QR pairing flow
  - `server/ide-pairing.ts` — generate short-lived pairing token (5 min TTL)
  - `ah-cli/src/pair.ts` — exchange pairing code for session token, store
    locally (`~/.ah/config.json`)
  - AH app UI: "Connect IDE" button → QR code modal
  - Replaces `AH_TOKEN` env var entirely (kept as fallback for CI/headless)
- [ ] Git-ref checkpointing in `ah-cli`
  - `ah-cli/src/checkpoint.ts` — capture `git stash create` at session
    start/end, diff the refs, send exact file-level stats
  - Works with all strategies (`ah watch`, `ah wrap`, hooks)
  - Replaces line-count estimation in `watch.ts`
- [ ] Permission modes in `ah-cli`
  - `--mode` flag: full (default), metadata-only, git-only, anonymous
  - Event filter layer in `BridgeClient` — drops/redacts events based on
    mode before sending to server
  - Mode included in `external_connect` message so server knows what to
    expect

### Already Done ✅ (was Phase 1)

Everything below was built in prior sessions and is live in production:

- [x] `server/ide-bridge.ts` — full `IdeBridge` class (415 lines)
  - WS handlers for `external_connect`, `external_activity`, `external_disconnect`
  - Session store (in-memory, per userId) with 60s grace period
  - Broadcast `external_session_update` + `external_feed_event` to room
  - `external_sessions_sync` on room join
  - Org-level session sharing with privacy filtering
  - Agent context injection via `getContextSummary()`
  - Sprint board branch matching via `matchBranchToCardId()`
  - Velocity snapshots to DB every 5 minutes
- [x] `shared/types.ts` — all types implemented
  - `ExternalTool`, `ExternalSession`, `ExternalEvent`, `OrgExternalSession`
  - `IdeBridgeVisibility` (full / branch_only / hidden)
  - All `ClientMsg` and `ServerMsg` types
- [x] `client/src/store.ts` — `externalSessions` + `orgExternalSessions`
  state, all WS handlers
- [x] `client/src/game/scene.ts` — `TerminalStation` rendering + `WallDashboard`
- [x] `client/src/ui/hud.ts` — "🖥️ IDE" button + full bridge panel
- [x] `client/src/net.ts` — bridge message types in `SILENT_MSG_TYPES`
- [x] `ah-cli` package — `watch.ts`, `wrap.ts`, `hook.ts`, `hook-cli.ts`,
  `ws-client.ts` (basic versions, Phase 0 enhances these)

### Phase 2: Provider Drivers + VS Code Extension (~3-4 days)

**Goal**: Per-tool parsing for richer `ah wrap` output, IDE users via
extension.

- [ ] Provider driver system in `ah-cli`
  - `ah-cli/src/drivers/types.ts` — `ProviderDriver` interface
  - `claude-code.ts`, `codex.ts`, `aider.ts`, `cursor.ts`, `generic.ts`
  - `ah wrap` uses driver based on command name (auto-detect) or `--tool`
  - Each driver parses its tool's stdout for file edits, commands, test
    results, errors
  - Builds on Phase 0's stdout capture — drivers replace the generic
    line parser with tool-specific patterns
- [ ] `ah-bridge` VS Code extension
  - Activity tracker (file open/edit/save, cursor, language)
  - Git tracker (branch, commits, staged files)
  - Terminal tracker (commands, test results)
  - AI tracker (completion accepted/rejected, chat messages)
  - WS client with auto-reconnect + pairing flow
  - Settings UI: enable/disable tracking, path allowlist/blocklist,
    permission mode selector
- [x] Wall dashboard in scene — **ALREADY BUILT**
  - Aggregate stats: files, lines, languages, time, git activity
  - Per-tool breakdown
  - Syncs on personal + org session changes
- [x] Agent context injection — **ALREADY BUILT**
  - `IdeBridge.getContextSummary()` appends external context to agent
    system prompts on task assign

### Phase 3: Source Control + AI Interaction Tracking (~2-3 days)

**Goal**: PR events in the feed, AI-vs-human dynamic visible.

- [ ] Source control integration
  - `ah watch` polls `git log --remotes` for new pushes
  - `ah wrap` detects `gh pr create` / `gh pr review` calls
  - Server polls GitHub API (existing OAuth) for open PRs on current branch
  - PR events in office feed + wall dashboard open PRs panel
  - GitLab/Bitbucket support follows same pattern
- [ ] VS Code extension: detect Cursor/Windsurf/Copilot AI completions
  - Intercept `onDidAcceptCompletion` / inline completion events
  - Track accepted/rejected counts
  - Detect chat panel messages (Cursor chat, Windsurf chat, Copilot chat)
- [ ] "AI assists" counter on contractor desk
- [ ] Wall dashboard: AI vs manual code ratio
- [ ] Achievements
  - "100 AI completions accepted"
  - "Paired with Cursor for 4 hours"
  - "Used 3 different AI tools in one session"
  - "Claude Code + AH agent collaboration: 10 tasks completed"
- [ ] Aspiration signal integration
  - External tool usage feeds into aspiration profiling
  - "Explorer" signal for trying new AI tools
  - "Builder" signal for lines shipped via external tools

### Phase 4: Multi-Session + Social (~2-3 days)

**Goal**: Multiple tools, multiple sessions, social visibility.

- [ ] Multiple external sessions = multiple terminal stations / contractor
  desks
- [ ] Other users visiting your office can see your active external work
  (read-only, same as visiting a trophy room)
- [ ] Cross-tool analytics: Claude Code vs Codex vs your AH agents — who
  ships more?
- [ ] "Pair programming" mode: share IDE context with an AH agent for
  collaborative tasks on the same codebase
- [ ] External tool leaderboard (opt-in): most lines shipped, most tests
  passed, longest active session

---

## 6. Key Design Decisions

### 6.1 Desk Placement

Contractor desks and terminal stations do **not** take a regular agent desk
slot. They get their own zone (e.g. near the window or in a dedicated
"contractor area"). This way hiring 8 agents doesn't block external
visibility.

### 6.2 Session Lifecycle

- External sessions are **ephemeral** — they exist only while the bridge
  tool is connected. Disconnect = desk disappears.
- No persistence: external session data is never saved to `ag/save.json`
  or the database. It's pure runtime state.
- Reconnection: if the WS connection drops, the bridge tool retries with
  exponential backoff. The server keeps the session alive for 60s grace
  period before removing the desk.

### 6.3 Authentication

**Primary: QR Pairing** (inspired by T3 Code's `t3 pair`). User clicks
"Connect IDE" in the AH app → gets a QR code → runs `ah pair <code>` in
terminal. The CLI exchanges the pairing code for a session token and
stores it locally (`~/.ah/config.json`). No token copying, no env var
setup.

**Fallback: `AH_TOKEN` env var**. For CI/headless setups where QR pairing
isn't practical. Set `AH_TOKEN` to the Supabase auth token (same as the
game client). The `ah-cli` package reads it automatically.

**Token refresh**: The stored session token is a Supabase JWT with a
refresh token. The CLI refreshes automatically when the token expires.

### 6.4 Performance

- Activity reports throttled to **1/sec max** from bridge tools
- Only deltas are sent (what changed since last heartbeat)
- Server broadcasts to room at most **2/sec** (batched updates)
- Client renders terminal stations with the same delta-reconciliation
  pattern used for agent monitors

### 6.5 Extension Distribution

- **VS Code Marketplace**: for VS Code users
- **Cursor**: Cursor has its own extension marketplace; may need to
  publish there separately or provide side-loading instructions
- **Windsurf**: Same situation as Cursor
- **Initial approach**: Side-loading via `.vsix` file + instructions in
  README. Marketplace publishing once the feature is stable.

---

## 7. Why This Is Worth Building

1. **Bridges the gap**: Users don't have to choose between Cursor and
   Agent Heights — both coexist
2. **Makes the office feel alive**: Your real work reflected in the game
   world, not just agent work
3. **Agent context**: Agents become dramatically more useful when they
   know what you're working on
4. **Differentiator**: No other AI agent platform has a visual command
   center for your entire dev workflow
5. **Onboarding hook**: "Connect your IDE" is a natural second step after
   "hire your first agent"
6. **Retention**: The office becomes the dashboard you keep open all day,
   even when you're not actively managing agents
7. **Claude Code hooks are the best integration surface**: Zero friction,
   richest data, covers the most technical users first

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Privacy concerns** | No file content, only metadata. Opt-in with clear messaging. Path allowlist/blocklist. Ephemeral data. |
| **Extension marketplace fragmentation** | Start with side-loading `.vsix`. Publish to each marketplace once stable. |
| **Performance overhead** | Throttle to 1/sec. Delta-only updates. Server batches broadcasts. |
| **CLI tool output format changes** | Per-tool driver parsers are best-effort. `ah watch` (file watching) is format-agnostic and always works as fallback. Generic driver catches unknown tools. |
| **Auth token management** | QR pairing for normal use. `AH_TOKEN` env var for CI/headless. Supabase JWT with auto-refresh. No separate credentials. |
| **Git-ref checkpoint conflicts** | Use `git stash create` (non-destructive, doesn't touch working tree). Clean up refs on session end. Skip checkpointing if not in a git repo. |
| **Desk clutter** | External desks in their own zone. Max 4 visible at once; overflow collapses into a summary. |
