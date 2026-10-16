---
title: 'Switchboard — Architecture'
status: 'draft'
created: '2026-10-16'
inputDocuments:
  - _bmad-output/planning-artifacts/product-brief.md
  - _bmad-output/planning-artifacts/prd.md
  - docs/research/claude-code-integration.md
---

# Switchboard — Architecture

## 1. Decisions (ADR-style, short)

| # | Decision | Why | Alternatives rejected |
|---|---|---|---|
| A1 | **Tauri 2** shell: Rust core, web UI in the OS webview (WebView2 on Windows, webkit2gtk on Linux). | Hits NFR-1/2 (small binary, low idle RAM); Rust is the right place for PTYs, process supervision, git and an HTTP server; cross-platform from one tree. | Electron (RAM/size), native Rust GUI (graph + terminal + diff would all be hand-built). |
| A2 | **Terminal-first Claude integration.** Sessions run the real `claude` TUI in a PTY; the app observes via hooks, `claude agents --json`, and transcripts; it acts via launch flags, MCP and (sparingly) PTY injection. | G4 "nothing lost"; the CLI moves fast and we do not want to chase its chat UI. | Custom chat UI on `-p --output-format stream-json` (reimplements permissions, slash commands, plugins). Kept as a later option: the stream-json protocol is stable and the same launch recipe applies. |
| A3 | **Headless Claude work is done by spawning `claude -p`** from Rust (stream-json in/out), not by embedding the TypeScript Agent SDK. | No Node sidecar; one runtime (the CLI) for everything. | Node sidecar with `@anthropic-ai/claude-agent-sdk` — revisit if we need SDK-only features. Docs: code.claude.com/docs/en/agent-sdk. |
| A4 | **In-app MCP server over HTTP (localhost, bearer token)**, declared to each session via `--mcp-config`. | One server, many sessions; no per-session stdio bridge process; tool calls land in the running app's state directly. | stdio MCP binary bridging to the app over a named pipe (extra process per session, more moving parts). |
| A5 | **Status via Claude Code hooks → localhost HTTP** (`--settings` JSON per session), `agents --json` polled as a baseline. | Push, sub-second, carries the event type (permission prompt, stop, notification). | Parsing the PTY byte stream (fragile), tailing transcripts only (laggy, format is internal). |
| A6 | **Git via the `git` CLI** (subprocess), parsed from porcelain/plumbing output. | Worktrees, merge-base, diffs with the user's exact git config and credentials; zero native build pain on Windows. | `git2`/`gix` crates (faster status, but worktree/diff feature gaps and build friction). May add `gix` later for status polling. |
| A7 | **Frontend: React 19 + TypeScript + Vite**, graph with `@xyflow/react`, terminal with `@xterm/xterm`, diff with CodeMirror 6 + `@codemirror/merge`, state with Zustand. | Mature graph library with custom nodes/edges/handles; xterm is the only serious embedded terminal; CodeMirror is far lighter than Monaco for a read-only diff. | Svelte 5 + `@xyflow/svelte` (fine, slightly less mature); Monaco (heavy). |
| A8 | **Persistence: one JSON workspace file + one JSON settings file**, atomic writes, schema-versioned. | Tiny data; human-editable; trivially diffable. | SQLite (overkill for v1; adopt if session/usage history gets indexed). |
| A9 | **Session identity is app-assigned** (`--session-id <uuid>`) for every session the app starts. | The node knows its transcript path and `agents --json` row before the first byte is written. | Discovering the id after the fact by tailing the project dir. |

## 2. System overview

```
┌──────────────────────────── Switchboard (Tauri 2 process) ────────────────────────────┐
│  WebView (React)                                 Rust core (tokio)                     │
│  ┌──────────────┐ ┌───────────┐ ┌──────────┐    ┌───────────┐ ┌──────────┐ ┌────────┐ │
│  │ Canvas       │ │ Terminal  │ │ Review   │    │ graph     │ │ pty      │ │ git    │ │
│  │ @xyflow      │ │ xterm.js  │ │ CM6 diff │    │ model+io  │ │ portable │ │ cli    │ │
│  └──────┬───────┘ └─────┬─────┘ └────┬─────┘    └─────┬─────┘ └────┬─────┘ └───┬────┘ │
│         └───────────────┴────────────┴── Tauri IPC ───┴────────────┴───────────┘      │
│                                                   ┌───────────┐ ┌──────────┐ ┌────────┐│
│                                                   │ claude    │ │ mcp      │ │ hooks  ││
│                                                   │ discovery │ │ server   │ │ http   ││
│                                                   │ + launch  │ │ (rmcp)   │ │ (axum) ││
│                                                   └─────┬─────┘ └────┬─────┘ └───┬────┘│
└─────────────────────────────────────────────────────────┼────────────┼───────────┼─────┘
                                                          │            │ 127.0.0.1:<port>
            ~/.claude/projects/**.jsonl  (read-only) ◄────┤            │           │
            `claude agents --json` (poll) ◄───────────────┤            │           │
                                                          ▼            ▼           │
                                     ┌─────────────────────────────────────────────┴──┐
                                     │  claude (TUI in PTY)  × N                       │
                                     │   --session-id --name --mcp-config --settings   │
                                     │   --add-dir … --model … --effort …              │
                                     └─────────────────────────────────────────────────┘
```

