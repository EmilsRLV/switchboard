---
title: 'Story 12.3: Project groups'
type: 'feature'
created: '2026-11-24'
status: 'ready-for-dev'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** On a busy canvas the operator cannot keep related projects together or find a set of them at a glance.

**Approach:** Projects can join a named **group**. An expanded group draws as a **frame** behind its members, with a label you can drag to move them all. A collapsed group draws as one **group card** showing the group's live count and attention. Groups are created, renamed, coloured, collapsed and deleted from the palette and node menu.

## Boundaries & Constraints

**Always:**
- **Data.** `workspace.json` gains `groups: [{id, label, color, collapsed}]` (omitted when empty) and `Project.groupId` (omitted when null). Both have serde defaults and there is no schema bump.
  - A project is in at most one group.
  - Load validation drops, under banner `workspace.groups`: duplicate or empty group ids, a `groupId` that names no group (it is cleared), and groups with no members.
- **Rust owns every change**, and each IPC validates its ids and writes the file once.
  - `group_create(label, projectId)` makes a group holding that project.
  - `group_add(groupId, projectId)` moves the project into the group. Its old group is deleted if that leaves it empty.
  - `group_remove(projectId)`.
  - `group_rename(groupId, label)`.
  - `group_set_color(groupId, color|null)`.
  - `group_collapse(groupId, collapsed)`.
  - `group_delete(groupId)`, which keeps the members as plain projects.
  - `workspace_move_nodes([{target, position}])` moves several nodes in one write. Every target must exist and every position must be finite, or nothing is moved.
  - Removing a project drops it from its group and deletes the group if it is now empty.
- **Labels** have control-character runs replaced by one space, are trimmed, and are cut to 60 characters. A blank label is refused with `group label is blank`.
- **Colours** come from a fixed set of five muted names: `slate`, `sage`, `sand`, `rose`, `sky`. They are tokens `--group-<name>` in `tokens.css` and a **group colours** section in DESIGN.md. Anything else is refused with `unknown group colour`. The accent is never a group colour.
- **Frame.** An expanded group draws a 1-px `--border` rectangle behind its members.
  - Bounds: the members' cards and their drawn children, plus a fixed padding.
  - The label sits top-left in mono `--text-xs`. A set colour shows only as a 2-px left rule.
  - Dragging the label moves every member live and saves once on drop through `workspace_move_nodes`. Clicking the label selects the group.
  - Dragging a member never changes membership: the frame just grows.
- **Group card.** A collapsed group draws as one card, project-card sized, at the frame's former top-left.
  - It shows the label, `N projects`, the sum of the members' `N live`, and the attention glow when any member's node needs the operator.
  - Members and their children are not drawn, and edges to them follow the existing hidden-ends rule.
  - Dragging the card moves the members by the same offset, in one write.
  - Arrow keys visit the card like a project card. Enter on a selected group, expanded or collapsed, toggles collapse.
  - `ctrl+j` and toast reveals into a collapsed group expand it first.
- **Commands** are registry commands with palette entries, bindable and passing the audit.
  - **Add to group…** (`g`, project node menu, palette) opens a pick list of the groups by label plus **New group…**. **New group…** asks for the label in the palette.
  - **Remove from group** applies when the project is in a group. The card stays where it is.
  - **Go to group: <label>**, one per group, selects and centres it.
  - While a group is selected: **Rename group…** (prefilled), **Set group colour…** (pick list of the five plus **None**), **Collapse group** / **Expand group**, and **Delete group** (no confirmation).

**Never:**
- A drag that changes membership, or nested groups.
- A group as an edge end, a peer, a launch target or a terminal owner.
- A stored group position: the frame and the card position come from the members.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error handling |
|---|---|---|---|
| Create | `g` on project A, New group…, type `  web\u0007 apps ` | Group `web apps` with A; frame drawn around A | — |
| Blank label | New group…, type spaces | Nothing created | Notice `group label is blank` |
| Long label | 80-char label | Stored cut to 60 | — |
| Move between groups | A in G1 (only member), Add to group → G2 | A in G2; G1 deleted | — |
| Remove | Remove from group on G's last member | Group deleted, A's card stays put | — |
| Drag label | Drag G's label by (+50, +20) | Every member +50,+20; one file write | Non-finite position: nothing moved |
| Collapse | Enter on selected expanded G | Group card with `N projects`, summed live, glow if a member needs you; members' edges hidden | — |
| Reveal | `ctrl+j` to a session in collapsed G | G expanded, session selected | — |
| Delete project | Remove G's only member project | G deleted with it | — |
| Bad file | `groupId:"ghost"`; two groups with id `x`; empty group | Cleared / first kept / dropped; one `workspace.groups` banner | Other data kept |
| Old app | 0.2.0 opens a file with groups | Loads, groups ignored | — |
| Colour | Set group colour → `sage`; IPC with `#ff0000` | 2-px `--group-sage` left rule / refused | `unknown group colour` |

</frozen-after-approval>

## Code Map

- `src-tauri/src/graph/mod.rs`:
  - `Workspace` :52 is struct-level `serde(default)` with a manual `Default` at :89. Add `groups`, with `skip_serializing_if = "Vec::is_empty"`, following `agent_actions` :64.
  - `Project` :152: add `group_id: Option<String>`, skipped when `None`.
  - `normalise_edge_label` :2068 (cut `MAX_EDGE_LABEL_CHARS` = 200): generalise to take a max and reuse it with 60.
  - The setter pattern (`write_workspace`, mutate, `revision += 1`, `persist_and_emit` :2594) is in `set_launch_defaults` :1451 and `set_edge_label` :2091.
  - `move_node` :1337 is the template for the new `move_nodes`.
  - `remove_project` :1724: drop the project from its group and prune empty groups at :1767, before `revision += 1`.
