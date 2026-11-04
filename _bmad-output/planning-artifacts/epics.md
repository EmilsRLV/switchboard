---
stepsCompleted: []
inputDocuments:
  - _bmad-output/planning-artifacts/product-brief.md
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
---

# Switchboard — Epic Breakdown

## Overview

Eleven epics, ordered so that every one ends with something usable on both platforms. Epics 1–4 give a
working "start and watch Claude sessions on a canvas" tool; 5–7 add branches, edges and the
agent-facing side; 8 adds review; 9 ships it; 10 puts help, the changelog and the roadmap inside the
app; 11 (added 2026-11-04) makes the app show what it can do: visible controls, hints, figures and a
first-run tour. Each story cites the PRD requirements it satisfies and becomes a spec in
`implementation-artifacts/` when picked up.

Left out on purpose (see PRD §5): editing, LSP, cloud sessions, macOS, other agents.

## Epic List

1. Shell that runs on both platforms
2. The canvas and project nodes
3. Seeing Claude's sessions
4. Running Claude in a node
5. Branches and worktrees
6. Edges: context and cooperation
7. The app as a tool for Claude
8. Review
9. Ship it
10. Help in the app
11. Learn by looking

---

## Epic 1: Shell that runs on both platforms

A Tauri 2 app that opens fast, remembers its state, and builds on Windows and Linux from one tree.
No product features yet; everything later stands on this.

### Story 1.1: Scaffold and dev loop

As the developer,
I want `npm run tauri dev` to open a blank dark window with the React app inside and `cargo test` to run,
So that every later story has a place to land.

**Acceptance Criteria:**

**Given** a fresh clone on Windows 11 with Rust 1.94 and Node 25
**When** I run `npm install` and `npm run tauri dev`
**Then** a window titled "Switchboard" opens in under 1 s after the build, dark background, no menu bar, no devtools open
**And** `cargo test` and `npx vitest run` both pass with at least one placeholder test each

**Given** the repo
**When** I look at its layout
**Then** it matches `architecture.md` §8 and BMAD is installed (`_bmad/`, `_bmad-output/`) with `project_name = switchboard`

### Story 1.2: Linux build in CI

As the developer,
I want a GitHub Actions job that builds the app and runs the tests on Ubuntu,
So that Linux support is real from day one rather than a port later. (FR-SYS-2)

**Acceptance Criteria:**

**Given** a push to any branch
**When** CI runs
**Then** `ubuntu-latest` installs webkit2gtk-4.1 and friends, runs `cargo test`, `vitest`, and `npm run tauri build -- --bundles appimage deb`, and uploads the artefacts
**And** a `windows-latest` job does the same producing NSIS and MSI

### Story 1.3: Settings and app paths

As the operator,
I want a settings file I can edit and a tiny settings pane,
So that the app finds `claude` and `git` and knows my preferences. (FR-SYS-1)

**Acceptance Criteria:**

**Given** first launch
**When** the app starts
**Then** it detects `claude` (PATH, then `~/.local/bin`) and `git`, records their versions, and writes `settings.json` to the platform config dir with the defaults from `architecture.md` §7
**And** a missing `claude` shows a non-blocking banner with the detected search path, not a crash

**Given** I edit `settings.json` on disk
**When** I save it
**Then** the app picks the change up without restart (fs watch), or shows a parse error banner naming the line

### Story 1.4: Single instance, window state, palette skeleton

As the operator,
I want launching the app twice to focus the existing window, the window to reopen where I left it, and `ctrl+k` to open a command palette,
So that the app behaves like a tool and not a web page. (FR-SYS-3, FR-CANVAS-7)

**Acceptance Criteria:**

**Given** the app is running
**When** I launch it again
**Then** the first window is focused and no second window appears

**Given** I press `ctrl+k`
**When** the palette opens
**Then** it lists the registered commands (at least "Open settings", "Quit"), filters as I type, runs on Enter, closes on Esc

---

## Epic 2: The canvas and project nodes

The home screen: an infinite canvas with project nodes you add, move, expand and act on.

### Story 2.1: Canvas with persisted viewport

As the operator,
I want an infinite canvas I can pan and zoom, which remembers where I was,
So that the workspace feels like a place. (FR-CANVAS-1, FR-CANVAS-2)

**Acceptance Criteria:**

**Given** an empty workspace
**When** I pan with space+drag or middle button and zoom with the wheel
**Then** the canvas moves smoothly (no dropped frames on a 60 Hz display with 50 nodes) and `workspace.json` records the viewport within 500 ms of the last change

**Given** I close and reopen the app
**When** the canvas appears
**Then** it is at the same viewport

### Story 2.2: Add a project node

As the operator,
I want to add a folder as a project node by picker, by dropping it on the canvas, or by importing from Claude's known projects,
So that my repos appear without typing paths. (FR-CANVAS-4, FR-PROJ-1, FR-PROJ-2)

**Acceptance Criteria:**

**Given** the canvas
**When** I run "Add project" and pick `B:\projects\guild-auth`
**Then** a node appears at the drop/centre point showing label `guild-auth`, the path, the current branch and dirty-file count, and it is a git repo so a "branches" affordance is shown

**Given** a non-git folder
**When** I add it
**Then** it appears as a project node without branch affordances and without an error

**Given** "Import from Claude"
**When** I open it
**Then** it lists the cwd of every project dir under `~/.claude/projects` that still exists on disk, with its session count, and lets me multi-select to add

### Story 2.3: Expand, collapse, drag, auto-layout

As the operator,
I want to expand a project to see its children laid out under it, collapse it back to a badge, and drag anything,
So that the graph stays readable. (FR-CANVAS-3, FR-CANVAS-5)

**Acceptance Criteria:**

**Given** a project with children (stub children allowed in this story)
**When** I expand it
**Then** children appear in a column under it in stable order; collapsing hides them and shows a count badge

**Given** I drag a child away from its column
**When** I release
**Then** it stays where I put it and does so after restart; "Re-layout children" in the context menu puts it back

### Story 2.4: Keyboard navigation and project actions

As the operator,
I want to move between nodes with the keyboard and act on a project from a context menu or the palette,
So that I rarely reach for the mouse. (FR-CANVAS-6, FR-PROJ-3)

**Acceptance Criteria:**

**Given** a selected node
**When** I press arrow keys
**Then** selection moves to the nearest node in that direction; Enter opens its default action; Esc clears

**Given** a project node
**When** I open its context menu
**Then** it offers: new session (stub until Epic 4), plain terminal (stub until Epic 4), open in external editor, open in file manager, reveal Claude project dir, remove from canvas — each also present in the palette with a `when` clause

### Story 2.5: Visual language

As the operator,
I want the canvas, nodes and panes to follow one quiet visual system,
So that the app is calm to look at for hours.

**Acceptance Criteria:**

**Given** `docs/DESIGN.md` written in this story (tokens: surfaces, 1-px borders, one accent, type scale, node anatomy, status colours)
**When** I look at the canvas with five projects
**Then** every element uses the tokens; there are no gradients, no drop shadows beyond a 1-px border, icons are monochrome, and the accent colour appears only on attention states

---

## Epic 3: Seeing Claude's sessions

Session nodes appear under projects from Claude's own records, and live sessions show their status.

### Story 3.1: Historic sessions from transcripts