One OS process for the app; one child `claude` process per live session (plus whatever `claude` spawns). All app↔Claude traffic is localhost HTTP initiated by Claude (MCP calls, hook POSTs) or subprocess I/O initiated by the app.

## 3. Rust core modules (`src-tauri/src/`)

| Module | Responsibility | Key crates |
|---|---|---|
| `graph/` | Workspace model (`Project`, `BranchNode`, `SessionRef`, `Edge`), load/save with schema version + atomic write, derived view (what children to show), edge semantics resolver (→ launch flags / live actions). | `serde`, `serde_json`, `tempfile` |
| `claude/discover.rs` | Encode cwd → `~/.claude/projects/<encoded>`; list transcripts; parse the first `user` record (cwd, gitBranch, sessionId, timestamp, version) and title records; cache by mtime. Poll `claude agents --json --all` for live rows. | `tokio::process`, `notify` (fs watch) |
| `claude/launch.rs` | Build the argv/env for a session from node + edges + launch sheet; create PTY; register in live table; write the per-session `--settings` hooks JSON and `--mcp-config` JSON to the app's temp dir. | — |
| `claude/hooks.rs` | `axum` router on the app port: `POST /hooks/<token>/<event>` → status machine for the session; `Notification` (permission prompt / idle), `Stop`, `SessionStart`, `SessionEnd`, `PreToolUse` (optional, for "files touched"). | `axum`, `tower` |
| `claude/headless.rs` | `claude -p --output-format stream-json` runner for helper jobs (e.g. "summarise this transcript into a 6-word node label"). Budgeted with `--max-budget-usd`. | — |
| `pty/` | `portable-pty` sessions: spawn with cwd/env, resize, write, read loop → Tauri events (`pty://<id>/data`, chunked, backpressure by coalescing). Scrollback is the frontend's job. | `portable-pty` |
| `git/` | `git` subprocess wrappers: `rev-parse`, `branch --format`, `for-each-ref`, `worktree list --porcelain`, `status --porcelain=v2`, `diff` (with `--numstat` and raw), `merge-base`, `show`. All return typed structs. | `tokio::process` |
| `mcp/` | `rmcp` server exposing the tools in PRD §2.7 over streamable HTTP, bearer token per session; maps the token → session node so `my_node()`/`peers()` are implicit. Act tools go through `approvals` (toast → oneshot). | `rmcp` |
| `approvals/` | Pending agent requests, policy (`ask` / `allow for edge` / `allow all`), emits UI events, resolves futures. | — |
| `settings/` | Settings JSON, binary detection (`claude`, `git`, external editor), platform paths (`dirs`). | `dirs` |
| `ipc/` (Tauri commands) | Thin: each command validates and delegates to a module; all long-lived state is in a `AppState` behind `tokio::sync::RwLock`/channels. Events pushed to the webview via `app.emit`. | `tauri` |

### 3.1 Session launch recipe

```
cwd = node.path (project root or worktree path)
argv = claude
  --session-id <uuid-v4>              # app-assigned (A9); omitted when resuming
  [--resume <id> [--fork-session]]
  [--worktree <name>]                 # only when the operator chose "Claude-managed worktree"
  --name <label>
  --model <m> --effort <e> --permission-mode <pm>
  [--add-dir <d1> <d2> …]             # resolved from context edges + launch sheet
  --mcp-config <tmp>/<id>.mcp.json    # {"mcpServers":{"switchboard":{"type":"http","url":"http://127.0.0.1:PORT/mcp","headers":{"Authorization":"Bearer <tok>"}}}}
  --settings   <tmp>/<id>.settings.json  # hooks → http://127.0.0.1:PORT/hooks/<tok>/<event>
  --append-system-prompt "<node context>"  # ~10 lines: node id/path, peers (names + purpose), 'prefer SendMessage to peers; switchboard MCP has inbox/start_session/request_review'
  [<initial prompt>]
env += SWITCHBOARD_NODE=<nodeId>, SWITCHBOARD_PORT, TERM=xterm-256color, COLORTERM=truecolor
```

