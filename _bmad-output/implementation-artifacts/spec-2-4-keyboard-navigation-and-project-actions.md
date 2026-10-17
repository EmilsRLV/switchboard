---
title: 'Story 2.4: Keyboard navigation and project actions'
type: 'feature'
created: '2026-10-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '50a159085bbad9ec33b4a883db1cfd89825cc36c'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Selection exists but the keyboard cannot move it, and a project card offers only expand/collapse and re-layout: none of the actions the product is for (start a session, open a terminal, open the folder elsewhere, find its Claude transcripts, take it off the canvas) is reachable.

**Approach:** Four **arrow commands** move the selection to the nearest node in that direction (a pure spatial search over the rendered cards: projects and the children of expanded projects), panning minimally when the new node is off screen; **Enter** runs the selected node's default action; Esc already clears. Six **project actions**, each a registry command tagged for the node menu with a `when` clause, appear in the right-click menu and the palette: **New session…** and **Plain terminal…** (stubs until Epic 4), **Open in external editor**, **Open in file manager**, **Reveal Claude project dir**, **Remove from canvas**. The three "open" actions and removal are thin Tauri commands; the file-manager and reveal actions reuse `tauri-plugin-opener` from Rust. A **transient notice** (3 s, muted, in the banner strip) tells the operator what a stub will do later or why an action could not run.

**Decisions (recorded):** Arrow search: candidates are nodes whose centre lies in the half-plane of the direction from the selected node's centre; rank by primary-axis distance plus twice the perpendicular distance; none → selection stays. With nothing selected, any arrow selects the node nearest the viewport centre. Node rectangles come from the same geometry the canvas draws (project 240 × 80 at its position; child 208 × 40 at parent + relative position; collapsed children are not candidates). After a move, if the selected rectangle is not fully inside the canvas (16 px margin), the viewport pans by the smallest delta that shows it (150 ms, zoom unchanged); xyflow's `setCenter` is not used (it zooms to `maxZoom`). The arrow and Enter commands are enabled only with no palette, pane or menu open; the `n`, `e` and `/` keys stay unbound. **Enter's default action:** a project with children toggles expand/collapse; a childless project and child cards do nothing (sessions attach in Epic 3). **Menu order** is fixed, not alphabetical: `Command.menuOrder` (new session 10, plain terminal 11 · open in editor 20, open in file manager 21, reveal Claude dir 22 · expand/collapse 30, re-layout 31 · remove 40), with a 1-px separator wherever the tens digit changes; the palette keeps its title order. **Stubs** show the notice "New session arrives in Epic 4" / "Plain terminal arrives in Epic 4". **Open in external editor** runs the program named by the first token of `settings.external_editor` with the project folder as its only argument (the `{file}`/`{line}` form is for Epic 7's file opens); the program is resolved like detection does (PATH + `PATHEXT`, so `code` finds `code.cmd`), a `.cmd`/`.bat` goes through `cmd /C` with no console window, the child is detached (not waited on), and an unset editor is the notice "No external editor configured — set external_editor in settings". **Open in file manager** opens the folder itself (`open_path`). **Reveal Claude project dir** opens `~/.claude/projects/<dir>` for the first discovered dir whose cwd is the project's path (same comparison as the import pane), else the notice "No Claude project directory for this folder". **Remove from canvas** is immediate (no confirmation, no key): Rust drops the project, its session refs and branches, every edge touching any of them, and its live git status, then emits both snapshots; the frontend clears the selection when it pointed at the removed project. Action failures (opener error, spawn error) are notices naming the cause, never persistent banners; a removal failure is the `workspace.load` banner like other mutations. The notice is UI state (`ui.notice`), one at a time, newest wins, and renders in the banner strip without the accent (it is information, not attention).

## Boundaries & Constraints

