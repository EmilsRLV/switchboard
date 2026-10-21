---
title: 'Story 6.1: Draw and persist edges'
type: 'feature'
created: '2026-10-21'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'a2ef38ceeb697580861b108a30add93533efd50e'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The workspace has an `edges` list and an `Edge` model, but nothing creates, shows, labels or deletes an edge, and the canvas has edge interaction switched off. Relationships between sessions and repos therefore exist only in the operator's head.

**Approach:**
- **Creating.** The operator makes an edge by dragging from a node's handle to another node, or from the keyboard with "Link to…" (`e`).
- **Kind and validity.** Rust picks the kind from the pair, refuses invalid pairs, and persists the edge.
- **Drawing.** Context edges are dashed. Cooperate edges are a solid double line.
- **Selecting.** A selected edge can be labelled in a small inspector pane, and deleted with Del.

**Decisions:**
- **Pairs and kinds:**
  - **Context:** from a session or project, to a project or branch. The PRD's project→project context edge is allowed, per Emils' decision, which overrides the story's "project→project refused" example. Folder targets come with Story 6.2.
  - **Cooperate:** session ↔ session. It is undirected.
  - **Refused, each with a notice hint:**
    - a branch as the source;
    - a project to a session;
    - a node to itself;
    - a duplicate: same kind and the same two ends, either direction for cooperate.
  - The notice names the reason, for example `can't link a project to a session` or `already linked`.
- **Rust owns it.** Three commands, each validated, persisted and broadcast like other mutations:
  - `edge_add(from, to)` returns the new edge, with `id` (UUID), kind, `label: null` and `createdAt`.
  - `edge_set_label(id, label)` trims the label, and a blank one becomes `null`.
  - `edge_remove(id)`.
- **Drawing:**
  - **Context edges.** A dashed 1-px `--border-strong` line.
  - **Cooperate edges.** Two parallel 1-px `--border-strong` lines.
  - **Selected edges.** Drawn in `--focus`. No accent.
  - **Labels.** A label shows at the midpoint, in muted `--text-xs` text, ellipsised.
  - **Hidden ends.** An edge whose end node is not drawn (collapsed, cut by a limit, or a stub) is not drawn but stays stored, as fork lines behave.
  - **Fork lines** stay as they are and are not edges.
- **Dragging:**
  - **The handle.** Session and project cards get one source handle on the right, visible on hover or keyboard focus.
  - **Targets.** Any project, branch or session card is a drop target.
  - **Feedback.** An invalid target shows the not-allowed state while dragging. A drop on empty canvas does nothing.
- **Keyboard:**
  - **The command.** "Link to…", key `e` (no longer reserved), in the node menu and the palette, on a selected session or project. It opens the palette as a pick list of that node's valid targets, labelled `<kind>: <target label> (<project>)`. Enter creates the edge, and Esc cancels.
  - **Navigating edges.** Arrow-key navigation does not visit edges.
- **Selecting an edge:**
  - **Click.** Clicking an edge selects it, as a new `edge` selection kind.
  - **The inspector pane.** It shows the kind, both ends and a Label field, saved on Enter or blur, with a Delete button. It closes with Esc.
  - **Del.** Del deletes the selected edge. There is no confirmation: an edge is cheap to redraw.
  - **Delete stays unbound otherwise.** Delete still does nothing when no edge is selected.
- **Pruning:** removing a project already drops the edges touching it, and that stays. An edge to a session or branch that is no longer listed is kept until the project is removed.

## Boundaries & Constraints

**Always:**
- **Rust validates and owns the edges.** The UI sends only `from` and `to`.
- **No `~/.claude` writes.**
- **CI and lint.** Both CI runners stay green, and the design lint passes (tokens only, no accent on edges).

**Never:**
- Any effect on launches or live sessions, which is Stories 6.2–6.4.
- Folder targets.
- MCP.
- Changing the fork line.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Session→project | drag session to project | dashed context edge, persisted | — |
| Session→session | drag to another session | double-line cooperate edge | — |
| Project→project | drag project to project | context edge | — |
| Project→session | drag project to a session | refused, notice `can't link a project to a session` | nothing stored |
| Duplicate | B→A cooperate exists, drag A→B | refused `already linked` | — |
| Self | drop on itself | refused | — |
| Label | select edge, type "API shape", Enter | label shown mid-edge, persisted | blank → `null` |
| Delete | select edge, Del | gone, persisted | — |
| Keyboard | `e` on a session, pick a target | edge created | Esc → nothing |
| Hidden end | collapse target's project | edge not drawn, still stored | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/graph/mod.rs`:**
  - `Edge`, `EdgeKind`, `NodeRef` and `NodeType` (:171-208) already exist.
  - Add `add_edge` (validation per the Decisions; resolve node existence against projects, listed or stored branches, and session children or refs), `set_edge_label` and `remove_edge`, following the `move_node` mutation pattern (:1076-1145: write lock, `revision += 1`, `persist_and_emit`).
  - `remove_project` edge pruning (:1462-1468) is kept.