- `src-tauri/src/graph/store.rs` `validate` :25: groups rules go after the project dedupe at :47–63. Model the test on :189.
- `src-tauri/src/ipc/mod.rs`: add the group IPCs and `workspace_move_nodes` next to `workspace_move_node` :450. Register them in `lib.rs` `generate_handler!` :32. The IPC tests follow lib.rs :822, :849 and :958 (`app_with_ide`, `invoke_with`).
- `src/ipc/index.ts`: `Group`, `Workspace.groups`, `Project.groupId`, and the IPC wrappers.
- `src/canvas/nodes.ts`:
  - `toFlowNodes` :457: skip the members of a collapsed group (as `!project.expanded` does at :556) and emit a `groupCard` node.
  - For an expanded group, emit a `groupFrame` node with a lower `zIndex` than cards (`layer()` :613), sized from member rects (`nodeRects` :1263 geometry, `CARD_*`/`CHILD_*` constants :145).
  - Reuse `liveCount`/`attentionOf`/`glowTextOf` :495–546 over the member children.
  - `CanvasTarget` :142, `flowIdOf`/`parseFlowId` :196 gain kind `group`. Add the new data fields to the `reuse()` equality :632.
- `src/canvas/Canvas.tsx` `NODE_TYPES` :76 (+`groupFrame` with `dragHandle` on the label, +`groupCard`). Drag stop at :383 moves the members through `workspace_move_nodes`; during the drag, apply the offset to the members as canvas drag overrides (`onNodesChange` :366).
- New `src/canvas/GroupNode.tsx` and `nodes.css` (tokens only; `src/theme/design.test.ts` lint). Add `--group-*` tokens to `src/theme/tokens.css`.
- `src/state/palette.ts`: `openPick` :35/:141 and `runPaletteRow` :92. Add a **prompt** mode `{placeholder, initial, onSubmit(text)}` in which Enter hands the query to `onSubmit`, and render it in `Palette.tsx`. The pick-list model is `startLink` (`commands/edges.ts` :70).
- New `src/commands/groups.ts`.
  - Static commands are registered in `builtins.ts` (pattern: `project.expand`/`collapse` :708).
  - The `Go to group:` commands are registered at runtime with `registerCommand` (registry.ts :102), re-synced when the snapshot's groups change, with each unregister function kept.
  - `g` is free.
  - Update the hard-coded counts in `builtins.test.ts` :58/:254/:356/:541.
- `src/commands/navigation.ts`: `activateSelection` :130 toggles a group's collapse. `moveSelection` :62 includes group cards.
- `src/commands/attention.ts`: `revealSession` :49 and `revealAgent` :84 expand a collapsed group (`group_collapse false`) before the project.
- Docs:
  - Help pages are capped at 400 words (`src/help/pages.test.ts`); `terms.md` is already at 400, so cut something to make room.
  - `canvas.md` and `projects.md` cover groups. `terms.md` gains **Group**. `legend.md` (What you see) gains the frame and the group card.
  - `docs/DESIGN.md` gains the group frame, group card and group colours. The README gets a Workspace section.
  - `CHANGELOG.md` Unreleased › Canvas. PRD FR-CANVAS-9.

## Tasks & Acceptance

**Execution:**
- [ ] `src-tauri/src/graph/{mod,store}.rs` -- the data, validation, label and colour rules, the group setters, `move_nodes`, and remove-project pruning; unit tests for each rule.
- [ ] `src-tauri/src/ipc/mod.rs`, `lib.rs` -- the eight IPCs; one fixture test per IPC and per refusal.
- [ ] `src/state/palette.ts`, `src/components/Palette.tsx` -- prompt mode, with tests.
- [ ] `src/ipc/index.ts`, `src/canvas/{nodes.ts,Canvas.tsx,GroupNode.tsx,nodes.css}`, `src/theme/tokens.css` -- the frame, the card and the drag; vitest tests for bounds, collapsed members left out, summed live and attention.
- [ ] `src/commands/{groups,builtins,navigation,attention}.ts` -- the commands, the runtime Go-to commands, Enter, arrows and reveal; vitest tests including a `ctrl+j` into a collapsed group.
- [ ] Docs as in the Code Map.

**Acceptance Criteria:**
- Given two groups `web` and `tools`, when the palette is opened and `go to` is typed, then **Go to group: web** and **Go to group: tools** are listed, and after renaming `web` to `site` only the new title is listed.
- Given a selected group card, when the palette opens, then Rename, Set colour, Expand and Delete group are listed. Given a selected project, they are not.

## Design Notes

The epic's `position` on a group is dropped. The frame is derived from its members, and the collapsed card sits at the frame's top-left, so a stored position would only ever disagree with the members.

**New group…** and **Rename group…** need a text prompt in the palette, which does not exist today (the palette only filters pick lists). A small prompt mode keeps both actions keyboard-first without a new pane.

## Verification

**Commands:**
- `cd src-tauri && cargo test` -- expected: passes
- `npm test` -- expected: passes
- `npx tsc --noEmit` -- expected: no errors

**Manual checks:**
- Group two projects, drag the label: both move, and reopening the app shows them moved. Collapse with Enter: one card with the summed live count; restart, and it is still collapsed.