As the operator,
I want each project to show its past Claude sessions with title, time and branch,
So that I can find and resume work. (FR-SESS-1)

**Acceptance Criteria:**

**Given** `B:\projects\ai-novelist` with six transcripts in `~/.claude/projects/B--projects-ai-novelist`
**When** I expand the node
**Then** the ten most recent sessions appear as session nodes with title (from the title record, else first prompt truncated to 60 chars), last-active time, `gitBranch` and message count; "show all" reveals the rest

**Given** a transcript with record types the app does not know
**When** it is parsed
**Then** they are skipped and the session still appears

**Given** a transcript whose first user record has a `cwd` under a worktree path
**When** the project also has that worktree
**Then** the session is listed under the branch node, not the root (full behaviour in Story 5.4)

### Story 3.2: Live sessions and status

As the operator,
I want live sessions (including ones I started from a plain terminal) to show on the canvas with busy/idle status,
So that the overview is true. (FR-SESS-2, FR-SESS-5)

**Acceptance Criteria:**

**Given** `claude agents --json --all` lists a session with `cwd` matching a project node
**When** the app polls (default 2 s)
**Then** the matching session node shows `busy` or `idle` and the project badge counts it; a row with an unknown cwd is shown in a "Elsewhere" tray, not dropped

**Given** the row disappears
**When** the next poll runs
**Then** the node turns `exited` and remains as a historic node

**Given** a live session the app did not start
**When** I select it
**Then** the pane offers "Attach in terminal" (runs `claude attach <id>` in a new PTY) instead of a terminal

### Story 3.3: Status glow and notifications

As the operator,
I want a node to pulse when its session needs me and the project to glow even when collapsed,
So that I never poll terminals. (FR-PROJ-4, FR-SYS-4)

**Acceptance Criteria:**

**Given** a session goes to `waiting` or `finished`
**When** the canvas is visible
**Then** the session node shows the accent state and its collapsed parent glows; selecting the node clears the glow

**Given** notifications enabled for `waiting`
**When** the state changes while the window is unfocused
**Then** an OS toast appears naming the project and session; clicking it focuses the window and selects the node

---

## Epic 4: Running Claude in a node

Start, resume, fork and stop Claude sessions from the canvas, each in a real terminal.

### Story 4.1: PTY terminal pane

As the operator,
I want a terminal pane backed by a real PTY,
So that the Claude TUI runs unchanged. (FR-TERM-1, FR-TERM-2, FR-TERM-3, FR-TERM-4)

**Acceptance Criteria:**

**Given** a project node
**When** I run "Plain terminal"
**Then** a pane slides in with PowerShell (Windows) or `$SHELL` (Linux), 256-colour and truecolour work, resizing the pane resizes the PTY, paste works, scrollback ≥ 5 000 lines

**Given** I hide the pane
**When** the process writes output
**Then** nothing is lost; reopening shows it

**Given** the Linux build on webkit2gtk without WebGL
**When** the terminal opens
**Then** it falls back to the canvas renderer and typing latency is not perceptibly worse than a native terminal

### Story 4.2: New session launch sheet

As the operator,
I want to start a new Claude session on a node with name, model, effort, permission mode, add-dirs and optional first prompt,
So that sessions begin configured. (FR-SESS-3, FR-SESS-8)

**Acceptance Criteria:**

**Given** a project node
**When** I press `n`
**Then** a sheet shows the fields with defaults from settings/the project's last choices; Enter starts

**Given** I start
**When** the process launches
**Then** argv matches `architecture.md` §3.1: app-assigned `--session-id`, `--name`, `--mcp-config`, `--settings` (hooks), `--append-system-prompt`, chosen flags; a session node appears immediately in `starting`, the terminal pane opens on it, and within 2 s the status is `idle`

**Given** the session's transcript appears on disk
**When** discovery runs
**Then** it is matched to the existing node by session id (no duplicate node)

### Story 4.3: Hook-driven status

As the operator,
I want status to come from Claude Code hooks so `waiting` and `finished` are accurate within a second,
So that the glow means something. (FR-SESS-2, NFR-4)

**Acceptance Criteria:**

**Given** an app-launched session
**When** Claude asks for permission
**Then** the hooks endpoint receives the `Notification` and the node is `waiting` within 1 s; answering returns it to `busy`

**Given** the turn ends
**When** `Stop` fires
**Then** the node is `finished` and shows the last assistant line truncated

**Given** no hook arrives for two polls while `agents --json` says `busy`
**When** reconciled
**Then** the poll result wins and a debug counter increments (visible in settings → diagnostics)

### Story 4.4: Resume, fork, stop

As the operator,
I want to resume or fork a historic session and stop a live one,
So that the lifecycle is complete. (FR-SESS-4, FR-SESS-6, FR-SESS-7)

**Acceptance Criteria:**

**Given** a historic session node
**When** I choose Resume
**Then** `claude --resume <id>` runs in the project (or worktree) cwd with the standard app flags, and the same node becomes live

**Given** Fork
**When** it starts
**Then** `--resume <id> --fork-session --session-id <new>` runs and a new node appears linked to the original by a thin "forked from" line

**Given** a live session
**When** I choose Stop
**Then** the app sends `/exit` + Enter if idle, otherwise SIGINT/CTRL+C twice, then kills after 5 s; the node becomes `exited`

### Story 4.5: Terminal tabs and pop-out

As the operator,
I want several terminals open as tabs in the pane and the option to pop one into its own window,
So that I can watch two sessions at once. (FR-TERM-5, FR-TERM-6)

**Acceptance Criteria:**

**Given** two live sessions
**When** I select each
**Then** both terminals are tabs in the pane; switching is instant and neither loses output

**Given** "Pop out"
**When** chosen
**Then** a new OS window hosts that terminal; closing it returns the tab to the pane

---

## Epic 5: Branches and worktrees

Branch nodes under git projects; worktrees as places to run sessions.

### Story 5.1: Branch children

As the operator,
I want to see local branches under a project with current/ahead/behind and worktree markers,
So that I know where things stand. (FR-BRANCH-1)

**Acceptance Criteria:**

**Given** a git project expanded with "branches" on
**When** the list renders
**Then** each branch shows name, `*` for current, `↑n ↓m` vs upstream when it has one, and a worktree chip with the path when `git worktree list --porcelain` has it

**Given** branches change on disk
**When** `.git/refs` or `.git/packed-refs` changes
**Then** the list refreshes within 2 s

### Story 5.2: Create a worktree node

As the operator,
I want to make a worktree for an existing or new branch from the canvas,
So that parallel sessions get their own checkout. (FR-BRANCH-2)

**Acceptance Criteria:**

**Given** a project
**When** I run "New worktree" and pick branch `auth-refresh` (new, from `main`)
**Then** `git worktree add -b auth-refresh <root>/.worktrees/auth-refresh main` runs, a branch node with the worktree chip appears, and the path is excluded from the project's dirty count

**Given** the worktrees root setting
**When** it is changed
**Then** new worktrees go there; existing ones are not moved

### Story 5.3: Session on a branch

As the operator,
I want to start a session on a branch node,
So that work happens in the right checkout. (FR-BRANCH-3)

**Acceptance Criteria:**

**Given** a branch node with a worktree
**When** I press `n`
**Then** the launch sheet opens with cwd = worktree path and the session node appears under the branch

