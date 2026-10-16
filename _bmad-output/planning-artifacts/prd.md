---
title: 'Switchboard — Product Requirements'
status: 'draft'
created: '2026-10-16'
inputDocuments:
  - _bmad-output/planning-artifacts/product-brief.md
  - docs/research/claude-code-integration.md
---

# Switchboard — PRD

Requirements are numbered `FR-<area>-<n>` so epics and specs can cite them. "Must" is v1; "Should" is v1 if cheap, otherwise v1.x; "Later" is recorded so it is not re-argued.

## 1. Users and jobs

**Operator (Emils).** Jobs: see what is running; start a session in the right place with the right options; connect sessions to dirs and to each other; answer prompts; review results; tidy up (stop, remove worktrees).

**Agent (Claude, inside a session).** Jobs: know the workspace around it; start a sibling session for a parallel task; message a peer; report status; ask for review.

## 2. Functional requirements

### 2.1 Workspace and canvas (`FR-CANVAS`)

| ID | Req | Level |
|---|---|---|
| FR-CANVAS-1 | One workspace per app instance, persisted to disk, restored on launch (nodes, positions, edges, viewport, collapse state). | Must |
| FR-CANVAS-2 | Infinite pannable/zoomable canvas. Pan: space+drag or middle button; zoom: wheel/ctrl+wheel; fit-to-view shortcut. | Must |
| FR-CANVAS-3 | Node types: **project**, **session**, **branch**. Project nodes are top-level; session and branch nodes are children shown when the project is expanded and hidden (collapsed into a count badge) otherwise. | Must |
| FR-CANVAS-4 | Add a project by folder picker, by drag-dropping a folder onto the canvas, or by importing from Claude's known project list (`~/.claude/projects`). | Must |
| FR-CANVAS-5 | Child nodes auto-layout under their parent; the operator can drag any node; positions persist. | Must |
| FR-CANVAS-6 | Keyboard: arrow keys move selection between nodes; Enter opens; `n` new session; `e` start edge; `/` command palette; Esc closes panes. | Must |
| FR-CANVAS-7 | Command palette (`ctrl+k`) for every action a menu would have. The app has no menu bar. | Must |
| FR-CANVAS-8 | Multiple workspaces (switch between saved graphs). | Later |

### 2.2 Project nodes (`FR-PROJ`)

| ID | Req | Level |
|---|---|---|
| FR-PROJ-1 | Shows label (folder name, editable), path, git state (current branch, dirty count) and a live-session count badge. | Must |
| FR-PROJ-2 | Detects whether the folder is a git repo; non-git folders still work as plain project nodes (sessions only, no branch children). | Must |
| FR-PROJ-3 | Context actions: new session, open terminal (plain shell), open in external editor, open in file manager, reveal Claude project dir, remove from canvas. | Must |
| FR-PROJ-4 | A project node glows/animates when any child session changes to *waiting* or *finished*, even when collapsed. | Must |

### 2.3 Session nodes and lifecycle (`FR-SESS`)