- **`src-tauri/src/ipc/mod.rs`:** `edge_add`, `edge_set_label` and `edge_remove`, thin like `workspace_move_node` (:387). Register them in `lib.rs`.
- **`src/ipc/index.ts`:** wrappers. The types already exist (:116-136).
- **`src/canvas/`:**
  - `Canvas.tsx`: `EDGE_TYPES` (:66-70) gains `context` and `cooperate`; flow edges built from `workspace.edges` next to `forkLines` (:207-219); `nodesConnectable`, `onConnect`, `isValidConnection` and `onEdgeClick` (ReactFlow props :313-344).
  - `nodes.ts`: flow id mapping (`flowIdOf`/`parseFlowId` :159-176), `CanvasTarget` (:95) gains `edge`.
  - `ChildNode.tsx` and `ProjectNode.tsx`: a connectable source handle, separate from the inert `ForkHandles` (:151-158).
  - `nodes.css`: the edge styles (fork CSS :421-442 is the pattern).
- **`src/state/ui.ts`:** the selection kind `edge` (`sameTarget` :385, `copyTarget` :397, the selection subscription :349). A new pane `edge`.
- **`src/commands/`:**
  - `builtins.ts`: `edge.link` (`e`), `edge.delete` (Del, `when` an edge is selected), `edge.inspect`.
  - The palette pick mode for "Link to…".
  - `nodes.ts` `mutate` (:50) for the calls.
  - `notify` (`navigation.ts:43`) for refusals.
- **Components:** a new `src/components/EdgePane.tsx`.
- **Docs:** `docs/DESIGN.md` gets the edge styles; `README.md` gets the keys table (Delete and `e` text at :99) and an Edges section.

## Tasks & Acceptance