**Given** a branch node without a worktree
**When** I press `n`
**Then** the sheet offers "Create worktree here (recommended)" or "Let Claude manage it (`--worktree`)"; choosing the latter runs `claude --worktree <name>` from the repo root and the node is later matched by the session's `cwd`

### Story 5.4: Sessions follow worktrees; remove worktree

As the operator,
I want discovered sessions to land under the branch whose worktree they ran in, and to remove worktrees safely,
So that the graph mirrors disk. (FR-BRANCH-4, FR-BRANCH-5)

**Acceptance Criteria:**

**Given** a transcript whose `cwd` is a known worktree path
**When** discovered
**Then** it is listed under that branch node

**Given** "Remove worktree" on a clean worktree
**When** confirmed
**Then** `git worktree remove` runs and the node loses its chip; on a dirty worktree the action is refused with the dirty file count and a "force" option

---

## Epic 6: Edges: context and cooperation

Connect nodes and make the connection mean something to the sessions.

### Story 6.1: Draw and persist edges

As the operator,
I want to drag an edge between nodes, pick its kind, label it, and delete it,
So that relationships are explicit. (FR-EDGE-1, FR-EDGE-2, FR-EDGE-7)

**Acceptance Criteria:**

**Given** a session node
**When** I drag from its handle to a project node
**Then** a context edge (dashed) is created; dragging to another session creates a cooperate edge (solid double line); an invalid pair (project→project) is refused with a hint

**Given** an edge
**When** I select it
**Then** I can set a label and delete it with Del; both persist

### Story 6.2: Context edges at launch

As the operator,
I want context edges to become `--add-dir` when a session starts,
So that linking is how I grant directory access. (FR-EDGE-3)

**Acceptance Criteria:**

**Given** a project node with a context edge to `B:\projects\ui`
**When** I start a session on it
**Then** the launch sheet's add-dirs is prefilled with `B:\projects\ui` and argv contains `--add-dir B:\projects\ui`

**Given** a historic session node with a context edge
**When** I resume it
**Then** the same `--add-dir` is applied

### Story 6.3: Context edges on live sessions

As the operator,
I want a context edge added to a running session to take effect, or to be told honestly that it cannot,
So that edges are never decorative. (FR-EDGE-4, FR-EDGE-6)

**Acceptance Criteria:**

**Given** a live `idle` session
**When** I add a context edge to a folder
**Then** the app injects `/add-dir <path>` + Enter, the edge shows "pending", and when the session returns to `idle` with the directory accepted (detected by the hook/transcript record or a 3 s busy→idle cycle) the edge shows "applied"

**Given** injection fails or the session is `busy` for more than 60 s
**When** I open the edge inspector
**Then** it offers "Restart with flags" which stops and resumes the same session id with the new `--add-dir`

### Story 6.4: Cooperation edges

As the operator,
I want two linked sessions to know about each other and have a way to talk,
So that parallel work in two repos can be coordinated without me relaying. (FR-EDGE-5, Q3)

**Acceptance Criteria:**

**Given** two not-yet-started session nodes linked by a cooperate edge labelled "API shape for auth refresh"
**When** both start
**Then** each system prompt names the other session (`--name` value), its node path and the label, and says to prefer `SendMessage` to that session, with `switchboard` MCP `send`/`inbox` as fallback

**Given** two live sessions
**When** I link them
**Then** both inboxes receive a link notice, and each `idle` session gets the one-line injected notice from `architecture.md` §3.3

**Given** session A calls `SendMessage` to B by name
**When** B is idle
**Then** B receives it (verified manually in this story; if native messaging does not deliver, the story records it and the inbox nudge from Story 7.3 becomes primary)

---

## Epic 7: The app as a tool for Claude

Sessions can read the graph, start siblings, link, report and ask for review — with the operator approving actions.

### Story 7.1: MCP server with read tools

As Claude in a session,
I want `switchboard` MCP tools that tell me where I am and what is around me,
So that I can plan across repos. (FR-MCP-1, FR-MCP-2)

**Acceptance Criteria:**

**Given** an app-launched session
**When** it calls `switchboard.my_node`
**Then** it gets its node id, path, project, branch/worktree, peers (with labels) and its add-dirs

**Given** `workspace()`
**When** called
**Then** it returns every project with path, live-session summaries (name, status, last line) and edges, under 8 KB for a 10-project workspace

**Given** a request with a wrong or expired token
**When** it arrives
**Then** it is rejected with 401 and logged in diagnostics

### Story 7.2: Act tools with approval

As Claude in a session,
I want to start a sibling session, link nodes and set my status line, subject to the operator's approval,
So that I can delegate and report. (FR-MCP-3, FR-MCP-5)

**Acceptance Criteria:**

**Given** session A calls `start_session({project:"ui", prompt:"...", cooperateWithMe:true})`
**When** the policy is `ask`
**Then** a toast shows the exact argv with Allow / Deny / Always-for-this-edge; Allow starts the session with a cooperate edge to A and returns the new node id; Deny returns an error the agent can read

**Given** `set_status("waiting on ui's endpoint")`
**When** called
**Then** the node shows the text under its name until the next status change or a new `set_status`; no approval needed

**Given** "Always for this edge"
**When** A calls again
**Then** it runs without a toast; the policy is visible and revocable in the edge inspector

### Story 7.3: Peer inbox and nudge

As Claude in a session,
I want `send` and `inbox` tools and to be nudged when a message arrives while I am idle,
So that cooperation works even without native session messaging. (FR-MCP-4)

**Acceptance Criteria:**

**Given** A and B linked
**When** A calls `send("B", "endpoint is POST /auth/refresh, returns {token, expiresAt}")`
**Then** B's node shows an unread badge; `inbox()` from B returns the message once and clears it

**Given** B is `idle` when the message lands
**When** the nudge is enabled (default on)
**Then** the app injects `You have 1 message from "A". Call switchboard.inbox.` + Enter; B goes `busy`

**Given** A is not linked to C
**When** A calls `send("C", …)`
**Then** it is refused with "not a peer"

### Story 7.4: Request review

As Claude in a session,
I want to tell the operator "this is ready, look here",
So that review happens when it is useful. (FR-MCP-3, FR-MCP-6)

**Acceptance Criteria:**

**Given** `request_review({summary:"token refresh done", paths:["src/auth/refresh.ts"]})`
**When** called
**Then** the node shows a review flag, a toast appears, and clicking either opens the review pane (Epic 8) on that node with the listed paths selected; before Epic 8 it opens the file list only

---

## Epic 8: Review

Read-only diff and file browsing per node, with a path to the external editor.

### Story 8.1: Working-tree diff pane

As the operator,
I want to click a node and see what changed,
So that I can review without VS Code. (FR-REVIEW-1, FR-REVIEW-2, FR-REVIEW-3)

**Acceptance Criteria:**

**Given** a project or branch node with a dirty working tree
**When** I open Review
**Then** a changed-files tree with +/− counts appears; selecting a file shows a side-by-side CodeMirror merge view with syntax highlighting, word-level diff and collapsed unchanged regions; a toggle switches to unified; staged/unstaged toggle filters

**Given** a 3 000-line file with 40 hunks
**When** it opens
**Then** it renders in under 300 ms after the diff is computed