| ID | Req | Level |
|---|---|---|
| FR-SESS-1 | List historic sessions for a project from Claude's transcript store, with title, last-active time, branch, message count. Hidden by default past the most recent 10; "show all" expands. | Must |
| FR-SESS-2 | Live session state per node: `starting`, `busy`, `idle`, `waiting` (permission or question pending), `finished` (turn ended, nothing pending), `exited`. Source: hooks endpoint first, `claude agents --json` as baseline. | Must |
| FR-SESS-3 | Start a **new** session on a project or branch node with a launch sheet: name, model (fable/opus/sonnet/haiku or custom), effort, permission mode, extra `--add-dir`s (prefilled from context edges), initial prompt (optional), start-in-background toggle. Remembers last choices per project. | Must |
| FR-SESS-4 | **Resume** a historic session (same id) or **fork** it (new id) from its node. | Must |
| FR-SESS-5 | **Adopt** a live session that was started outside the app (visible in `claude agents --json`) as a node, read-only (no terminal) until the operator attaches via `claude attach` in a new terminal pane. | Should |
| FR-SESS-6 | Stop a session (SIGINT/`/exit` then kill after timeout). Exited sessions stay as historic nodes. | Must |
| FR-SESS-7 | Session node shows: name, status, model, elapsed since last event, last assistant line (truncated), unread-peer-messages badge. | Must |
| FR-SESS-8 | Every app-launched session gets: a stable session id chosen by the app (`--session-id`), a display name (`--name`), the Switchboard MCP server (`--mcp-config`), status hooks (`--settings`), and a short appended system prompt describing its node, peers and the MCP tools. | Must |
| FR-SESS-9 | Pin/unpin a historic session so it is always shown. Rename (local label; does not rename Claude's title). | Should |
| FR-SESS-10 | Cost/token summary per session from transcript usage records. | Later |

### 2.4 Terminal (`FR-TERM`)

| ID | Req | Level |
|---|---|---|
| FR-TERM-1 | Each live session has a PTY-backed terminal (xterm.js) running the real `claude` TUI. Opens in the side pane when its node is selected; multiple terminals may be open as tabs. | Must |
| FR-TERM-2 | Full fidelity: colors, cursor, mouse where Claude Code uses it, paste (incl. multi-line and images via Claude's own paste handling), resize. | Must |
| FR-TERM-3 | Terminal keeps running when its tab is hidden; scrollback ≥ 5 000 lines. | Must |
| FR-TERM-4 | "Plain shell" terminal on any project node (PowerShell on Windows, `$SHELL` on Linux). | Must |
| FR-TERM-5 | Pop a terminal out into its own window. | Should |
| FR-TERM-6 | Search in terminal; copy on select option. | Should |

### 2.5 Branches and worktrees (`FR-BRANCH`)

| ID | Req | Level |
|---|---|---|
| FR-BRANCH-1 | Branch children of a git project node: local branches, marking current, ahead/behind upstream, and whether a worktree exists for it (with path). | Must |
| FR-BRANCH-2 | Create a worktree node: pick branch (existing or new from base) → `git worktree add` under a configurable worktrees root (default `<repo>/.worktrees/` or Claude's own location when `--worktree` is used). | Must |
| FR-BRANCH-3 | Start a session on a branch node. If it has a worktree, cwd is the worktree; otherwise offer to create one or use `claude --worktree <name>`. | Must |
| FR-BRANCH-4 | Remove a worktree (refuse if dirty unless forced); delete branch option. | Must |
| FR-BRANCH-5 | Sessions discovered in a worktree path are attached to that branch node, not the project root. | Must |
| FR-BRANCH-6 | Remote branches, fetch/pull/push actions. | Later |

### 2.6 Edges (`FR-EDGE`)

| ID | Req | Level |
|---|---|---|
| FR-EDGE-1 | Two kinds: **context** (session or project → project/branch/folder: "may work in there") and **cooperate** (session ↔ session). Drawn differently. | Must |
| FR-EDGE-2 | Create by drag from a node handle, or via palette ("link to…"). Delete by select + Del. | Must |
| FR-EDGE-3 | Context edge on a **not yet started** session (or on a project node, as a default for its future sessions) becomes `--add-dir` at launch. | Must |
| FR-EDGE-4 | Context edge added to a **live** session: the app injects `/add-dir <path>` into its terminal when the session is idle, and shows a "pending" edge until confirmed; the fallback action is "restart with flags" (resume same id with new `--add-dir`). | Should |
| FR-EDGE-5 | Cooperate edge: each session learns the other's name and node, and gets the peer-messaging tools (see FR-MCP-4). For live sessions this is delivered as a one-line notice via the MCP inbox and a short injected prompt when idle. | Must |
| FR-EDGE-6 | Edge inspector: shows what the edge currently means (flags applied / pending / failed). | Should |
| FR-EDGE-7 | Edge label with free text (shown to both sessions as the stated purpose of the link). | Should |

### 2.7 The app as a tool for Claude (`FR-MCP`)

| ID | Req | Level |
|---|---|---|
| FR-MCP-1 | The app runs an MCP server over HTTP on localhost with a per-launch bearer token; every launched session gets it in `--mcp-config` under the name `switchboard`. | Must |
| FR-MCP-2 | Tools (read): `workspace()` graph summary; `node(id)`; `my_node()`; `peers()`; `sessions(project)`. | Must |
| FR-MCP-3 | Tools (act): `start_session({project|branch, prompt, name, model, effort, permissionMode, addDirs, cooperateWithMe})`; `link(from,to,kind,label)`; `unlink`; `set_status(text)` (free-text status line shown on the node); `request_review({summary, paths?})` → operator toast + review pane. | Must |
| FR-MCP-4 | Peer messaging: `send(peer, text)`, `inbox()` (drain), plus an optional `notify` hook: when a peer message arrives for an **idle** session the app injects a short nudge ("You have 1 message from <peer>; call `switchboard.inbox`.") into its terminal. Native Claude Code local-session messaging (`ListAgents`/`SendMessage`) is documented to each session as the first choice; the inbox is the structured fallback. | Must |
| FR-MCP-5 | Every act tool is permission-gated by the app: a toast "Session X wants to start a session on Y — Allow / Deny / Always for this edge". Configurable per workspace to auto-allow. | Must |
| FR-MCP-6 | `open_in_review(path|diff spec)` lets a session put something in front of the operator. | Should |
| FR-MCP-7 | Resources: `switchboard://workspace` (graph as JSON), `switchboard://node/<id>/notes` (shared scratch notes per node). | Should |

### 2.8 Review (`FR-REVIEW`)

| ID | Req | Level |
|---|---|---|
| FR-REVIEW-1 | Review pane for any project/branch/session node: diff of working tree vs HEAD; staged vs unstaged toggle; branch vs base (`merge-base`); a single commit. | Must |
| FR-REVIEW-2 | Side-by-side and unified diff, syntax highlighted (CodeMirror 6 + `@codemirror/merge`), word-level intra-line diff, collapse unchanged. | Must |
| FR-REVIEW-3 | File tree of changed files with +/− counts; whole-repo file tree browse (read-only viewer). | Must |
| FR-REVIEW-4 | "Open in external editor" at file:line (configurable command, default `code -g {file}:{line}` if present). | Must |
| FR-REVIEW-5 | Session-scoped diff: files touched by *this session* (from transcript tool calls) highlighted in the tree. | Should |
| FR-REVIEW-6 | Leave a comment on a diff line → sent to the session as a message (via inbox or terminal injection). | Should |
| FR-REVIEW-7 | Stage/commit from the pane. | Later |

### 2.9 Settings and platform (`FR-SYS`)

| ID | Req | Level |
|---|---|---|
| FR-SYS-1 | Settings file (JSON, human-editable) + a minimal settings pane: claude binary path (auto-detected), default model/effort/permission mode, worktrees root, external editor command, theme, poll intervals. | Must |
| FR-SYS-2 | Windows 11 (x64) and Linux (x64; X11 and Wayland) builds; installers: NSIS/MSI and AppImage + .deb. | Must |
| FR-SYS-3 | Single instance; a second launch focuses the first. | Must |
| FR-SYS-4 | Notifications (OS toast) for `waiting`, `finished`, review requests; toggle per kind. | Should |
| FR-SYS-5 | Tray icon with live-session summary; close-to-tray option. | Should |
| FR-SYS-6 | Auto-update. | Later |

## 3. Non-functional requirements

| ID | Req |
|---|---|
| NFR-1 | Cold start to interactive canvas < 1 s on the dev machine; < 2 s on a cold Linux laptop. |
| NFR-2 | Idle RSS < 150 MB for the app with 5 projects, 3 live sessions and their terminals open (excluding the `claude` processes themselves). |
| NFR-3 | Terminal input latency indistinguishable from Windows Terminal / a native terminal for typing (target < 16 ms added). |
| NFR-4 | Status change on a node visible within 1 s of the hook firing, within one poll interval (default 2 s) when only `agents --json` is available. |
| NFR-5 | The app never writes into Claude's own state directory (`~/.claude`) except through the `claude` CLI; it only reads transcripts. |
| NFR-6 | Degrades gracefully when the Claude CLI changes: unknown transcript record types are ignored; a failed `agents --json` parse falls back to process-level status; a version mismatch is shown, not fatal. |
| NFR-7 | Everything the UI can do, the palette can do; everything the palette can do has a keybinding or is bindable. |
| NFR-8 | No telemetry, no network calls except what `claude` itself makes and the localhost MCP/hooks endpoints. |

## 4. UX principles

1. **The canvas is the home screen.** No welcome page, no sidebar tree, no tabs row above it. Panes slide in from the right (terminal/review) and go away with Esc.
2. **Status is ambient.** Colour and a subtle pulse on the node, never a modal. The one exception is permission requests from agents to the app (FR-MCP-5), which are toasts with inline buttons.
3. **Low chrome.** 1-px borders, monochrome icons, one accent colour that is the "attention" colour. No gradients, no cards-within-cards. Typography: a UI sans + a monospace, both system-available or bundled once.
4. **Terminal is the chat.** We style around it, never over it.
5. **Agent-legible.** Everything shown to the human has a JSON twin available through MCP; node labels and statuses are plain text.

## 5. Out of scope (recorded)

File editing; LSP; debugging; other agents; macOS testing; cloud/remote sessions; multi-user; marketplace/plugins for the app itself; re-implementing Claude Code's chat rendering.

## 6. Open questions

| # | Question | Proposed answer | Decide by |
|---|---|---|---|
| Q1 | Does `claude agents --json` expose "waiting on permission", or only busy/idle? | Assume busy/idle only; hooks (`Notification`, `Stop`, `PermissionRequest` if present) are the primary status channel. Verify in Epic 3. | Epic 3 |
| Q2 | Is `/add-dir` injection into the TUI reliable enough to ship, or is "restart with flags" the only honest path? | Ship both; injection marked experimental. | Epic 6 |
| Q3 | Do local sessions see each other through `ListAgents`/`SendMessage` by `--name`? | Expected yes (tool description says "other local Claude sessions on this machine"). If not, the MCP inbox is primary. | Epic 6 |
| Q4 | React vs Svelte for the frontend. | React 19 + `@xyflow/react` (mature graph lib, best Claude fluency). | Architecture (decided, revisit only if bundle/perf fails NFR-1/2) |
| Q5 | Worktree root: Claude's own (`--worktree`) location vs app-managed `.worktrees/`. | App-managed by default so the node ↔ path mapping is ours; still recognise sessions launched with `--worktree`. | Epic 5 |
| Q6 | Should the app ever auto-start sessions (e.g. on review request → open a reviewer session)? | Not in v1; agent-initiated starts go through FR-MCP-5 approval. | — |