**Always:** Every key goes through the registry and the one dispatcher; xyflow's own keyboard handling stays off (`nodesFocusable={false}`, `disableKeyboardA11y`). Rust owns the workspace and performs every external action; the webview never spawns processes or touches the file system. Nothing is written under `~/.claude`; the reveal only opens a directory that already exists. Tokens only; the accent appears only on existing attention banners. Both CI runners stay green (path handling and process spawning must compile and pass on Linux).

**Never:** No real session or terminal launch (Epic 4), no `n`/`e`/`/` bindings, no edge handling, no Delete key, no confirmation dialog, no undo, no label editing, no multi-selection, no changes to how the menu opens (2.3's guard stays).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Arrow move | `ide` at (80,80) selected; `projects` at (480,80); `→` | selection moves to `projects`; `←` moves back; `↓` with `ide` expanded moves to `session 1` | no candidate → selection unchanged |
| Off-screen target | `→` to a node outside the view | viewport pans just enough to show it (16 px margin), zoom unchanged | — |
| No selection | nothing selected, two nodes, `↓` | the node nearest the viewport centre is selected | no nodes → nothing |
| Enter | project with children selected | expand; again → collapse; `expanded` persisted | childless project / child card → nothing |
| Keys while UI open | palette, pane or menu open; arrows / Enter | the open surface handles them; the selection does not move | — |
| Menu contents | right-click `ide` | New session…, Plain terminal… ┃ Open in external editor, Open in file manager, Reveal Claude project dir ┃ Expand/Collapse project, Re-layout children ┃ Remove from canvas | — |
| Stubs | New session… / Plain terminal… | notice "… arrives in Epic 4" for 3 s; nothing else | — |
| Editor | `external_editor` = `code -g {file}:{line}`, Open in external editor | `code <folder>` launched detached; no notice | unset → notice; spawn failure → notice with the cause |
| File manager | Open in file manager | the folder opens in Explorer / the desktop's file manager | opener error → notice |
| Reveal | `B:\projects\ide` with a Claude project dir | `~/.claude/projects/B--projects-ide` opens | none → notice |
| Remove | Remove from canvas on `ide` (expanded, a dragged child, a live status) | card and children vanish; `workspace.json` has no project, session ref or branch for it; `projects://status` no longer lists it; selection cleared | unknown id → `Err("unknown project")` → `workspace.load` banner |
| Palette | `ide` selected | lists the six actions by title (plus 2.3's); nothing selected → none of them | — |

</frozen-after-approval>

## Code Map

- `src/commands/registry.ts` -- `Command { id, title, keybinding?, when?, hidden?, menu?, run }`; `listCommands` sorts by title. Add `menuOrder?: number`. `src/commands/nodes.ts` -- `nodeMenuCommands()` (enabled `menu: "node"`), `mutate()` pattern, `moveNode`/`setExpanded`/`relayoutChildren`, `openContextMenuFor`. Sort `nodeMenuCommands()` by `menuOrder` then title; add the six actions and the arrow/Enter actions here or in a new `src/commands/navigation.ts`.
- `src/commands/builtins.ts` (+test) -- the 16 commands; `when` helpers `selectedProject()`, `isPaneOpen`, `isContextMenuOpen`, `isPaletteOpen` (local); Esc chain. Add `selection.move.{left,right,up,down}` (`arrowleft`… bindings, hidden), `selection.activate` (`enter`, hidden), `project.newSession`, `project.terminal`, `project.openEditor`, `project.openFolder`, `project.revealClaudeDir`, `project.remove`. Existing test asserts 16 commands and the visible list — update.
- `src/commands/keybindings.ts` -- dispatcher; arrows/Enter pass even in editable targets (`EDITABLE_PASS_KEYS`), so the `when`s must exclude open surfaces. `KEY_ALIASES` has `up/down/left/right`.
- `src/canvas/nodes.ts` (+test) -- `CARD_WIDTH/HEIGHT`, `CHILD_*`, `COLUMN_*`, `columnSlot`, `layoutChildren`, `toFlowNodes`, `flowIdOf`/`parseFlowId`, `chevronCommandId`. Add pure geometry: `nodeRects(projects, children) -> { target: NodeTarget; x; y; width; height }[]` (absolute, expanded children only), `nearestInDirection(from, rects, dir)`, `nearestToPoint(rects, point)`, `panToReveal(rect, viewport, size, margin) -> Viewport | null`.
- `src/state/canvas.ts` -- `CanvasInstance { getNodes, getViewport, setViewport, fitView, screenToFlowPosition }`, `useCanvasStore { instance, element, dragging }`, `viewportCentre()`, `isCanvasReady`. The element rect gives the canvas size for `panToReveal`.
- `src/state/ui.ts` (+test) -- `selection`, `contextMenu`, `select`/`clearSelection`, `selectedProject()`. Add `notice: { text } | null`, `showNotice`/`clearNotice`; a timer helper like `flashProjects` in `src/commands/projects.ts` (`Timers` type, per-id map) for the 3 s.
- `src/components/Banners.tsx`, `src/components/shell.css` (`.banners`, `.banner` with accent border and mark) -- append the notice as a `.banner.is-notice` row (border/mark in `--fg-muted`, no accent). `src/components/ContextMenu.tsx` -- renders `nodeMenuCommands()`; add the separator when `Math.floor(menuOrder / 10)` changes.
- `src/canvas/Canvas.tsx` -- `<ReactFlow … nodesFocusable={false}>`; add `disableKeyboardA11y`. Nothing else here: navigation is commands over store state.
- `src/ipc/index.ts` (+test) -- wrappers + `Commands` map; add `projectOpenEditor`, `projectOpenFolder`, `projectRevealClaudeDir`, `workspaceRemoveProject`.
- `src-tauri/src/ipc/mod.rs` -- `settings_reveal` shows the opener pattern (`app.opener().reveal_item_in_dir` / `open_path`); `claude_projects_list` shows the `claude_home` + `list_projects` + `graph::same_path` lookup to reuse for the reveal. Add the four commands; `src-tauri/src/lib.rs` registers them (wire tests via `invoke_with`).
- `src-tauri/src/graph/mod.rs` -- mutation pattern (lock → mutate → `revision += 1` → `write_target()` → `persist_and_emit`); `Workspace { projects, branches, sessions, edges }`, `Edge { from: NodeRef{kind,id}, to }`. Add `remove_project(app, project_id) -> Result<WorkspaceSnapshot, String>` with the cascade; tests incl. file contents and that other projects' refs survive.
- `src-tauri/src/git/poll.rs` + `settings/mod.rs` (`LiveState.statuses`, `write_live`, `projects://status` emit in `store`/line ~130) -- remove the id from the live map and emit when the project goes.
- `src-tauri/src/settings/detect.rs` -- `Search { path_dirs, extra_dirs, extensions }`, `Search::locate(name) -> Option<Located{path}>`, `platform_extensions()`; use `Search::path_only()` semantics (PATH + PATHEXT) to resolve the editor program. `src-tauri/src/process.rs` -- `run()` waits with a timeout and `CREATE_NO_WINDOW`; the editor needs a *detached* spawn instead: a new `process::spawn_detached(cmd)` (same no-window flag, `Stdio::null()`, child handle dropped or reaped on a thread).
- `src-tauri/src/settings/mod.rs` -- `Settings.external_editor: Option<String>` (template, default `code -g {file}:{line}` when `code` is on PATH); `AppState.read()` for settings, `claude_home: OnceLock<PathBuf>`.
- `README.md` -- Keys table (arrows, Enter), palette list, "Selecting, dragging, expanding" (menu contents/order, actions, stubs, notice), settings table row for `external_editor` (how the folder open uses it).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/graph/mod.rs` -- `remove_project` cascade (project, its `sessions`, `branches`, edges touching any removed id); `Err("unknown project")`; tests: file contents, revision, emit, other project untouched, read-only guard -- the model
- [x] `src-tauri/src/process.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` -- `spawn_detached`; `project_open_editor` (template's first token, resolved via `Search`, `.cmd`/`.bat` via `cmd /C`, folder as the only argument; `Err` for unset editor / unknown project / spawn failure), `project_open_folder` (opener `open_path`), `project_reveal_claude_dir` (discovery lookup, opener; `Err` when none), `workspace_remove_project` (+ live status prune and `projects://status` emit); wire tests (editor test points `external_editor` at a script fixture that writes its argv to a file) -- wiring
- [x] `src/ipc/index.ts` (+test) -- four wrappers -- IPC surface
- [x] `src/canvas/nodes.ts` (+test) -- `nodeRects`, `nearestInDirection` (half-plane, weighted distance, ties by title order), `nearestToPoint`, `panToReveal`; tests for the matrix's arrow rows and the no-candidate case -- geometry
- [x] `src/state/ui.ts` (+test), `src/commands/navigation.ts` (+test) -- notice state + 3 s timer; `moveSelection(dir)` (select, then pan via the canvas store when needed), `activateSelection()` -- navigation
- [x] `src/commands/registry.ts`, `src/commands/nodes.ts` (+test), `src/commands/builtins.ts` (+test) -- `menuOrder`; ordered `nodeMenuCommands()`; eleven new commands with `when`s; tests: arrows inert with palette/pane/menu open, Enter toggles, the six actions enabled only with a project selected, stubs produce the notice, failures produce notices -- commands
- [x] `src/components/ContextMenu.tsx`, `src/components/Banners.tsx`, `src/components/shell.css`, `src/canvas/Canvas.tsx` -- separators; notice row without accent; `disableKeyboardA11y` -- UI
- [x] `README.md` -- keys, palette, menu, actions, notice, editor behaviour -- docs

**Acceptance Criteria:**
- Given two project cards side by side, when I press `→` then `←`, then the selection outline moves to the right card and back; with the left one expanded, `↓` selects its first child; a target off screen is panned into view without a zoom change.
- Given `ide` selected, when I open the right-click menu, then it lists the eight entries in the fixed order with separators, and the palette lists the six new actions by title; with nothing selected the palette lists none of them.
- Given `ide` selected, when I run Open in file manager, then Explorer opens the folder; Reveal Claude project dir opens its `~/.claude/projects` directory; New session… shows the 3 s notice; Remove from canvas removes the card, its children and its status and clears the selection, and a relaunch does not bring it back.
- Given `cargo test`, `cargo clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass: Rust covers `remove_project`, the editor command through a script fixture and the four wire names; vitest covers the geometry helpers, the notice, the navigation actions and the new commands' `when`s.

## Implementation Notes

- The six project actions and the arrow/Enter actions live in a new `src/commands/navigation.ts` (notice timer `notify`, `moveSelection`, `activateSelection`, the two stubs, the three "open" actions); `removeProject` sits with the other mutations in `src/commands/nodes.ts` (it uses the exported `mutate`, so a failure is the `workspace.load` banner `remove failed: …`). No import cycle: `navigation` imports `nodes`, not the reverse.
- `remove_project` also removes a stub session's edges (ids from `children()`), not only the ids in `sessions[]`, since a stub child can be an edge end without having a ref. An edge whose `folder` end names the project's path is not a node edge and is kept.
- The live-status prune is `git::poll::forget(app, id)`: it takes the refresh lock, so a pass that started before the removal cannot resurrect the entry; `workspace_remove_project` awaits it after `graph::remove_project`, so the reply carries the workspace snapshot and `projects://status` is emitted before the command resolves.
- Editor resolution: a template whose first token has a directory component (or `~/`) is used as given (must be a file); a bare name goes through `Search::from_env(vec![])` (PATH + `PATHEXT`). This is what lets the wire test point `external_editor` at a script fixture (`process::fixtures::argv_recorder`) instead of a real editor. A template starting with `"` names the quoted program (paths with spaces). The command is always `Command::new(program).arg(folder)`: std (Rust ≥ 1.77) runs a `.cmd`/`.bat` through `cmd.exe` with its own escaping (`%`, trailing `\`), and `spawn_detached` sets `CREATE_NO_WINDOW`; on Unix the child gets its own process group. `project_open_folder` is async so the opener never blocks the main thread. The dispatcher ignores a `defaultPrevented` event, so an Enter handled by the palette or menu does not also run `selection.activate`.
- The opener is reached through `app.try_state::<Opener<R>>()`: on the mock app (no plugin) that is the `Err` "opener plugin not registered", which is how the wire tests prove the lookups (project path, Claude dir) succeed without ever opening Explorer.
- Notice failure texts are Rust's `Err` strings shown verbatim (`NO_EDITOR`, `NO_CLAUDE_DIR` are the spec's exact sentences; other failures are "could not … : <cause>"). Without a Tauri runtime (vitest) the notice is the `NoTauriRuntimeError` message.
- `panToReveal` returns the whole viewport, not a delta; a rect larger than the available area is aligned on its left/top edge.
- Verified with `cargo test` (207 tests), `cargo clippy --all-targets -- -D warnings`, `npm test` (259 tests), `npx tsc --noEmit`; the debug `tauri build` was not run in this session (no GUI / no build permitted), so the manual checks are still open.
- Orchestrator (2026-10-17, review + GUI): three review layers (re-run on Opus after the Fable limit cut the first run short) triaged in the log below; 7 patch items applied and re-verified (`cargo test` 207, vitest 260, clippy and `tsc` clean, debug build). GUI pass (foreground-guarded, `SWITCHBOARD_STUB_CHILDREN=2`, `ide` at (80,80) and `projects` at (480,80)): `→` moved the outline to `projects`, `←` back; Enter expanded `ide` (`expanded: true` on disk), `↓` selected `session 1`, `↑` returned, Enter collapsed; `→` past the last card left the selection and the viewport unchanged; the menu showed the eight entries in the fixed order with three separators; New session… showed the muted notice "New session arrives in Epic 4", gone after 3 s; Open in file manager opened `B:\projects\ide` and Reveal Claude project dir opened `~/.claude/projects/B--projects-ide` (both Explorer windows detected and closed by the script; the operator's own windows untouched); Remove from canvas removed `ide` with its children (`projects` 1, `sessions` 0 on disk) and a relaunch showed only `projects`. A first script's "0 Explorer windows" was its own matching bug, re-checked with a probe. Open in external editor is left to Emils by hand.
- Orchestrator (2026-10-17, close): committed `a245859`, pushed; CI run 39045515131 green on ubuntu-24.04 and windows-latest at the first attempt (the first compile of the Unix `process_group` line). Deferred: one `deferred-work.md` entry (component tests for `Banners`/`ContextMenu`). Open in external editor remains a hand test for Emils.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-17, reviewers re-run on Opus after the Fable limit) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- VG-o1 Enter chosen in the palette or context menu bubbles on to the window dispatcher after the surface has closed synchronously, so `selection.activate` also toggles the selected project (and Remove + Enter sends a stray `workspace_set_expanded`); `handleKeydown` never checks `defaultPrevented` (verified in `keybindings.ts`) — **medium**: patch — skip events already `defaultPrevented`; test the real sequence.
- BH1 / EC1 `editor_program` splits on whitespace, so a quoted program path with spaces (`"C:\Program Files\…\code.cmd" -g …`) becomes `"C:\Program` — **medium**: patch — a leading double-quoted token is the program.
- BH2 / EC2 the hand-built `cmd /C ""prog" "folder""` bypasses std's batch-file escaping: `%VAR%` in a folder is expanded and a drive root `B:\` ends `\"` — **medium**: patch — `Command::new(prog.cmd).arg(folder)`; std (1.77+, here 1.94) runs it through `cmd.exe` and escapes `%` itself (verified in `std/src/sys/args/windows.rs`).
- BH3 `spawn_detached` keeps the editor in the app's process group on Unix, so a Ctrl+C in `tauri dev` or a group kill takes it down — **low**: patch — `process_group(0)` under `cfg(unix)` (one line).
- BH5 `project_open_folder` is a sync command, so Tauri runs it on the main thread and a slow `ShellExecute`/`xdg-open` freezes the window — **low**: patch — `async`.
- EC4 `panToReveal` aligns a rect larger than the view on its *trailing* edge when its leading edge is in view, contrary to its doc, and alternates on repeated reveals — **low**: patch — always the leading edge when it does not fit; fix the test that encodes the trailing case.
- BH4 / EC3 a terminal editor (`vim`) starts with null stdio and no window and nothing is seen — **low**: patch — one README sentence: GUI editors only.
- BH11 README says a removal survives a relaunch, but on a read-only/newer `workspace.json` it is memory-only — **low**: patch — one sentence.
- BH14 README's notice list omits "external editor … does not exist" — **low**: patch.
- VG1 / BH12 no test renders `Banners` (the notice row) or `ContextMenu` (separators); vitest has no DOM environment — **low** (pre-verified, filed as defer): defer — needs a component-test setup; the GUI pass covers both.
- BH7 holding an arrow floods viewport writes — **false**: `handleKeydown` returns at once on `event.repeat` (`keybindings.ts:123`).
- BH8 / EC5 Enter is claimed whenever a node is selected, so a focused button loses its native activation — **low**: rejected — the only focusable button on the canvas is the chevron, whose Enter would run the same toggle; panes and palette disable the command.
- BH6 the notice shifts the canvas when it comes and goes — **low**: rejected — the frozen decision puts it in the banner strip; noted for Story 2.5's visual pass.
- BH9 the notice timer lives in `navigation.ts` while `showNotice` is public — **low**: rejected — `notify` is the only caller.
- BH10 / EC7 removal leaves drag overrides or flash ids for the removed nodes — **low**: rejected — needs a removal during a pointer drag; stale entries are inert and cleared by the next drag/flash.
- EC6 two nodes with identical centres cannot reach each other — **low**: rejected — exact overlap only; drag either one.
- BH13 reveal re-runs discovery on every click and the tie between case-variant dirs is unspecified — **low**: rejected — a click-time read is cheap at this scale; ties are hand-made.
- EC8 / BH12' Tasks say ties go "by title order", code uses list order — **low**: rejected — the fix is a spec edit; Decisions and Design Notes already say list order.
- EC9 `forget` emits `projects://status` only when the id was polled — **false**: an unpolled project has no status to retract; nothing listens for a removal event.

## Design Notes

- Arrow search in words: from the selected rectangle's centre, keep candidates whose centre is strictly in the direction's half-plane (for `→`: `cx > fromCx`); score = `|primary delta| + 2 × |perpendicular delta|`; smallest wins; equal scores fall back to the rects' list order (projects in workspace order, each followed by its children).
- `panToReveal`: convert the rect to screen space with the viewport (`sx = x·zoom + vx`), compute the shift needed on each axis to bring it inside `[margin, size − margin]`, return `null` when both shifts are 0, else the viewport moved by them. The command calls `instance.setViewport(next, { duration: 150 })`; the move ends in `onMoveEnd`, which persists it like any other pan.
- Editor launch on Windows: `Search::locate("code")` yields `…\code.cmd`; `cmd /C "…\code.cmd" "<folder>"` with `CREATE_NO_WINDOW`; on Linux `Search::locate` yields the binary and it is spawned directly. The template's remaining tokens are ignored for a folder open.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): two planted projects with `SWITCHBOARD_STUB_CHILDREN=2`; click to select, `→`/`←`/`↓` and watch the outline; Enter twice; right-click → menu order and separators; New session… notice; Open in file manager (an Explorer window appears, then is closed by the script); Remove from canvas → relaunch → gone. Open in external editor is left to Emils by hand (it would launch his editor).