**Execution:**
- [x] `graph/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests: every valid and refused pair, duplicates both ways, label trim and blank, remove, persistence, unknown ids) -- model and commands
- [x] `src/canvas/*`, `src/state/ui.ts`, `src/commands/*`, `EdgePane.tsx`, palette pick mode, `ipc/index.ts`, CSS (+vitest: flow edges, hidden ends, selection, Del `when`, Link-to targets) -- UI
- [x] `README.md`, `docs/DESIGN.md`, `epic-6-context.md` (mark open decision 1 resolved) -- docs

**Acceptance Criteria:**
- Given a session node, when I drag from its handle to a project node, then a dashed context edge is created; to another session, a solid double-line cooperate edge; an invalid pair is refused with a hint.
- Given an edge, when I select it, then I can set a label and delete it with Del; both persist across a restart.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- Refusal words live in Rust (`graph::REFUSE_*`) and are mirrored word for word in `src/canvas/edges.ts`, which drives only the drag's not-allowed state, the refused-drop notice and the "Link to…" list. Rust re-validates every `edge_add`. A folder end is refused with `can't link a folder yet` until Story 6.2.
- Node existence for `edge_add`: a project on the canvas; a session child (stubs and live-only included) or a stored session ref of a canvas project; a listed branch child, or a stored branch node by its id or its `<projectId>:<name>` id.
- The drop target is an invisible target handle over the whole card. It takes the pointer only while a connection is in progress (`useConnection`), so card clicks and drags are untouched. `connectionRadius={0}`, so only the card under the pointer counts.
- Fork lines now name their own handle id (`fork`), so they never anchor on a link handle.
- The cooperate double line is a 3-px `--border-strong` stroke with its middle pixel drawn over in `--bg`.
- "Link to…" is also in the node menu (order 13). A historic session's right-click now opens a menu holding only that entry.
- The edge inspector never takes focus on opening, so Del right after a click deletes. A selected edge that disappears from the snapshot is deselected, which also closes the inspector.

- 2026-10-21 GUI pass (orchestrator, two scratch folder projects `alpha` and `beta` with two stub sessions each): hovering a session card showed its handle (a small ring on the right edge); dragging alpha session 1 → beta project drew a dashed context edge; alpha session 2 → beta session 1 a double-line cooperate edge; project alpha's handle → beta session 2 was refused with the notice `can't link a project to a session` and nothing stored. Clicking the dashed edge selected it (brighter) and opened the Edge pane (Kind context, From `session 1 (alpha)`, To `beta`, Label, Delete); typing "API shape" + Enter showed the label at the midpoint; clicking the cooperate edge and pressing Del removed it. `workspace.json` then held exactly the labelled context edge. The `e` keyboard path was not driven (vitest covers it).

- 2026-10-21 GUI re-run after the patch round (orchestrator, same scratch projects): the drags and the refusal as before; alpha session 2 → its own project now curves out on the right (same column); `e` on beta session 2 opened the "Link to…" pick list (context and cooperate targets with their projects) and Enter created the edge; "Select edge…" on alpha session 1 listed `context: beta` and opened the inspector. That run showed a leftward edge (beta session 2 → project alpha) sweeping back across the canvas; after the routing follow-up a third run drew it from the source's left side into alpha's right side, with all four edges clear of the cards.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 (medium; B, E, V) A stored branch is accepted under two ids (its own id and `<projectId>:<name>`). That defeats the duplicate and self checks, and an edge stored with the stored id is never drawn. Canonicalise branch ends to `<projectId>:<name>` in `add_edge`. Tests.
- P2 (medium; E) An edge to a discovered session without a `SessionRef` is not pruned with its project once the session is unlisted, and is then invisible and undeletable. `add_edge` pins a `SessionRef` for a session end (as a move does).
- P3 (medium; B) No keyboard path to an existing edge (the palette must reach everything): add "Select edge…" on a selected node, a pick list of its drawn edges that selects one and opens the inspector.
- P4 (medium; B, E) A click on an edge's hit area replaces an open launch, worktree or remove sheet, losing its form: while such a sheet is open, an edge click only selects. `edge.inspect` or Enter then opens the inspector.
- P5 (medium; E) A selected edge whose end becomes hidden stays selected, so Del deletes an invisible edge: clear the selection (and close the inspector) once the edge is no longer drawn.
- P6 (medium; B) Edges within one column (a session to its own project, two sessions of one project, a project to its own branch) loop back across the cards: route same-column pairs with both ends on the right side.
- P7 (low; B, E) Labels keep interior control characters and have no length cap: strip control characters and cap at 200 characters in Rust.
- P8 (low; E) On WebKitGTK the label save on blur can reach Rust after the Delete removed the edge, leaving a sticky `unknown edge` banner: a label save for an edge that is gone is dropped silently.
- P9 (low; B) A drop on a non-node shows `can't link a node to itself`: no notice in that case.
- P10 (low; V) The pick list filter also matches hidden row ids (`session:…`): match titles only.
- P11 (medium; V) The palette pick-mode wiring (command mode keeping the pick open, pick rows filtered from the items, a pick row calling `onPick` and closing) runs only in the component. Move the row source and run decision into pure functions in `state/palette.ts` and test them.
- P12 (low; B) The arrow-key test only asserts "not an edge": assert the expected node is selected. Confirm `followSelection` and `acknowledgeIfNeeded` ignore `edge` targets, with a test.

**Defer:**
- D1 (B, V) Component tests for `Canvas.tsx` handlers and `EdgePane` (blur and Enter save, Delete skip): no DOM test environment (as 5.1 D2).

**Reject:**
- (low; B) A session may link to its own project: harmless; Story 6.2's add-dir normalisation drops a dir equal to the cwd.
- (B) The handle is "visible on hover or keyboard focus", but the app has no DOM focus on cards; keyboard focus here is the selection, and the handle shows on hover or selection, which matches the intent.
- (low; B) Esc discards an unsaved label: Esc is cancel by design; Enter or blur saves.
- (low; E) Duplicate or empty edge ids in a hand-edited `workspace.json`: hand edits are outside the story.
- (low; B) The label `<div>` has no role or keyboard handler: the keyboard path is P3.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:** orchestrator, foreground-guarded, with planted projects and stub children:
- Drag session→project, session→session and project→session (refused), and screenshot.
- Label an edge, Del it, then check `workspace.json`.