### Story 8.2: Branch and commit diffs

As the operator,
I want to diff a branch against its base or view one commit,
So that I can review a worktree's whole change. (FR-REVIEW-1)

**Acceptance Criteria:**

**Given** a branch node
**When** I choose "vs base"
**Then** the pane shows `git diff <merge-base main branch>..branch` with the base selectable; "Commits" lists the branch's commits and selecting one shows its diff

### Story 8.3: File browser and external open

As the operator,
I want to browse any file read-only and open it at a line in my editor,
So that the last mile is one click. (FR-REVIEW-3, FR-REVIEW-4)

**Acceptance Criteria:**

**Given** a node
**When** I switch the review pane to "Files"
**Then** a lazy tree of the repo appears (gitignored dimmed), files open in a read-only CodeMirror view

**Given** a diff line
**When** I press `o`
**Then** the configured editor command runs with file and line (default `code -g {file}:{line}` when `code` is on PATH; otherwise a settings prompt)

### Story 8.4: Session-touched files and line comments

As the operator,
I want files this session touched highlighted and a way to send a diff-line comment back to the session,
So that review feeds the agent. (FR-REVIEW-5, FR-REVIEW-6)

**Acceptance Criteria:**

**Given** a session node
**When** I open Review
**Then** files that appear in its transcript's Edit/Write/MultiEdit tool calls are marked in the tree

**Given** a diff line
**When** I add a comment and press ctrl+Enter
**Then** the text `Review comment on <file>:<line>: <comment>` is delivered to the session via inbox + nudge (or injected if idle), and the comment shows as sent

---

## Epic 9: Ship it

Installers, tray, polish and the performance budget.

### Story 9.1: Installers and first-run

As the operator,
I want a Windows installer and Linux packages that start clean,
So that I can put this on a second machine. (FR-SYS-2)

**Acceptance Criteria:**

**Given** the NSIS installer / AppImage / .deb from CI
**When** installed on a clean machine with `claude` present
**Then** the app launches, detects the binary, and shows the empty canvas with an "Add project" hint; with `claude` absent it shows the banner from Story 1.3

### Story 9.2: Tray and close-to-tray

As the operator,
I want a tray icon showing live-session counts and the option to keep running when the window closes,
So that sessions survive my tidying. (FR-SYS-5)

**Acceptance Criteria:**

**Given** close-to-tray on
**When** I close the window
**Then** sessions keep running, the tray icon shows the busy/waiting count, and clicking it restores the window

### Story 9.3: Performance budget

As the developer,
I want the budgets in NFR-1..3 measured and met,
So that the app stays the light tool it was meant to be.

**Acceptance Criteria:**

**Given** five projects, three live sessions with terminals open
**When** measured on the dev machine
**Then** cold start < 1 s, idle RSS < 150 MB (excluding `claude` processes), terminal typing adds < 16 ms; results are recorded in `docs/perf.md` with the method

### Story 9.4: Keybindings and palette completeness

As the operator,
I want every action in the palette and rebindable,
So that the app is keyboard-first in fact. (NFR-7, FR-CANVAS-6)

**Acceptance Criteria:**

**Given** the command registry
**When** audited
**Then** every UI button/menu item maps to a registered command; a `keybindings.json` overrides defaults; conflicts are reported in settings → diagnostics

### Story 9.5: Rendered terminal views only while shown

As the operator,
I want hidden terminals to cost no rendering memory,
So that many sessions fit the idle memory budget. (NFR-2)

**Acceptance Criteria:**

**Given** 10 stub sessions with full scrollback
**When** only one terminal is shown
**Then** hidden terminals keep a light shadow that still answers terminal queries, the shown one is rebuilt from the Rust output ring, and the measured app share drops (recorded in `docs/perf.md`)

### Story 9.6: WebView2 low memory target while idle

As the operator,
I want the app to give memory back while I am not using it,
So that NFR-2 holds with full scrollback. (NFR-2)

**Acceptance Criteria:**

**Given** the app unfocused, or focused with no input for 30 s
**When** the idle threshold passes
**Then** every app window's WebView2 memory target is Low, input or focus in any window (pop-outs included) brings Normal back at once, and Diagnostics shows the current target

---

## Epic 10: Help in the app

Help that lives where the work is: a Help pane of short guide pages written in the app's own words, a
Getting started checklist that ticks itself off as the operator really does each step, and the changelog
and roadmap shipped inside the app. All of it is Markdown in the repo (`docs/help/*.md`, `CHANGELOG.md`,
`ROADMAP.md`), bundled at build time with Vite `?raw` imports and rendered by a small safe renderer;
nothing is fetched (NFR-8) and no runtime dependency is added. No overlay tour, no coach marks, no wizard:
the canvas stays the home screen (PRD §4). *(Reversed in part on 2026-11-04: Epic 11 adds a skippable
first-run tour with spotlights and inline hints; see the sprint change proposal of that date and FR-HELP-16.
"No welcome page" and "the canvas is the home screen" stand.)* Every new action is a registry command, so it is in the palette
and bindable (NFR-7, Story 9.4). State that must outlive a run (checklist progress, the last version seen)
goes in a new app-written `state.json` beside `settings.json`, never into `settings.json` (hand-edited and
live-reloaded) or `workspace.json` (the graph).

Guide text uses the app's own terms, as the Terms page lists them: project node, session node, branch
node, worktree, context edge, cooperate edge, handle, terminal pane, tabs, pop-out, plain terminal, launch
sheet, edge inspector, review pane, import pane, settings pane, Diagnostics, command palette, toast,
attention colour.

### Story 10.1: Help pane and guide renderer

As the operator,
I want F1 (or "Help" in the palette) to open a pane of short guide pages,
So that I can look something up without leaving the app. (FR-HELP-1, FR-HELP-3, FR-HELP-4, FR-HELP-9)

**Acceptance Criteria:**

**Given** the app is running with the canvas, a pane or the palette in front
**When** I press F1 or run "Help" from the palette
**Then** a `help` pane (a new member of the `Pane` union in `src/state/ui.ts`) comes in on the right at the settings pane's width, open on **Contents**: the guide pages in order, then Getting started, Changelog and Roadmap as later stories add them; Esc and Close run `pane.close`; opening another pane closes it like every pane; it follows DESIGN.md (tokens only, no accent, prose in `--font-sans`, code and keys in `--font-mono`, no new motion) and DESIGN.md gains a "The Help pane" entry under Layout pieces

**Given** a page under `docs/help/` (Markdown, bundled with a `?raw` import; the page list is one typed table in `src/help/pages.ts`)
**When** it renders
**Then** headings, paragraphs, bullet and numbered lists, emphasis, inline code, fenced code and links render; anything else (raw HTML, images) renders as its literal text, never as markup; an `http(s)` link opens in the system browser through the opener only when clicked, and no other scheme is ever opened; a link to another page (`projects.md`, optionally `#heading`) navigates inside the pane and **← Contents** goes back; the renderer is a pure function from Markdown to a plain element tree, unit-tested in node for each construct, for raw HTML and for a `javascript:` link (vitest has no DOM; `@lezer/markdown`, already a dependency, may do the parsing)

**Given** the first two pages, **Canvas & navigation** and **Keyboard & palette**
**When** I read the Keyboard page
**Then** its command table is generated from the command registry when the page opens (title, effective key or `—`), so a rebind or an unbind in `keybindings.json` shows there, and the prose above it is the Markdown page

