---
title: 'Story 2.3: Expand, collapse, drag, auto-layout'
type: 'feature'
created: '2026-10-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5e10f4026658b9c9ac5ccf8e0f3787165637dbed'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Project cards are inert and childless: nothing can be moved, nothing opens, and the layout that Epics 3 and 5 will fill with sessions and branches does not exist, so the graph cannot yet be kept readable.

**Approach:** Every node becomes draggable with its position persisted by Rust. A project **expands** (chevron on the card, context menu, palette) to show its **children** in a stable column under it and **collapses** back to a count badge; `Project.expanded` is persisted. Children are derived in Rust (`graph::children`) from `workspace.sessions` and `workspace.branches` into a type-independent `ChildNode { id, projectId, kind: session|branch, label, detail?, position? }` list carried on the snapshot; Epic 3/5 replace the derivation, not the layout. Because nothing real exists yet, an **off-by-default stub source** (`SWITCHBOARD_STUB_CHILDREN=n`, read once at startup, max 50) yields `n` session stubs per project so layout, drag and persistence can be proven. A child dragged off its column keeps that position (relative to the parent, so moving the parent moves the group) across restarts; **Re-layout children** clears them. Three thin commands: `workspace_set_expanded`, `workspace_move_node`, `workspace_relayout_children`.

**Decisions (recorded):** Child positions are **relative to the parent card's top-left** and stored where the v1 schema already reserves them (`SessionRef.position`, `BranchNode.position`); dragging a session child that has no `SessionRef` yet creates one holding just `sessionId`, `projectId`, `position` (that is what the record is for); Re-layout removes a `SessionRef` left with no label, pin, branch or position. xyflow `parentId` does the group move; child flow-node ids are `session:<id>` / `branch:<id>`, project ids stay bare. Column: indent 16 px, first child 12 px under the card (`y = 92`), children 40 px tall with 8 px gaps; order is Rust's (`sessions` in list order, then `branches`). A **single click selects** one node (outline in `--fg`, never the accent), click on empty canvas or Esc clears; selection is the target of the new palette commands and the menu; arrow-key navigation and Enter stay in 2.4. A **minimal context menu** arrives now (right-click on a project card: Expand or Collapse, Re-layout children), fed by registry commands tagged `menu: "node"` so 2.4 only adds entries; child cards have no menu yet; a right-button *drag* (pan) never opens it. Expand and collapse are two commands with exclusive `when`s (`project.expand` / `project.collapse`), like the two Esc commands; the chevron selects the card then runs the applicable one. The chevron and badge render only when the project has children. Esc precedence becomes context menu → palette → pane → selection. The drag threshold is 4 px so a click never writes a position; while a drag is in progress the node's position comes from a local override that is cleared when Rust's snapshot with the final position is applied, so a status event mid-drag cannot snap the node back. `SessionNode` and `BranchNode` components exist as thin wrappers over one child card (label, muted detail, 208 × 40).

## Boundaries & Constraints

**Always:** Rust is the source of truth: `expanded`, every position and the child list come from the snapshot; the frontend keeps only transient drag overrides, selection and the open menu. Every mutation bumps `revision`, persists atomically (outside the lock) and emits `workspace://changed`; the read-only guard applies. Every new action is a registry command with a `when` clause; buttons and menu items run commands. Tokens only; accent on nothing here. Nodes and the derivation stay memoised: with 50 nodes on screen a pan or drag re-renders only what moved. Linux and Windows CI stay green.

