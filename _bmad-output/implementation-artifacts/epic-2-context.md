# Epic 2 Context: The canvas and project nodes

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Replace the Epic 1 placeholder screen with the product's home surface: an infinite canvas that persists its viewport and node positions, onto which the operator adds folders as project nodes (picker, drop, or import from Claude's known projects), expands, collapses and drags them, navigates by keyboard and acts on them from a context menu or the palette. The epic also fixes the visual language in `docs/DESIGN.md` so every later node, pane and edge draws from one quiet token set. After it the app shows the operator's repos and their git state; sessions, terminals and branches arrive in Epics 3–5 as children of the nodes built here.

## Stories

- Story 2.1: Canvas with persisted viewport
- Story 2.2: Add a project node
- Story 2.3: Expand, collapse, drag, auto-layout
- Story 2.4: Keyboard navigation and project actions
- Story 2.5: Visual language

## Requirements & Constraints

- One workspace per app instance, persisted to disk and restored on launch: nodes, positions, collapse state, viewport (edges later). The viewport must be saved within 500 ms of the last pan/zoom and come back identical after restart.
- Infinite canvas: pan with space+drag or middle button, zoom with the wheel; a fit-to-view command. Smooth at 60 Hz with 50 nodes.
- Node types are project, session and branch. Only project nodes are top-level; children show in a column under an expanded parent and collapse into a count badge. Epic 2 may use stub children to prove layout.
- Add a project by native folder picker, by dropping a folder on the canvas, or by "Import from Claude": list the `cwd` of every project dir under `~/.claude/projects` that still exists on disk, with its session count, multi-select to add.
- A project node shows label (folder name, editable later), path, current branch and dirty-file count, a live-session badge (0 until Epic 3), and a "branches" affordance only when the folder is a git repo. Non-git folders are ordinary project nodes with no error.
- Children auto-layout in stable order under the parent; any node can be dragged and the position survives restart; "Re-layout children" restores the column.
- Keyboard: arrows move selection to the nearest node in that direction, Enter runs the default action, Esc clears selection. `n`, `e` and `/` are reserved for later epics.
- Project actions, each a registered command with a `when` clause, in both context menu and palette: new session (stub), plain terminal (stub), open in external editor, open in file manager, reveal Claude project dir, remove from canvas.
- The app only reads `~/.claude`, never writes there; unknown transcript record types are skipped.
- Budgets hold: cold start under 1 s, idle RSS under 150 MB; the graph library is the only sizeable new dependency.
- Visual rules, written into `docs/DESIGN.md` by Story 2.5 and applied retroactively to palette, pane and banners: tokens for surfaces, 1-px borders, one accent, type scale, node anatomy, status colours; no gradients or shadows, monochrome icons, accent only on attention states.

## Technical Decisions

- **Graph UI:** `@xyflow/react` with custom node components (`ProjectNode` now; `SessionNode`, `BranchNode` as stubs) under `src/canvas/`. Handles visible only on hover/keyboard focus. Child layout is a plain column; the ordering later epics fill in is live first, then pinned, then recent.
- **Workspace model lives in Rust** (`src-tauri/src/graph/`): `Project { id, path, label, position, expanded, color?, launchDefaults? }` plus `branches`, `sessions`, `edges`, `defaults` and `viewport { x, y, zoom }` under a `version: 1` envelope. Reserve all fields now so Epics 3–6 need no migration. Live state (git status, session counts) is never persisted; cache in memory, refresh on timers/fs events.
- **Persistence:** `workspace.json` beside `settings.json` in the platform config dir; atomic write (temp + rename) and tolerant parse (`serde(default)`, unknown keys ignored), as the settings store already does. Window bounds stay with the window-state plugin; the viewport belongs in the workspace file.
- **Rust is the source of truth.** Every mutation is a thin Tauri command delegating to `graph/`; Rust emits `workspace://changed` with a snapshot, mirroring `settings://changed`. Frontend: a `workspace` Zustand store mirrored from Rust and a `ui` store for selection and open panes.
- **Git via the `git` CLI** (`src-tauri/src/git/`): `rev-parse` for repo detection, current branch and `status --porcelain=v2` for dirty count, parsed into typed structs. Binary path and poll interval (`poll.git_ms`, default 5 s) come from settings.
- **Claude project discovery** (`src-tauri/src/claude/discover.rs`, read-only): encode cwd to the project-dir name with the observed heuristic (`:`, `\`, `/`, space → `-`) but confirm by reading `cwd` from the first `user` record of a transcript, falling back to scanning all project dirs. Epic 2 needs only dir → cwd, existence and transcript count; full parsing is Epic 3.
- **External actions** reuse `tauri-plugin-opener` (already registered, called from Rust) for file manager and "reveal Claude project dir"; "open in external editor" runs the settings `external_editor` template. A native folder picker and webview drag-drop of folder paths are not wired yet.
- **Commands and keys:** every action goes through the existing registry and single keydown dispatcher (bare keys already skipped in editable elements). Esc precedence becomes palette → pane → clear selection. Arrows/Enter/Esc must be owned by the registry, not xyflow's built-in handling.
- **Theme:** extend `src/theme/tokens.css` (bg, raised bg, fg, muted fg, border, one amber accent, sans and mono stacks) with type scale, node anatomy and status colours; CSS variables only, no component library. Story 2.5 also replaces the placeholder Tauri icons.
- **Testing:** vitest has no DOM environment yet; the first component test brings jsdom. Rust parsers (git porcelain, project-dir encoding) get fixture tests. `cargo test`, `clippy -D warnings`, `tsc --noEmit` and both CI runners stay green, so paths must work on Linux as well as Windows.

## UX & Interaction Patterns

- The canvas is the home screen: no welcome page, sidebar tree or tab row. The current name+version placeholder goes away. Banners stay as a top strip; panes slide in from the right and close on Esc.
- Status is ambient (colour, later a pulse), never a modal. The accent is reserved for attention; a selected node uses a border/outline, not the accent.
- A project node is a compact card: label, path, branch and dirty count, a badge for collapsed children, a branches affordance only for git repos. Context menu on right-click; the same commands via `ctrl+k`.
- An empty canvas should read as intentional; the ship epic expects a quiet "Add project" hint there.

## Cross-Story Dependencies

- 2.1 introduces `graph/`, `workspace.json` and `workspace://changed`; 2.2–2.5 build on it.
- 2.2 brings `git/` and `claude/discover.rs`, both reused by Epic 3 (transcripts, live sessions) and Epic 5 (branches, worktrees).
- 2.3's stub children are replaced by real session nodes (Epic 3) and branch nodes (Epic 5); keep the layout independent of child type.
- 2.4's "new session" and "plain terminal" are stubs until Epic 4; "open in external editor" uses the settings `external_editor` (Story 1.3); the registry and dispatcher come from Story 1.4, and Epic 9's audit expects every button and menu item to map to a command.
- 2.5's `docs/DESIGN.md` closes items deferred from Epic 1: placeholder icons (1.1), banner wrapping (1.3), palette styling (1.4).
- Story 1.4 left the second-instance argv unhandled; no Epic 2 story needs it.