**Given** focus is in a terminal
**When** I press F1
**Then** the key goes to the program in the terminal (a bare key is never a pass-through binding, Story 9.4), `ctrl+shift+k` → Help still opens the pane, and the Keyboard page says so

**Given** the palette
**When** I type "help"
**Then** it lists `help.open` ("Help"), `help.page` ("Help: open page…", a pick list of the pages on the Link to… model) and `help.contents` ("Help: contents", while a page is shown); `help.toggle` (F1) is a hidden key carrier like `settings.toggle`; all are bindable, and the Story 9.4 audit passes with the pane's buttons and Contents rows routed through commands

### Story 10.2: Guide pages and F1 from where you are

As the operator,
I want every part of the app explained in its own words, and F1 to open the page for what I am looking at,
So that help answers the question I have now. (FR-HELP-2, FR-HELP-8)

**Acceptance Criteria:**

**Given** `docs/help/`
**When** this story lands
**Then** it holds, in Contents order: Canvas & navigation, Projects, Sessions & launch sheet, Terminals, tabs & pop-outs, Edges (context, cooperate), Branches & worktrees, Review, The app as a tool for Claude (the MCP server, approvals and "Always for this edge", peer messages and the unread badge, review requests), Settings & diagnostics, Keyboard & palette, Terms; each page is short (about 150–400 words), opens with what the thing is, then how to do it with the keys and palette titles as the app shows them, then the states one can see (state words, attention colour, badges), and uses only the Terms page's vocabulary for the app's parts (a review rule, with the Terms page as the reference)

**Given** the page table and the files
**When** the tests run
**Then** a test asserts that every listed page exists and every file is listed, that no page holds raw HTML, that every page link and `#heading` resolves, and that every key named in the pages as `` `ctrl+k` `` is the default binding of some registered command (so a changed default fails the test, not the reader)

**Given** a pane is open or a node is selected
**When** I press F1 or run "Help"
**Then** the pane opens on the matching page: launch sheet → Sessions & launch sheet; terminal pane → Terminals, tabs & pop-outs; edge inspector or a selected edge → Edges; Review pane → Review; import pane → Projects; settings pane → Settings & diagnostics; worktree and remove-worktree sheets → Branches & worktrees; a selected project, session or branch node with no pane → Projects, Sessions & launch sheet, Branches & worktrees; otherwise the page last read this run, else Contents; the mapping is a pure function with a test

**Given** the empty canvas (Story 9.1)
**When** it shows its hint
**Then** the hint ends with `F1 help` in the same mono muted style, and the README's clean-machine checklist step 1 quotes the new text

### Story 10.3: Getting started checklist

As a new operator,
I want a short checklist that ticks itself off as I do each thing for the first time,
So that I learn the app by using it, not by reading. (FR-HELP-5, FR-HELP-9)

**Acceptance Criteria:**

**Given** a fresh profile (`workspace.json` was created on this launch, the first run of Story 9.1)
**When** the canvas shows
**Then** a compact **Getting started** card sits at the canvas's top-right under the banner strip (over the canvas; under panes, the palette, the menu and the toasts; no animation), listing six steps with their keys: Open the command palette (`ctrl+k`), Add a project (`ctrl+o` or drop a folder), Start a session (`n` on a project node), Open a plain terminal, Link two nodes (`e`), Review changes (`r`); a step whose command is enabled now is a button that runs it, otherwise plain text; **Dismiss** closes the card; no wizard, no overlay, no modal, no accent (the card is information)

