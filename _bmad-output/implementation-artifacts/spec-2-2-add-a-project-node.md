---
title: 'Story 2.2: Add a project node'
type: 'feature'
created: '2026-10-17'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'd670827d2ddd29833358742e267aa37b741f44bb'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The canvas is empty and nothing can be put on it. The product's first real object — a project node for a folder, showing its git state — does not exist, so neither does the graph.

**Approach:** Three ways to add a folder as a **project node**: a native folder picker (`project.add`, `ctrl+o`), dropping a folder from the OS onto the canvas (placed where it lands), and **Import from Claude** (`project.import`): a pane listing every `~/.claude/projects` entry whose folder still exists, with its session count, multi-select → add. Rust owns the model: `workspace_add_projects(paths, position)` canonicalises, de-duplicates, assigns ids, persists and emits. A `git/` module reads branch, dirty count and ahead/behind with one `git status --porcelain=v2 --branch` per project, polled at `settings.poll.git_ms` and on add, delivered as a non-persisted `projects://status` event. A `claude/discover.rs` module lists Claude's project dirs read-only, taking each `cwd` from the newest transcript's first `user` record (falling back to decoding the dir name). The node is a compact card: label, shortened path, `branch · N changed` (or `not a git repo`), ahead/behind when non-zero, a live-session badge (hidden at 0), and a "branches" affordance only for git repos (inert until Epic 5).