Hook commands are `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- <url>` — `curl.exe` ships with Windows 11 and every Linux we target. The hooks JSON only wires events we consume; it does not touch the user's own hooks (settings layers merge).

### 3.2 Status state machine

```
starting ──SessionStart/first PTY output──► idle
idle ──UserPromptSubmit / PTY input Enter──► busy
busy ──Notification(permission_prompt|elicitation)──► waiting
waiting ──PostToolUse / any busy signal──► busy
busy ──Stop──► finished (sticky until next input, then busy)
any ──process exit──► exited
fallback: agents --json {busy,idle} overrides when no hook seen for > 2 polls
```

### 3.3 Edge semantics

| Edge | Target not started | Target live |
|---|---|---|
| context (S→dir) | `--add-dir dir` | inject `/add-dir dir` when `idle` (experimental), else "restart with flags": stop + `--resume <id>` with the new `--add-dir` |
| context (P→dir) | default `--add-dir` for sessions started on P | — |
| cooperate (S1↔S2) | peer listed in both system prompts; both tokens allowed to `send` to each other | inbox notice to both; when `idle`, inject one line: `A new peer session "<name>" is linked to you (<purpose>). Use SendMessage or switchboard.inbox to coordinate.` |

PTY injection always waits for `idle`, writes text + `\r`, and times out if status does not become `busy` within 3 s (then marks the edge action failed and offers the restart path).

## 4. Frontend (`src/`)

| Area | Notes |
|---|---|
| `state/` (Zustand) | `workspace` (persisted, mirrored from Rust), `live` (sessions, statuses, approvals, inbox counts), `ui` (selection, open panes, palette). All mutations go through Tauri commands; Rust is the source of truth and emits `workspace://changed`, `live://session/<id>`. |
| `canvas/` | `@xyflow/react` with custom node components (`ProjectNode`, `SessionNode`, `BranchNode`), custom edges (`ContextEdge` dashed, `CooperateEdge` solid double-line), handles only visible on hover/keyboard focus. Layout for children: simple column under parent, stable ordering (live first, then pinned, then recent). |
| `terminal/` | One `Terminal` instance per PTY, kept mounted (display:none when hidden) to avoid re-render cost; `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-webgl` with canvas fallback (webkit2gtk may lack WebGL). Resize debounced → `pty_resize`. |
| `review/` | CodeMirror 6 `MergeView` (side-by-side) / `unifiedMergeView`; language packs loaded lazily by extension; changed-file tree with counts; "open externally" → Tauri command. |
| `palette/` | Command registry (id, title, keybinding, when-clause) — every action is registered here first; menus/buttons call the same commands. |
| `theme/` | CSS variables; dark default; one accent. No component library — a dozen primitives of our own. |

## 5. Data

### 5.1 Workspace file (`<app-config>/switchboard/workspace.json`)

```ts
type Workspace = {
  version: 1;
  viewport: { x: number; y: number; zoom: number };
  projects: Project[];
  branches: BranchNode[];        // only ones the operator placed or created
  sessions: SessionRef[];        // pins/labels/positions; discovery fills the rest
  edges: Edge[];
  defaults: LaunchDefaults;
};
type Project   = { id; path; label; position; expanded; color?; launchDefaults? };
type BranchNode= { id; projectId; name; worktreePath?; position? };
type SessionRef= { sessionId; projectId; branchId?; label?; pinned?; position? };
type Edge      = { id; from: NodeRef; to: NodeRef; kind: 'context'|'cooperate'; label?; createdAt };
type NodeRef   = { type: 'project'|'branch'|'session'|'folder'; id: string };  // folder = ad-hoc path target
```

Live state is never persisted. Discovery results (historic sessions, branch lists) are cached in memory and refreshed on fs events / timers.