**Given** the card
**When** I actually do a step by any route (mouse, key, palette, drag-and-drop, a pane button or an agent's approved `start_session`)
**Then** its row ticks (a muted `✓` in `currentColor`) on the next render, decided from state, not from which button was pressed: projects > 0; a session the app launched reaching a live state; a plain terminal opened; edges > 0; the Review pane open on a target; the palette opened; a step already true when the card first shows is ticked at once; the detection is a pure function over the stores' state, with a test per step

**Given** progress, a dismissal, or a card that has not been dismissed
**When** the app restarts
**Then** they are back: they live in a new app-written `state.json` beside `settings.json` (`%APPDATA%\switchboard\`, `$XDG_CONFIG_HOME/switchboard/`), schema-versioned, loaded with `load_or_init` and written atomically through `persist.rs`, never watched and never hand-edited (deleting it resets the checklist and nothing else); `settings.json` and `workspace.json` are untouched; the README's "Where things live" table gains the file

**Given** all six steps done
**When** the last one ticks
**Then** the card reads `All done` and goes on its own at the next launch, or at once with Dismiss

**Given** a profile that already has a `workspace.json`
**When** the app updates to this build
**Then** the card does not appear on its own; **Getting started** is a Help page with the same six rows (`help.gettingStarted`, "Help: getting started") and a **Show on canvas** button (`checklist.show`) that brings the card back; Dismiss is `checklist.dismiss`; both are in the palette and bindable

### Story 10.4: Changelog and roadmap in Help

As the operator,
I want the changelog and roadmap readable inside the app, in plain words,
So that I know what changed and what is coming without opening the repo. (FR-HELP-6)

**Acceptance Criteria:**

**Given** the repo root
**When** this story lands
**Then** `CHANGELOG.md` exists in Keep a Changelog shape: `# Changelog`, an empty `## Unreleased`, then `## 0.1.0 — <date>` (newest first) with bullets grouped by area (Canvas, Projects, Sessions, Terminals, Branches and worktrees, Edges, The app as a tool for Claude, Review, Settings and platform, Keyboard) that summarise Epics 1–9 as a user would see them, with no story ids, FR ids or file names; and `ROADMAP.md` exists with `## Next`, `## Later`, `## Known limitations` and `## Not planned`, seeded from the PRD's Later rows, the open questions still open (Q2 injection reliability, Q3 native peer messaging), the Deferred list in this file and the user-facing rows of `deferred-work.md` (a viewer for peer message text; resume and fork with the session's own model and permission mode; remembering a pop-out window's size and place; folder targets for context edges; following `/clear` to the new session id; the false `finished` when the operator's own Stop hook blocks; the memory budget with full scrollback; typing latency p95; Linux checks still owed), with §5 of the PRD under Not planned; both read in the Terms page's vocabulary

**Given** the Help pane
**When** I open **Changelog** or **Roadmap** from Contents, or run `help.changelog` ("Help: changelog") / `help.roadmap` ("Help: roadmap")
**Then** the bundled file renders through the Story 10.1 renderer (so the two files are held to the same no-raw-HTML rule); Contents shows `Switchboard <version>` from `app_info` (Cargo's version: `tauri.conf.json` sets none) with the config folder path under it in mono

**Given** the version
**When** the tests run
**Then** a test asserts that `package.json` and `src-tauri/Cargo.toml` carry the same version and that the newest released heading in `CHANGELOG.md` equals it, so a version bump without a changelog entry fails `npm test`

### Story 10.5: What's new after an update

As the operator,
I want a quiet, one-time pointer to the changelog after the app's version changes,
So that I notice what changed without being interrupted. (FR-HELP-7, FR-HELP-9)

**Acceptance Criteria:**

**Given** `state.json` records the last version seen and the app starts as a different version
**When** the canvas shows
**Then** a muted chip `new in <version>` sits at the canvas's bottom-left beside the Elsewhere chip, in its look (mono `--text-xs`, `--fg-muted`, 1-px `--border`; no accent, no OS toast, no banner, no motion); clicking it opens Help → Changelog and records the version as seen; it stays across launches until then

**Given** a fresh profile
**When** the app starts for the first time
**Then** the current version is recorded silently and no chip shows (the checklist is the first-run surface)

**Given** the chip
**When** I open the Changelog by any route (Contents, `help.changelog`, `help.whatsNew`)
**Then** the version is recorded as seen and the chip goes; the same version never shows it again, and any difference (newer, older, a dev build with a changed version) counts as a change

**Given** the palette
**When** I type "new"
**Then** `help.whatsNew` ("What's new in <version>", a `dynamicTitle`) is listed whether or not the chip shows, and is the chip's command; the decision "show the chip" is a pure function of (stored version, current version, first run) with a test

---

## Epic 11: Learn by looking

Added 2026-11-04 (sprint change proposal of that date). After using the app with all ten epics in, the
operator found it hard to learn and hard to read at a glance: the first run is a blank canvas with one line
of text; most actions hide behind a right-click or a key; nothing says how to draw an edge or what a handle is;
the state words, the attention colour, the glow and the badges explain themselves nowhere but in prose. This
epic makes the app show what it can do, in this order: keys where the action is (menus with keys, tooltips
from the registry, a canvas menu); a toolbar on every card while it is hovered or selected; a ghost card on
the empty canvas and faint hints that fade once the thing has been done; figures in Help, built from the
app's own cards and edges and moved by CSS; meanings on every state, badge and edge, and a What you see page;
and a short first-run tour with spotlights.

**The reversal.** Epic 10 decided "no overlay tour, no coach marks, no wizard". Story 11.6 reverses the tour
part deliberately: a dimmed layer with a cut-out and a small card, at most about six stops, once on a fresh
profile, `esc` to skip, the palette still reachable over it, and never again unless asked for. The rest
stands: no welcome page, the canvas is the home screen, the Getting started card stays a card, no modal
without a one-key way out (PRD FR-HELP-1 as revised, UX principle 6).

**The rules that hold.** Low chrome and keyboard-first: every visible control is added beside its key, never
in its place, and shows on hover or selection, never permanently. Every new action is a registry command
(palette and bindable, NFR-7; the Story 9.4 audit covers every new button). No network (NFR-8), no new
dependency, no video or image assets: figures are React components over the app's own CSS classes, so they
follow the tokens by construction (the design lint reads their CSS). Persistent UI state (`hints.hidden`,
`tour.done`) goes into `state.json` (schema 3, on the Story 10.3 / 10.5 pattern), never into `settings.json`
or `workspace.json`. The fixed card sizes stay: toolbars and hints sit outside the card box. Every new
motion honours `prefers-reduced-motion` and is in DESIGN.md's Motion table.

### Story 11.1: Keys where the action is

As the operator,
I want every menu row and every button to tell me its key, and a right-click on the canvas to offer the canvas's own actions,
So that I learn the keys by using the mouse. (FR-HELP-12, NFR-7)

**Acceptance Criteria:**

**Given** the node context menu (`src/components/ContextMenu.tsx`, rows from `nodeMenuCommands()` in `src/commands/nodes.ts`)
**When** it opens on a project, session or branch card
**Then** each row ends with its effective key in the palette's key look (`<kbd className="palette-row-key">`, `formatKeybinding`, as `src/components/Palette.tsx` draws it), nothing when the command has none; a rebind or an unbind in `keybindings.json` shows there the next time the menu opens (the registry's `binding` is read on render, like the palette); DESIGN.md's context menu entry describes the column

**Given** a right-click on the canvas background that moved at most `DRAG_THRESHOLD` since the press (`rightPress` / `rightClickTarget` in `src/canvas/nodes.ts` return `null` off a node today)
**When** I release
**Then** a **canvas menu** opens at the pointer in the context menu's look: the enabled commands tagged `menu: "canvas"` (`Command.menu` widens from `"node"` to `"node" | "canvas"` in `src/commands/registry.ts`) in their `menuOrder`: **Add project folder…** (`ctrl+o`), **Import from Claude…**, **Fit view** (`ctrl+0`), **Help** (`f1`), **Open settings**; a right-drag still pans; `contextMenu.close` (Esc), a press outside and losing focus close it as they close the node menu; a `canvasMenuCommands()` sibling of `nodeMenuCommands()` has a test

**Given** a button in the chrome that runs a command (pane headers' Close, the card's chevron and `branches` chip, the review flag, the Getting started rows, the Review and terminal pane toolbars, the Help pane's buttons)
**When** I hover it
**Then** its `title` is the command's title, ` · ` and its effective key when it has one (`Close · esc`, `Review changes · r`; `Expand project` alone, since that command has no key: Enter is `selection.activate`), from one helper `commandHint(id)` in `src/commands/keybindings.ts` that reads the registry (tested for a bound, an unbound and a rebound command); item-level buttons (a toast's Allow, a tab's ×) keep their own words; the handle's `title` becomes `Drag to link · e`; a vitest in `src/commands/` lists every `title=` on a `runCommand` button in `src/components` and `src/canvas` and fails on one that is a literal string rather than the helper (the audit test's file-reading pattern), with an allow-list for the item-level ones

**Given** `docs/help/keyboard.md` and `canvas.md`
**When** this story lands
**Then** the Keyboard page says that menus and tooltips show the keys, the Canvas page names the canvas menu, and `CHANGELOG.md`'s Unreleased gains the three changes under Canvas and Keyboard

### Story 11.2: The node toolbar

As the operator,
I want a card to show its main actions when I hover or select it,
So that I never have to guess what a node can do. (FR-HELP-12, NFR-7)

**Acceptance Criteria:**

**Given** a project, session or branch card
**When** I hover it or it is selected (`data.selected`, the handle's rule in `LinkHandles.tsx`)
**Then** a toolbar sits attached under the card's bottom edge, outside the fixed 240 × 80 / 208 × 40 box (xyflow's `NodeToolbar`, already in `@xyflow/react` 12, or a plain element outside the card; either way `nodes.ts` geometry, `toFlowNodes` and the arrow keys are untouched): at most four short mono `--text-xs` text buttons and `⋯`, in DESIGN.md's **node toolbar** look; it is absent from the DOM while the card is neither hovered nor selected, so a 50-node pan stays smooth (the Story 9.3 measure, re-run once with the toolbar code in place); it appears and goes without animation

**Given** the registry
**When** a command carries a new `toolbar?: number` (its order; only commands tagged `menu: "node"` may) 
**Then** the toolbar lists that card's enabled ones in that order, cut at four, from one pure `toolbarCommands(target)` in `src/commands/nodes.ts` with a test per card kind: a project shows `new` (`project.newSession`), `term` (`project.terminal`), `link` (`edge.link`), `review` (`review.changes`); a session shows `term` (`session.showTerminal`) or `resume` (`session.resume`, whichever is enabled), `fork`, `link`, `review` (**Stop** stays in `⋯`: a destructive action is never one hover away); a branch shows `new` (`branch.newSession`), `worktree` (`branch.newWorktree`) or `remove` (`branch.removeWorktree`), `review`; a disabled command is left out, never greyed; a command's short word is a new `short?: string` on the command (falls back to the title cut at the first space, so a toolbar entry without one is a test failure)

**Given** a toolbar button
**When** I click it
**Then** the card is selected first and the command runs through `runCommand` (one local function, so `audit.test.ts` passes without a new allow-list entry); the button is `nodrag`, so a press on it never starts a drag; its tooltip is the Story 11.1 `commandHint`; `⋯` opens the node context menu under the button (`openContextMenu` with the button's bottom-left, the `rightClickNode` route) and carries `Menu · right-click`

**Given** the keyboard
**When** a card is selected with the arrows
**Then** the toolbar shows but is not in the Tab order (keys are the keyboard's route; the palette lists the same commands); the card's accessible name is unchanged

**Given** `docs/help/canvas.md`, `projects.md`, `sessions.md`, `branches.md`
**When** this story lands
**Then** each names the toolbar in one sentence where it lists the card's actions, the Terms page gains **Toolbar**, DESIGN.md's Node anatomy says the toolbar is outside the box, and the changelog's Unreleased gains it

### Story 11.3: The ghost card and inline hints

As a new operator,
I want the empty canvas to show where a project goes, and the first things I can do to be written next to where I do them,
So that the first minutes need no reading. (FR-HELP-13, FR-HELP-5, FR-HELP-9)

**Acceptance Criteria:**

**Given** a canvas with no projects (`Canvas.tsx`'s `empty`)
**When** it shows
**Then** the mono hint line gives way to the **ghost card** in DESIGN.md's look: a dashed `--fg-faint` box of the project card's size at the view's centre, `Drop a folder here`, and under it `ctrl+o pick a folder · ctrl+k palette · f1 help` (the keys from the registry, so a rebind shows; `content.test.ts`'s rule that a key named in help is a default binding applies to the card's text through the same helper); a click on it runs `project.add` (one `runCommand`, the audit passes); the canvas around it still pans and takes drops; it is gone with the first project and back with the last removed, without animation; the README's clean-machine checklist step 1 quotes the new words

**Given** the Getting started checklist is showing (`cardVisible` in `src/state/checklist.ts`: a fresh profile, not dismissed) and hints are not hidden
**When** the canvas draws
**Then** **inline hints** sit by the thing they explain, from a pure `hintsFor(sources, done, hidden)` in a new `src/help/hints.ts` (one test per hint): under the first project card in `projects` order, `n new session · hover for more` until step `session` is done; beside that card's handle, `drag to link · e`, drawn only while the handle shows (hover or selected) until step `edge` is done; under the first session card in a live state, `r review changes` until step `review` is done; at most one hint per card and three on the canvas; each is a mono `--text-xs` `--fg-muted` caption outside the card box with no border or surface, letting clicks through, never the accent; a hint whose card is under an open pane is not drawn

**Given** a hint showing
**When** its step latches (the checklist store's `done`, Story 10.3) or hints are hidden
**Then** it fades out over 300 ms (opacity only; instant under reduced motion; DESIGN.md's Motion table gains the row) and is removed; it never comes back for that step

**Given** the palette
**When** I type "hints"
**Then** `hints.hide` ("Hide canvas hints", `when` hints show) and `hints.show` ("Show canvas hints", `when` they are hidden or the checklist card is not showing) are listed and bindable; `hints.show` also shows hints on a profile whose checklist was dismissed or never shown (for the undone steps); `hidden` lives in `state.json` as `hints: { hidden: boolean }` (schema 3 in `src-tauri/src/appstate.rs`: a version-2 file loads with it `false`; a newer file stays read-only; `state_get` carries it, a `hints_set` IPC writes it atomically; tests per the Story 10.3 matrix rows); the README's "Where things live" sentence names it; `settings.json` and `workspace.json` are untouched

**Given** `docs/help/getting-started.md`
**When** this story lands
**Then** it says each step has a hint on the canvas until it is done, and how to hide and show them; the changelog's Unreleased gains the ghost card and the hints under Canvas

### Story 11.4: Figures in Help

As the operator,
I want the help pages to show me how an edge is drawn and what a card is made of, moving, instead of describing it,
So that I understand it in a glance. (FR-HELP-14, FR-HELP-3, NFR-8)

**Acceptance Criteria:**

**Given** a fenced block in a help page whose info string is `figure <name>` (``` ```figure draw-edge ```), its text the alt text
**When** the renderer runs (`src/help/markdown.ts`: `FencedCode`'s `CodeInfo` child, skipped today as a mark, is read for this one case)
**Then** it yields a new `HelpNode` `{ type: "figure"; name; alt }`; any other fenced block renders as before; the Help pane (`src/components/HelpPane.tsx`'s `Block`) draws the figure from a typed table `FIGURES` in a new `src/help/figures/index.ts` (name → component), and for a name not in the table draws the alt text as a code block (today's behaviour, so a typo is visible and never markup); `src/help/content.test.ts` asserts that every figure named in a page exists in the table and every figure in the table is used by some page; the renderer's tests cover the block, a figure with no name and a name with odd characters (literal text)

**Given** the first five figures, in `src/help/figures/*.tsx` with their keyframes in `src/help/figures.css`
**When** they render
**Then** **draw-edge** (Edges page) shows a project card and a session card; the handle appears on the hovered card, a dashed line is pulled to the other card and settles as a context edge; then two session cards and the double line of a cooperate edge; **edge-kinds** (Edges, still) shows the five looks side by side with mono labels: context, cooperate, pending, failed, selected; **node-anatomy** (Projects) shows a project card with its rows named: chevron and count, label, `N live`, path, git line, `branches` chip, handle; **session-states** (Sessions) shows a session card under its project card stepping `starting → busy → waiting → busy → finished → idle → exited`, the project glowing on the attention states; **panes** (Canvas) shows a pane coming in over the canvas on the right and the palette over the dimmed page; every one is built from the app's own classes (`project-node`, `child-node`, `session-state`, `session-dot`, `link-handle`, `link-line`, `link-context`, `link-cooperate`, `pane`) on the pane's surface in DESIGN.md's **Help figures** look, moves by CSS only (opacity, transform, `stroke-dashoffset`), loops every 4–8 s with a pause, shows its end frame still under `prefers-reduced-motion: reduce`, has `role="img"` and the alt text as its name, and uses the accent only through the allow-listed classes; the design lint reads `figures.css` like every CSS under `src/`

**Given** the figures
**When** the tests run
**Then** a node test renders every figure in `FIGURES` with `react-dom/server`'s `renderToStaticMarkup` and asserts its alt text is in the markup, no inline `style` carries a colour, and no class outside the app's own CSS files is used (the class names are collected from `nodes.css`, `shell.css` and `figures.css`); the Help pane's lazy chunk still holds the page text and the figures (the main bundle gains nothing: `pages.ts` imports `figures/index.ts`)

**Given** `docs/help/edges.md`, `projects.md`, `sessions.md`, `canvas.md`
**When** this story lands
**Then** each holds its figure(s) at the top of the section it illustrates, with the prose under it cut to what the picture does not say (the Story 10.2 word budget still holds); DESIGN.md's Layout pieces and Motion table describe figures; the changelog's Unreleased gains them under Help

### Story 11.5: Status at a glance

As the operator,
I want every state word, glow, badge and edge to say what it means where I see it,
So that I read the canvas without a page open. (FR-HELP-15, FR-PROJ-4, FR-SESS-7)

**Acceptance Criteria:**

**Given** one table of meanings, `stateMeaning(state)` in `src/canvas/nodes.ts` (exhaustive over `SessionState["kind"]`, a test per state; an unrecognised poll state gets `as the session reports it`)
**When** a card draws
**Then** the session card's tooltip (`sessionCardTitle`) leads with `<state> — <meaning>` while the poll has seen the session (`busy — Claude is working`, `waiting — Claude needs an answer; enter opens its terminal`, `finished — the turn ended; look at what it did`, `idle — waiting for you`, `starting — launched, no output yet`, `stopping — being stopped`, `exited — the process ended`); the project glow's title names the session and why (`<name> is waiting`); the `N live` badge's title reads `N sessions running`, the count badge's `N children, collapsed`, the unread badge's `N unread peer messages` (unchanged), the review flag's `asks for review · click to open`, a branch card's worktree chip its path (unchanged); the aria labels carry the same words

**Given** a stored edge
**When** I hover its line
**Then** an SVG `<title>` on the edge reads its kind and live state in the edge inspector's words (`context edge · pending (waiting for idle)`, `cooperate edge · notified`, `context edge · failed (not confirmed)`, `context edge` with no live state), from a pure `edgeHoverText(edge, live)` in `src/canvas/edges.ts` with a test per state; the label's own tooltip (the full label) stays

**Given** `docs/help/legend.md`, a new page **What you see** (`id: "legend"`), second in Contents after Canvas & navigation (`HELP_PAGES` in `src/help/pages.ts`; `pages.test.ts` and `help.test.ts` counts go up by one)
**When** I open it (Contents, `help.legend` "Help: what you see" in the palette and bindable, or a link from the Canvas, Sessions, Projects and Edges pages' "What you can see" sections, which shrink to one sentence and the link)
**Then** it shows the **session-states** figure over a row per state with the state word in its own look and the meaning from the same table (the page's rows are rendered by the pane like the Keyboard page's table, so the words come from `stateMeaning`, not from a second copy), then the attention colour, the glow, the badges and the Elsewhere chip, then the **edge-kinds** figure over a row per edge look; `content.test.ts` holds it to the Terms page's vocabulary like every page; F1 on a selected session or edge keeps opening Sessions or Edges (`src/help/context.ts` is unchanged)

**Given** the changelog
**When** this story lands
**Then** Unreleased gains the meanings on hover and the page under Help, and `ROADMAP.md`'s Later keeps "Searching the help" as is

### Story 11.6: The first-run tour

As a new operator,
I want a short guided tour that points at the canvas, a card, its toolbar, a handle and the palette, once,
So that I know where things are before I start. (FR-HELP-16, FR-HELP-9, UX principle 6; reverses Epic 10's "no overlay tour")

**Acceptance Criteria:**

**Given** a fresh profile (`first_run`, the Story 10.3 signal) whose `state.json` has `tour.done: false`
**When** the canvas has painted its first frame (`reportFirstFrame` in `Canvas.tsx`)
**Then** the tour starts on its own, once: a `Tour` component in `src/components/Tour.tsx`, its state in `src/state/tour.ts` (`on`, `stop`), its stops in a typed table in `src/help/tour.ts`; the Getting started card is held back until the tour ends or is skipped (then shows as Story 10.3 says); a profile that existed before this build never starts it on its own; a `state.json` that is read-only (newer schema, unwritable) runs the tour at most once per launch and never writes

**Given** the stops table (each: id, title, one or two sentences, an optional target `[data-tour="<id>"]` attribute set on the real element, an optional figure from Story 11.4)
**When** the tour is on
**Then** the stops are, in order: **The canvas** (target: the ghost card or, with projects, the canvas; "Projects are cards; sessions and branches hang under them"); **Add a project** (target: the ghost card or the first project card; the keys); **Start a session** (target: the first project card's toolbar `new`, which the tour makes visible as if hovered; with no project, the `node-anatomy` figure); **Link nodes** (target: the first project card's handle, shown as if hovered; with no project, the `draw-edge` figure); **Read the canvas** (the `session-states` figure; "the attention colour means a session needs you; `ctrl+j` goes there"); **Everything is a command** (no target: "`ctrl+k` lists every command with its key; `f1` opens help for where you are"); the stop's text names keys as `kbd`; the whole table has a test that every target id named exists in the markup (a static scan of `src/`, the audit's pattern) and every figure named is in `FIGURES`

**Given** the tour's look (DESIGN.md **The tour**)
**When** a stop shows
**Then** a dim layer at the palette backdrop's colour covers the shell, panes and toasts at z 14 (under the palette's 15 and the menu's 20; `shell.css`'s stack comment is updated) as four rectangles around the target's client rect, leaving a cut-out with the selected node's 1-px `--focus` outline at 2-px offset; the tour card sits beside the cut-out (right, else left, else below; `clampToArea` keeps it in the window) or centred with no target; the cut-out moves to the next target over 150 ms, instant under reduced motion; the card appears without animation; no accent, no shadow (the lint passes); the layer takes pointer events, so nothing underneath is clicked during the tour (PRD Q15); a target that scrolls or resizes (window resize) re-measures on the next frame

**Given** the tour card's buttons and the keys
**When** I use them
**Then** **Back** / **Next** / **Skip** (and **Finish** on the last stop) run `tour.back`, `tour.next`, `tour.skip` through `runCommand` (the audit passes); the three are hidden key carriers (`←`, `→` and `enter`, `esc`) with `when: isTourOn()`, registered so that `tour.skip` comes first in the Esc order (before `contextMenu.close`) and `tour.next` before `selection.activate`; `tour.start` ("Take the tour") is a visible palette command always, bindable, and also a **Take the tour** button on the Getting started help page beside **Show on canvas** (and a **tour** link in the Getting started card's header while the tour has never been taken); `ctrl+k` still opens the palette over the tour and `palette.close` brings the tour back as it was; focus moves to the card's Next on each stop and returns where it was when the tour ends

**Given** Finish or Skip
**When** the tour ends
**Then** `state.json` records `tour: { done: true }` (schema 3 with Story 11.3's `hints`; a `tour_set` IPC on the `checklist_set` pattern; a version-2 file loads with `done: false`); it never starts on its own again; `tour.start` runs it any time, from the first stop, without writing until it ends; the README's "Where things live" sentence names it; `docs/help/getting-started.md` gains a **The tour** section, DESIGN.md gains the entry, and the changelog's Unreleased records the tour under Help, with one line saying it replaces the earlier "no tour" stance

---

## Deferred (recorded, not scheduled)

- Multiple workspaces (FR-CANVAS-8)
- Cost/token per session from transcript usage (FR-SESS-10)
- Remote branches and fetch/pull/push (FR-BRANCH-6)
- Stage/commit from review (FR-REVIEW-7)
- Auto-update (FR-SYS-6)
- Help search and the guide over MCP (FR-HELP-10, FR-HELP-11)
- Cloud sessions (`claude --cloud`), Remote Control attach
- Structured chat view over `-p --output-format stream-json` as an alternative to the terminal (A2)
- macOS