**Never:** No real sessions or branches (Epics 3/5), no edges or handles (Epic 6), no arrow-key navigation, Enter default action or the other project actions (2.4), no node removal, no label editing, no stub children unless the env var is set, no writes under `~/.claude`. Do not persist stub children themselves (only a dragged stub's `SessionRef`). Do not let xyflow own selection or positions (`selectNodesOnDrag=false`, selection changes ignored).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Expand | `SWITCHBOARD_STUB_CHILDREN=3`, click chevron (`▸ 3`) on `ide` | three `session 1..3` cards in a column under `ide`, chevron `▾`, badge gone; `expanded: true` in `workspace.json` | — |
| Collapse | chevron / menu / palette "Collapse project" | children disappear, badge `3` returns, `expanded: false` persisted | — |
| No children | env var unset, project card | no chevron, no badge; `project.expand` absent from palette and menu for it | — |
| Drag project | drag `ide` 120 px right, release | card and its children move together; `position` written once, at release | write failure → `workspace.write` banner, node stays where dropped |
| Drag child | drag `session 2` out of the column, release; restart | it stays there (relative to `ide`), survives restart via `sessions[].position`; the other two keep their column slots | — |
| Re-layout | menu → "Re-layout children" on `ide` | `session 2` snaps back to slot 2; its bare `SessionRef` is removed from the file | — |
| Click vs drag | mousedown + release within 4 px | selects, writes nothing | — |
| Right-drag | right-button drag starting on a card | no menu; no pan either (amended 2026-10-17 by Emils: xyflow tags draggable nodes `nopan`, so a right-drag pans only from empty canvas; middle-drag and Space+drag pan from anywhere, cards included) | — |
| Right-click | right-click on a card | card selected, menu at the pointer (clamped to the window): Expand or Collapse, Re-layout children; Esc / outside click / item closes | — |
| Esc order | menu + palette + pane all open | Esc closes the menu, then the palette, then the pane, then clears selection | — |
| Mid-drag event | git status event arrives during a drag | dragged node keeps following the pointer | — |
| Unknown id | `workspace_set_expanded("nope", true)` | `Err("unknown project")`, nothing written | surfaced as `workspace.load` banner |
| Snapshot | any | `snapshot.children` lists every child of every project (collapsed ones too) with `position: null` unless dragged | — |

</frozen-after-approval>

## Code Map

- `src-tauri/src/graph/mod.rs` -- `Project.expanded`, `SessionRef.position`, `BranchNode.position` already modelled (`Option<Position>`); `WorkspaceSnapshot { path, workspace, banners, revision }` — add `children: Vec<ChildNode>`; mutation pattern = `set_viewport`/`add_projects` (lock → mutate → `revision += 1` → `write_target()` → `persist_and_emit` outside the lock). Add `ChildNode`, `ChildKind`, `NodeKind`/`NodeTarget { kind, id }`, `children(&Workspace, stubs) -> Vec<ChildNode>`, `set_expanded`, `move_node`, `relayout_children`. `snapshot_serialises_with_the_keys_the_ui_reads` test must gain `children`.
- `src-tauri/src/settings/mod.rs` -- `AppState` (`workspace: RwLock<WorkspaceState>`, `claude_home: OnceLock<PathBuf>`): add `stub_children: OnceLock<usize>` (set in `setup` before `graph::initialise`); `initialise_at` copies it into a new `WorkspaceState.stub_children: usize` so `snapshot(&self)` stays pure and tests set it directly on the state.
- `src-tauri/src/lib.rs` -- `with_commands` registers commands (add three); `setup` reads env `SWITCHBOARD_STUB_CHILDREN` (`std::env::var`, parse, clamp 0..=50) into state before `graph::initialise`. Wire tests in `mod tests` use `invoke_with(webview, cmd, InvokeBody::Json(args))`.
- `src-tauri/src/ipc/mod.rs` -- command style: async for anything that writes (`workspace_set_viewport`), `Result<_, String>` for validation errors.
- `src/ipc/index.ts` -- types mirror Rust (`Project`, `SessionRef`, `WorkspaceSnapshot`, `Commands` map); add `ChildNode`, `NodeKind`, `NodeTarget`, three wrappers.
- `src/canvas/nodes.ts` -- `toFlowNodes(projects, statuses, flashed)` pure; `CARD_WIDTH 240`, `CARD_HEIGHT 80`, `cardTopLeft`; extend the signature (children, selection, dragOverrides), add child nodes with `parentId`, `layoutChildren`, `childFlowId`/`parseFlowId`, constants `CHILD_WIDTH 208`, `CHILD_HEIGHT 40`, `CHILD_GAP 8`, `COLUMN_INDENT 16`, `COLUMN_TOP 92`. Keep status/path helpers untouched. `nodes.test.ts` asserts `draggable: false`/`selectable: false` today — update.
- `src/canvas/Canvas.tsx` -- `Flow`: `nodes` memo, `NODE_TYPES = { project }`, props `nodesDraggable={false}`, `elementsSelectable={false}`, `panOnDrag={[1,2]}`, `onInit`, `onMoveEnd`, drop listener. Add `session`/`branch` node types, `nodesDraggable`, `nodeDragThreshold={4}`, `selectNodesOnDrag={false}`, `onNodesChange` (position changes → overrides only), `onNodeDragStart` (select), `onNodeDragStop` (→ `moveNode`), `onNodeClick`, `onPaneClick`, `onNodeContextMenu` (+ pointer-moved guard), keep `onSelectionChange` unused.
- `src/canvas/ProjectNode.tsx`, `src/canvas/nodes.css` -- card markup (`project-node-head`, `.is-flash` outline pattern to reuse for `.is-selected`); add chevron+badge button and the child card styles. New `src/canvas/ChildNode.tsx` (`SessionNode`, `BranchNode`).
- `src/state/canvas.ts` -- `CanvasInstance` structural type, `useCanvasStore { instance, element, fitView }`; add `dragging: Readonly<Record<string, Position>>` + `setDragPosition`/`clearDrag`.
- `src/state/ui.ts` -- `pane`, `flashed`; add `selection: NodeTarget | null`, `contextMenu: { x, y } | null`, actions; `isPaneOpen` pattern for new `when` helpers (`hasSelection`, `isContextMenuOpen`, `selectedProject()`).
- `src/commands/registry.ts` -- `Command { id, title, keybinding?, when?, hidden?, run }`; add optional `menu?: "node"`; `listCommands` sorts by title. `src/commands/builtins.ts` -- the list and the Esc pair (`palette.close`, `pane.close` with exclusive `when`s); add `contextMenu.close`, `selection.clear`, `project.expand`, `project.collapse`, `project.relayout`. `src/commands/keybindings.ts` dispatcher: first enabled match wins — order the Esc commands by `when`, not position.
- `src/commands/projects.ts` -- action style (`addProjectsAt`: invoke → `applySnapshot` → `setLoadError(null)`; failures → `reportToWorkspace`); add `src/commands/nodes.ts` with `moveNode`, `setExpanded`, `relayoutChildren`, `openContextMenuFor`.
- `src/components/Palette.tsx`, `src/components/shell.css` (`.palette`, `.palette-row`, `.is-selected`) -- styling and roving-focus pattern for the new `src/components/ContextMenu.tsx`; `src/App.tsx` renders panes/palette — add `<ContextMenu />`.
- `README.md` -- Workspace section: add expand/collapse, drag, re-layout, context menu, the stub env var.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/graph/mod.rs` -- `ChildNode`/`ChildKind`/`NodeKind`/`NodeTarget`; `children()` (sessions then branches; stubs `stub-{i}-{project_id}` labelled `session {i}`, detail `stub`; position from the matching ref; refs for undiscovered sessions yield nothing); `set_expanded`, `move_node` (project absolute; session upserts `SessionRef`; branch sets `position`; non-finite/unknown → `Err`), `relayout_children` (clears positions, prunes bare refs); snapshot gains `children`; tests for each incl. persisted file, revision, read-only guard -- the model
- [x] `src-tauri/src/settings/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/ipc/mod.rs` -- `stub_children` state + env read (clamped); commands `workspace_set_expanded`, `workspace_move_node`, `workspace_relayout_children`; wire tests -- wiring
- [x] `src/ipc/index.ts` (+test) -- types and wrappers -- IPC surface
- [x] `src/canvas/nodes.ts` (+test) -- `layoutChildren`, child flow ids, `toFlowNodes` with children (hidden when collapsed), `parentId`, relative positions, `selected`, drag overrides; nodes draggable -- derivation
- [x] `src/state/ui.ts` (+test), `src/state/canvas.ts` (+test) -- selection, context menu, drag overrides -- state
- [x] `src/commands/registry.ts`, `src/commands/nodes.ts` (+test), `src/commands/builtins.ts` (+test) -- `menu` tag; actions; five commands with `when`s; Esc precedence test (menu → palette → pane → selection) -- commands
- [x] `src/canvas/Canvas.tsx`, `src/canvas/ProjectNode.tsx`, `src/canvas/ChildNode.tsx`, `src/canvas/nodes.css` -- drag/select/menu handlers with the right-drag guard; chevron + badge; child cards; `.is-selected` outline -- the canvas
- [x] `src/components/ContextMenu.tsx`, `src/components/shell.css`, `src/App.tsx` -- menu listing `menu: "node"` commands, clamped to the window, ↑/↓/Enter/Esc, closes on outside click and blur -- the menu
- [x] `README.md` -- expand/collapse, drag, re-layout, menu, `SWITCHBOARD_STUB_CHILDREN` -- docs

**Acceptance Criteria:**
- Given `SWITCHBOARD_STUB_CHILDREN=3` and a project on the canvas, when I click its chevron, then three session cards appear in a column under it (x +16, y 92, 140, 188 relative), the badge disappears, and `workspace.json` has `expanded: true`; clicking again hides them and shows `3`.
- Given an expanded project, when I drag a child away and restart the app, then the child is where I left it relative to its parent, dragging the parent moves both, and "Re-layout children" from the right-click menu returns it to its slot and removes its bare `SessionRef`.
- Given the palette, when a project is selected, then exactly one of "Expand project"/"Collapse project" is listed plus "Re-layout children"; with nothing selected none of them is.
- Given `cargo test`, `cargo clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass: Rust covers `children`, the three mutations and their wire names; vitest covers `layoutChildren`, `toFlowNodes` with children/selection/overrides, the stores, the commands' `when`s and the Esc order.

## Implementation Notes

- Right-click guard: implemented on pointer events rather than `onNodeContextMenu`. A button-2 `pointerdown` on a node wrapper (xyflow's `data-id`) records the point; the matching `pointerup` at most 4 px away (`rightClickTarget` in `nodes.ts`, strict `>` for "moved", as xyflow's drag threshold) selects the node and, for a project, opens the menu; a child is only selected (no menu yet); further away it was a pan. `contextmenu` itself is only ever `preventDefault`ed on the canvas. Reason: webkit2gtk (Linux) fires `contextmenu` on press, so a `contextmenu`-driven menu would open at the start of every right-drag pan there; deciding at release behaves the same on both platforms. Observable behaviour matches the matrix rows "Right-drag" and "Right-click". Keyboard-invoked context menus (Shift+F10 / Menu key) do nothing until 2.4's keyboard work.
- `toFlowNodes` takes an inputs object (`{ projects, statuses, flashed, children, selection, dragging }`) plus the previous result, and reuses a node object whenever everything it renders is unchanged (fields compared by value, since every snapshot carries fresh objects). Collapsed children are omitted from the node list rather than marked `hidden`. xyflow's `selected` is never set; the selected flag lives in `data`, so `elementsSelectable={false}` keeps xyflow out of selection entirely.
- `project.relayout` is enabled for any selected project (also one without children), so the menu is never empty; `project.expand`/`project.collapse` additionally require children, as the matrix says.
- `set_expanded` always bumps the revision and writes, even when `expanded` already had that value (same shape as `set_viewport`).
- `moveNode` clears the drag override only while it still holds the position that call sent, so a reply to an earlier drag cannot wipe a newer drag of the same node. `move_node` (session arm) matches the `SessionRef` on both `session_id` and `project_id`, as `children()` does. The context menu closes on outside `pointerdown` (capture), window `blur` and when it has no rows left; it has no element-level blur handler (WebKit does not focus a button on mousedown).
- Mutation failures surface as the `workspace.load` banner with a prefix naming the action (`node move failed: …`, `expand failed: …`, `collapse failed: …`, `re-layout failed: …`); a write failure keeps the in-memory position and shows Rust's `workspace.write` banner, as before.
- Verification run (2026-10-17, Windows): `cargo test` 192 passed; `cargo clippy --all-targets -- -D warnings` clean; `npm test` 215 passed (16 files); `npx tsc --noEmit` clean; `npx vite build` bundles. The desktop app was not launched (session constraint), so the manual checks (expand/drag/relaunch, 55-node pan) remain to be done.

- Orchestrator (2026-10-17, review + GUI): all three review layers triaged above; 11 patch groups applied by the implementer and re-verified (`cargo test` 193, vitest 223, clippy and `tsc` clean, debug build). GUI pass (foreground-guarded, `SWITCHBOARD_STUB_CHILDREN=3`, two planted projects): a click on the path row selects without writing; palette "Expand project" shows the three-child column and persists `expanded: true`; dragging `session 2` persisted a `sessions[]` ref at (160, 197) relative and dragging the parent persisted x 195; both survived a relaunch; the right-click menu listed Collapse project / Re-layout children, Re-layout pruned the ref; Esc closed the menu first, then cleared the selection; 55 nodes (5 projects × 10 stubs) panned by middle-drag at about 1% of one core with 31 MB RSS. A first run's "failures" were script coordinates (a click on the chevron, the palette left open, a right-click just off the card) and are not findings. One real finding, GUI1, is in the triage log and was settled by amending the matrix row. The 2.2-era README sentence "a right-button drag pans, as before" was corrected accordingly.
- Orchestrator (2026-10-17, close): committed `cc6f4b0`, pushed; CI run 39038541128 green on ubuntu-24.04 and windows-latest at the first attempt. Nothing deferred beyond the one `deferred-work.md` entry (automated check of the stub env var's startup ordering).

## Spec Change Log

- 2026-10-17 (GUI1, human decision): the frozen matrix row "Right-drag" was amended by Emils from "pans; no menu" to "no menu; no pan either", because xyflow blocks mouse pans that start on a draggable node. Known-bad state avoided: a hand-rolled right-button pan handler duplicating xyflow's gesture. KEEP: the pointer-based right-click guard (press/release within 4 px on a project card opens the menu; farther is nothing), the `rightClickTarget` helper and its tests.

## Review Triage Log

Pass 1 (2026-10-17) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- BH1 / VG-o / EC1 / EC11 `move_node` (session) upserts the ref by `session_id` alone while `children()` matches `session_id` and `project_id`; a ref under another project (hand-edited file) takes the position and the child snaps back forever — **low** (hand-edited only, but a direct correction): patch — match both fields; test.
- BH3 menu closes on element `blur`; WebKit (webkit2gtk, Linux) does not focus a button on mousedown and blurs the active element with `relatedTarget: null`, so pressing an item unmounts the menu before `click` — **medium** (menu unusable by mouse on Linux): patch — close on window `blur` instead; outside clicks are already the capture `pointerdown`.
- BH4 / VG1 / VG2 / VG3 right-click decision, drop target construction, the chevron's command choice and the menu's item filter live inside components and no test executes them (vitest is node-only; demonstrated by inverting each and keeping 215 green) — **low** (pre-verified): patch — extract `rightClickTarget`, `dropTarget`, `chevronCommandId` (canvas/nodes.ts) and `nodeMenuCommands()` (commands/nodes.ts) and test them; components keep only the wiring.
- BH5 / EC6 a second drag of the same node before the previous `moveNode` resolves has its live override wiped by the first drop's `finally` — **low**: patch — clear only when the override still equals the position sent.
- BH6 right-click on a child card does nothing, not even select, while the native menu is suppressed — **low**: patch — select the child; no menu (spec: child cards have no menu yet).
- BH7 / EC9 the "No actions" row is unfocusable and the menu lingers when its items empty while open (selected project leaves the snapshot) — **low**: patch — close when `items` is empty; drop the branch.
- BH10 cards set `cursor: default`, hiding xyflow's grab cursor now that nodes drag — **low**: patch — `grab`, `grabbing` while dragging.
- EC4 `dragging[id]` on a plain object returns `Object.prototype` members for ids such as `constructor` — **low** (hand-edited id): patch — `Object.hasOwn` at both lookups.
- EC8 the right-click guard uses `>= 4` while xyflow 12.12 starts a drag at `> 4` (client pixels, verified in `@xyflow/system`) — **low**: patch — `>`.
- BH11 `sameProject` ignores fields a card does not render; a future rendered field must be added or the card goes stale — **low**: patch — comment at the comparator and a test pinning the compared fields.
- BH9 / BH12 README omits the env var's clamp/blank/unset behaviour and that stale `sessions[]` refs are kept verbatim — **low**: patch — one sentence each.
- VG4 `SWITCHBOARD_STUB_CHILDREN` works only because `setup` sets the lock before `graph::initialise`; the Wry-only closure is not executed by any test — **low** (pre-verified, filed as defer): defer — the GUI pass launches with the variable set and would show it; an automated check needs an injectable config path.
- BH2 README's "4 px" is CSS pixels but xyflow measures the threshold in flow coordinates — **false**: `@xyflow/system` 12.12 (`XYDrag`, "Calculate distance in client coordinates for consistent drag threshold behavior across zoom levels") uses `getEventPosition` client deltas.
- BH8 `relayout_children` writes and bumps the revision when nothing changed — **low**: rejected — same always-write shape as `set_viewport`/`set_expanded`; a no-op write per menu use is harmless and the guard adds a branch.
- EC2 an orphan branch (hand-edited, `project_id` matching no project) accepts a position — **low**: rejected — unreachable from the UI (no node is rendered for it); Epic 5 creates branches and owns their validation.
- EC3 `validate` dedupes project ids only; duplicate branch ids would collide as React keys — **low**: rejected — no branch is ever created before Epic 5, which owns that validation.
- EC5 a project id beginning with `session:` parses as a child — **low**: rejected — ids are UUID v4; changing the id scheme contradicts the frozen decision for a hand-edited case.
- EC7 the dragged node leaving the node list mid-drag leaves a stale override — **low**: rejected — needs a collapse or removal to land during a pointer drag (removal is 2.4); the next drag or snapshot of that id clears it.
- EC10 the menu is not re-clamped on window resize — **low**: rejected — rare and the menu closes on any click.
- GUI1 (orchestrator, GUI pass) a right-drag starting on a card no longer pans (the 2.2 binary did, verified on a baseline worktree build) — **medium**, intent-level: xyflow adds `nopan` to every draggable node wrapper and its pan filter rejects any mouse press inside it (only button 1 is special-cased through); middle-drag and Space+drag from a card still pan. Resolved by Emils amending the frozen matrix row rather than adding a manual right-button pan handler.

## Design Notes

- Drag flow: `onNodesChange` keeps only `type: "position"` changes with a `position`, writing them to `canvas.dragging[flowId]`; `toFlowNodes` applies overrides last, so only the dragged node object changes identity per frame. `onNodeDragStop` → `moveNode(target, node.position)` (relative for children, as xyflow reports it) → Rust snapshot → `applySnapshot` → `clearDrag(flowId)` in that order, so there is never a frame without a position.
- Right-click guard: record the button-2 `pointerdown` point and the node under it (xyflow's `data-id`); the matching `pointerup` within 4 px on a project node opens the menu, further away it was a pan. `contextmenu` is only ever `preventDefault`ed (webkit2gtk fires it on press, so it cannot be the trigger).
- Snapshot shape: `{ path, workspace, banners, revision, children: [{ id, projectId, kind, label, detail, position }] }` with camelCase keys, `position: null` for column children.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): launch with `SWITCHBOARD_STUB_CHILDREN=3` and the three planted projects; expand `ide`, drag a child, drag the parent, right-click → Re-layout, collapse, relaunch and confirm positions and `expanded`; then `SWITCHBOARD_STUB_CHILDREN=10` with five projects expanded (55 nodes) and a pan, watching for visible stutter and that CPU settles afterwards (the 2.1 budget).