Platform paths: Windows `%APPDATA%\switchboard\`, Linux `$XDG_CONFIG_HOME/switchboard/`. Per-launch temp files under the OS temp dir, deleted on session exit.

### 5.2 Reading Claude's state (read-only)

- Project dir encoding: path with `:`/`\`/`/` → `-` (observed: `B:\projects\ide` → `B--projects-ide`). Implement by observation and verify against `~/.claude/projects` listing rather than trusting the rule; fall back to scanning all project dirs for a matching `cwd` in the first record.
- Transcript `<id>.jsonl`: first `user` record has `cwd`, `gitBranch`, `sessionId`, `timestamp`, `version`; `ai-title` / custom-title records give labels; `.session-aliases` lists linked project dirs. Unknown record types are skipped (NFR-6).
- `claude agents --json --all`: `{pid, cwd, kind, startedAt, sessionId, name, status}`.

## 6. Security / safety model

- MCP and hooks endpoints bind 127.0.0.1 only; each session has its own bearer token; tokens die with the session.
- Agent act-tools require operator approval unless the workspace policy says otherwise (FR-MCP-5). Approval UI shows exactly what will run (argv).
- The app never runs `--dangerously-skip-permissions` on its own; it is a launch-sheet option the operator picks, highlighted.
- PTY injection is only ever: `/add-dir <path>` or a single plain-text line to an idle session; never multi-line scripts.
- The app does not read `~/.claude/.credentials.json` or settings with secrets; it does not need to.

## 7. Platform notes

| Concern | Windows | Linux |
|---|---|---|
| PTY | ConPTY via `portable-pty`; `claude.exe` from `~/.local/bin` | `openpty`; `claude` from PATH |
| Webview | WebView2 (present on Win 11) | webkit2gtk 4.1; test X11 and Wayland; WebGL may be off → xterm canvas renderer |
| Shell for plain terminal | `pwsh` if present, else `powershell` | `$SHELL` |
| Hooks `curl` | `curl.exe` (system) | `curl` (dep of .deb / AppImage check at startup) |
| Paths in `--add-dir` | pass as-is (Claude normalises) | — |
| Installers | NSIS + MSI (Tauri bundler) | AppImage + .deb (Tauri bundler) |
| Single instance | `tauri-plugin-single-instance` | same |
| External editor open | `tauri-plugin-opener` / configured command | same |

## 8. Repository layout

```
switchboard/
  package.json  vite.config.ts  tsconfig.json  index.html
  src/                     # React app (see §4)
  src-tauri/
    Cargo.toml  tauri.conf.json  capabilities/
    src/ main.rs lib.rs graph/ claude/ pty/ git/ mcp/ approvals/ settings/ ipc/
  docs/                    # project knowledge (BMAD project_knowledge)
    research/claude-code-integration.md
    DESIGN.md              # visual language, once Epic 2 lands
  _bmad-output/
    planning-artifacts/    # this folder
    implementation-artifacts/   # specs per story, sprint-status.yaml
```

## 9. Dev workflow

- `npm run tauri dev` for the app; `cargo test` for Rust modules (git/discovery parsers get fixture-based tests); `vitest` for store/edge-semantics logic; Playwright is **not** used in v1 — UI is checked by hand plus a `tauri-driver` smoke test later if it earns its keep.
- Windows is the primary dev box; a Linux CI job (GitHub Actions `ubuntu-latest` with webkit2gtk deps) builds and runs `cargo test` from Epic 1 onward so Linux never drifts.
- BMAD: `npx bmad-method install` into this repo at the start of Epic 1; stories become `_bmad-output/implementation-artifacts/spec-<e>-<s>-*.md` in the same shape as map-maker's.

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Claude Code internals change (transcript format, `agents --json` shape, hook names) | Discovery/status breaks | Prefer CLI-documented surfaces; tolerant parsers; version check with a banner; fixtures from several CLI versions |
| xterm.js on webkit2gtk is slow or garbles | Linux terminal unusable | Canvas renderer fallback, test early (Epic 4 has a Linux story) |
| ConPTY quirks with Claude's TUI (resize artefacts, mouse) | Windows terminal glitches | Same PTY settings Windows Terminal uses; resize debounce; Claude handles SIGWINCH |
| `/add-dir` injection unreliable | Context edges on live sessions feel broken | Mark experimental; restart-with-flags is always offered (FR-EDGE-4) |
| Approval fatigue for agent act-tools | Operator auto-allows everything | Per-edge "always allow"; sane defaults (read tools never prompt) |
| Bundle creep (Monaco-sized deps) | NFR-1/2 missed | CodeMirror not Monaco; measure bundle in CI; lazy-load review and language packs |