**Decisions (recorded):** `tauri-plugin-dialog` 2.8.3, Rust-side `blocking_pick_folder` inside an async command — no JS package; drop handling via `getCurrentWebview().onDragDropEvent` (Tauri's native drag-drop; directories only — files are ignored with a banner-free no-op), position via `screenToFlowPosition`, several dropped folders fan out 24 px apart; project `id` is a UUID v4 (`uuid` crate), `label` the folder name, path canonicalised (`dunce::canonicalize` on Windows to avoid `\\?\`), duplicate = same canonical path (case-insensitive on Windows) → existing node returned, not re-added; non-directory → `Err("not a directory")`; the picker places the node at the current viewport centre; a new `src/state/ui.ts` store owns `pane: 'settings' | 'import' | null` and `settings.paneOpen` migrates onto it (commands and tests follow); git binary = detected `git.path` from settings, else `git` on PATH; status poll is a Tauri async task started in setup, interval re-read from settings each tick, skipped for projects whose folder vanished (status `missing`); `claude_home` defaults to `~/.claude` and is injectable for tests; transcript scan reads at most the first 64 KB of the newest `.jsonl`; nodes remain `nodesDraggable=false` (2.3); no removal/context menu (2.4); the "live" badge is wired to a constant 0 until Epic 3.

## Boundaries & Constraints

**Always:** Rust is the source of truth for the workspace; the frontend derives xyflow nodes from `snapshot.workspace.projects` + the latest status map. Never write under `~/.claude`; discovery is read-only and tolerant (unreadable dir or transcript → entry skipped, never fatal). All git calls go through `git/` with a 5 s timeout and never block the UI thread. Every new action is a registry command (`project.add`, `project.import`, `import.close`) with `when` clauses; the import pane is keyboard-operable (Tab/Space/Enter). Tokens only; accent appears only on attention states (none in this story). Esc precedence: palette → open pane (settings or import).

**Never:** No node dragging, expand/collapse, children, selection or context menu (2.3/2.4). No node removal. No remote git operations. No `git` invocation outside `git/`. No HTML5 drag-and-drop (Tauri's native drop disables it on Windows anyway). No editing of label/path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Picker | `ctrl+o` → choose `B:\projects\guild-auth` | node at viewport centre: label `guild-auth`, path, `master · 0 changed` (per repo), persisted in `workspace.json` | cancel → nothing |
| Drop | drag folder from Explorer, release at (x,y) | node at that canvas position; several folders fan out | a dropped file → ignored |
| Non-git folder | `C:\Users\emils\Documents` | node with `not a git repo`, no branches affordance | — |
| Duplicate | add a path already on the canvas | no new node; existing node briefly highlighted (outline), snapshot unchanged | — |
| Import list | `project.import` | pane lists each `~/.claude/projects` dir whose cwd exists: label, path, `N sessions`, checkbox; already-added rows checked+disabled with "on canvas"; dirs whose cwd is gone are omitted | unreadable dir/transcript → skipped |
| Import add | select 2, Enter / "Add selected" | both nodes added at centre, fanned out; pane closes | — |
| Git status | repo gets a dirty file / commit | within one `poll.git_ms` the card shows `N changed`, `↑n ↓m` when upstream differs | git failure → `git unavailable` on the card, no banner |
| Folder vanished | project folder deleted while running | card shows `folder missing` (muted), node stays until removed (2.4) | — |
| Relaunch | file with 3 projects | 3 nodes at their saved positions; statuses fill in after the first poll | — |
| Path without git | `git` missing from the machine | cards show `git unavailable`; settings banner from 1.3 already explains | — |

</frozen-after-approval>

## Code Map

- `src-tauri/src/graph/mod.rs` -- `Workspace.projects: Vec<Project>` (id, path, label, position, expanded, color, launch_defaults) already modelled; `WorkspaceState { path, workspace, read_only, … }`, `persist` pattern in `set_viewport` (lock → clone → write outside lock → re-lock → emit). Add `add_projects(app, paths, position) -> Result<WorkspaceSnapshot, String>` following that pattern; `graph::announce` for emits.
- `src-tauri/src/settings/mod.rs` -- `AppState` (add `live: RwLock<LiveState>` for status maps), `Settings.poll.git_ms`, `binaries.git.path`, `Binary.status`; `settings::detect::ProcessRunner` (5 s timeout, `CREATE_NO_WINDOW`) — reuse its spawn/timeout approach for `git/` (generalise into a `process` helper if cheap, else copy the pattern).
- `src-tauri/src/persist.rs` -- not needed for live state; `write_atomic_json` used by graph.
- `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` -- command pattern + `invoke_with` wire tests; register `project_pick_folder`, `workspace_add_projects`, `claude_projects_list`, `projects_status_get`; `builder()` adds `tauri_plugin_dialog::init()` and starts the status poller in `setup`.
- `src-tauri/Cargo.toml` -- add `tauri-plugin-dialog = "2"` (2.8.3), `uuid = { version = "1", features = ["v4"] }`, `dunce = "1"`.
- `docs/research/claude-code-integration.md` -- dir-name encoding (`:` `\` `/` space `.` → `-`), first `user` record carries `cwd`; `~/.claude/projects/<dir>/*.jsonl`.
- `src/canvas/Canvas.tsx` -- `ReactFlow nodes={NO_NODES}`; add `nodeTypes={{ project: ProjectNode }}`, derive nodes with `toFlowNodes(projects, statuses)` (pure, tested), `onInit` already stores the instance (exposes `screenToFlowPosition`); drag-drop listener registered in `Flow`.
- `src/state/workspace.ts`, `src/state/canvas.ts`, `src/ipc/mirror.ts` -- store/mirror patterns; add `src/state/status.ts` (projectId → `RepoStatus | null`, mirrored from `projects://status` + `projects_status_get`), `src/state/ui.ts`.
- `src/state/settings.ts`, `src/commands/builtins.ts`, `src/components/SettingsPane.tsx`, tests -- `paneOpen` → `ui.pane === 'settings'`; `settings.closePane` → generic `pane.close` (Esc, when a pane is open and the palette closed).
- `src/components/shell.css`, `src/theme/tokens.css` -- `.pane` styles to reuse for the import pane; node card styles go in `src/canvas/nodes.css`.
- `README.md` -- Workspace section: adding projects (three ways), what the card shows, polling.

## Tasks & Acceptance

**Execution:**
- [ ] `src-tauri/src/git/mod.rs`, `git/status.rs` -- `RepoStatus { branch, detached, dirty, ahead, behind }`, `parse_porcelain_v2(&str)`, `repo_status(git_bin, path) -> Result<Option<RepoStatus>, GitError>` (`None` = not a repo via exit code 128 / "not a git repository"), timeout; fixture tests for clean, dirty, ahead/behind, detached, untracked -- git facts
- [ ] `src-tauri/src/git/poll.rs`, `settings/mod.rs` (`LiveState`) -- poller task: every `poll.git_ms` (re-read), for each project `spawn_blocking` status, store in `LiveState.statuses`, emit `projects://status` when changed; `refresh_now(app)` called after add; `ProjectStatus = { Repo(RepoStatus) | NotRepo | Missing | GitUnavailable }` -- live state
- [ ] `src-tauri/src/claude/mod.rs`, `claude/discover.rs` -- `ClaudeProject { dir, cwd, exists, sessions }`, `list_projects(claude_home) -> Vec<ClaudeProject>` (cwd from newest transcript's first `user` record within 64 KB, fallback decode), `decode_dir_name`; fixture tests (real-shaped jsonl lines) -- discovery
- [ ] `src-tauri/src/graph/mod.rs` -- `add_projects(app, paths, position)`: canonicalise, reject non-dir, dedupe, uuid, label, fan-out, persist, emit; returns snapshot + ids added + ids already present; tests incl. dedupe (case-insensitive on Windows), non-dir error, persisted file, read-only guard respected -- the model
- [ ] `src-tauri/src/ipc/mod.rs`, `lib.rs`, `Cargo.toml` -- `project_pick_folder` (async, dialog plugin), `workspace_add_projects`, `claude_projects_list`, `projects_status_get`; plugin registration; poller start; wire tests -- wiring
- [ ] `src/ipc/index.ts` -- types (`RepoStatus`, `ProjectStatus`, `ClaudeProject`, `AddProjectsResult`), four wrappers, `onProjectsStatus` -- IPC surface
- [ ] `src/state/ui.ts` (+test), `src/state/status.ts` (+test), `src/state/settings.ts`, `src/commands/builtins.ts` (+test), `src/components/SettingsPane.tsx` -- pane store migration; `project.add` (`ctrl+o`), `project.import`, `pane.close`; `toFlowNodes`, `fanOut(positions)`, `shortenPath` pure fns with tests -- frontend state & commands
- [ ] `src/canvas/ProjectNode.tsx`, `src/canvas/nodes.css`, `src/canvas/Canvas.tsx` -- card component; node derivation; drop listener → `workspaceAddProjects(paths, screenToFlowPosition)`; duplicate highlight (1.5 s outline) -- the node
- [ ] `src/components/ImportPane.tsx` -- list with checkboxes, "Add selected", keyboard-operable, loading/empty states -- import UI
- [ ] `README.md` -- adding projects, card anatomy, polling -- docs

**Acceptance Criteria:**
- Given an empty canvas, when I press `ctrl+o` and pick a git repo, then a node appears at the centre with its label, path and `branch · N changed`, and `workspace.json` lists the project with that position.
- Given Explorer open, when I drop two folders onto the canvas, then two nodes appear at the drop point fanned out; dropping a file does nothing.
- Given `project.import`, when the pane opens, then it lists my Claude projects that still exist with session counts and marks the ones already on the canvas; selecting two and confirming adds them and closes the pane.
- Given a project node, when I create a file in that repo, then within `poll.git_ms` the card's changed count increments; `cargo test` covers the porcelain parser, discovery and `add_projects`; `npm test` covers `toFlowNodes`, `fanOut`, `shortenPath`, the ui/status stores and the new commands.

## Implementation Notes

- Orchestrator GUI run (2026-10-17, foreground-guarded): planted three projects → cards rendered `ide / B:\projects\ide / master · 42 changed [branches]`, `projects / not a git repo` (no affordance), `definitely-missing / folder missing`; palette → "Import from Claude" listed the existing Claude projects with session counts, `ide` ticked+disabled "on canvas"; `ctrl+o` opened the native "Add project folder" dialog, Esc cancelled with no change; a probe file in the repo moved the count to 43 within one 5 s poll and back to 42 after deletion; `ctrl+q` quit. Note: `C:\Users\emils` is itself a git repo, so `Documents` reports as a repo — the probe used `B:\projects` instead. Folder drop from Explorer is left to Emils by hand.
- Orchestrator (2026-10-17, after patches): verification — vitest 15 files / 184 passed, `cargo test` 178 passed, `clippy -D warnings` clean, `tsc` clean, debug build; GUI re-check identical to pass 1 plus `↑1 ↓0` shown once the repo was a commit ahead and the Import pane's "on canvas" now coming from Rust (`on_canvas`). Committed `f2af407`, pushed.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-17) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- BH1 / EC11 discovery consults only the newest transcript, then falls to the lossy name decode; a `cwd` past the 64 KiB window turns `guild-auth` into `guild\auth` and the project vanishes from the import list — **medium**: patch — try transcripts newest→oldest; parse the last line when the file was read to EOF.
- BH3 / EC7 any `Err` (timeout, exit 128 for dubious ownership…) becomes `git_unavailable`, blaming a missing git — **medium**: patch — timeout keeps the previous status; non-spawn failures become `git_error { message }`.
- BH4 / EC3 / EC4 / VG4 pane lifecycle bypassed: `settings.ts` opens the pane on the ui store directly; `addSelectedImports` closes whatever pane is open after the await — **medium**: patch — route through `panes.ts`; close only if still `import`; tests.
- BH7 poller spawns one `git` per project at once every tick, and the add-triggered refresh re-polls everything — **medium**: patch — semaphore (4), `refresh_ids` after add.
- BH8 first poll runs before git detection finished, so a configured non-PATH git briefly shows every card as unavailable — **low**: patch — wait for detection (≤2 s) before the first pass.
- EC2 two adds in flight: an older reply applied after a newer one hides a node until the next event — **medium**: patch — `revision` counter in `WorkspaceSnapshot`; the store ignores older revisions.
- EC1 empty/duplicate project ids from a hand-edited file collide as node ids / React keys — **low**: patch — `validate` drops them with a `workspace.projects` banner.
- BH11 drops anywhere on the webview add a node under a pane — **low**: patch — ignore drops whose point is inside `.pane` or outside the canvas.
- BH13 picker not parented to the main window — **low**: patch — `set_parent`.
- BH2 / EC6 TS `samePath` is case-insensitive on Linux, Rust is not — **low**: patch — Rust reports `on_canvas` per Claude project; TS stops guessing.
- BH6 `workspace_add_projects` does blocking I/O on an async worker — **low**: patch — `spawn_blocking`.
- BH14 `dropProjects` matches the error string — **low**: patch — Rust returns `Ok` with `skipped` populated when nothing is a directory; `Err` only for real failures.
- EC13 / EC16 picker/import place the card's top-left at the centre, and a second `ctrl+o` lands exactly on the first — **low**: patch — offset by half the card; nudge by `FAN_OUT_STEP` while a project sits within 24 px.
- EC5 overlapping flashes: the first timer cuts the second short — **low**: patch — per-id timers.
- EC8 `status.showUntrackedFiles=no` hides untracked changes — **low**: patch — `--untracked-files=normal`.
- EC9 a grandchild holding the pipes blocks `run()` past the timeout (git fsmonitor daemon is a real case) — **low**: patch — join readers with a deadline.
- EC12 a symlink/junction is labelled with its target's name — **low**: patch — label from the picked path, identity from the canonical one.
- BH9 status-mirror failure swallowed — **low**: patch — third banner source.
- BH12 inline callback ref re-registers the element every render — **low**: patch — stable function.
- BH5 `import.close` duplicates `pane.close` — **low**: patch — remove.
- BH10 / VG-o dead `fanOut`, `FAN_OUT_STEP`, `selectStatus`, unreachable `return path` — **low**: patch — delete.
- EC14 doc comment names the removed `settings.closePane` — **low**: patch.
- BH15 / VG5 "plain folder" tests accept either answer / overclaim — **low**: patch — compute the expectation with `rev-parse --is-inside-work-tree`.
- VG1 four new IPC wrappers' argument shapes unverified — **low** (pre-verified): patch.
- VG2 post-add refresh unobserved by any test — **low** (pre-verified): patch — bounded wait on live state.
- VG3 interval floor / per-tick re-read untested — **low** (pre-verified): patch — `interval()` + tests.
- BH16 README: hint text, "timed out" under `git unavailable` — **low**: patch after the status change.
- EC10 `agent-*.jsonl` inflating session counts — **low**: rejected (maybe-false); no such files exist in any project dir on this machine.
- EC15 spec says `refresh_now`, code has `refresh` — **low**: rejected; the fix is a spec edit.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): `ctrl+o` → pick `B:\projects\guild-auth` → card; duplicate add → highlight only; `project.import` → list, add two; touch a file in a repo → count changes within 5 s; relaunch → nodes restored. Drop is exercised by hand by Emils (OS drag cannot be scripted safely).
