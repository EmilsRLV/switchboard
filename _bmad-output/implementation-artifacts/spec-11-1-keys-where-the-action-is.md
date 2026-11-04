---
title: 'Story 11.1: Keys where the action is'
type: 'feature'
created: '2026-11-04'
status: 'done'
baseline_commit: '9b220d1b46d1bd716d6144108a2386e612343ad1'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Keys appear only in the palette. Menu rows and buttons hide them, and a right-click on the empty canvas does nothing, so mouse users never learn the keys or find the canvas's actions.

**Approach:** Context-menu rows end with their effective key. A right-click on the canvas background opens a **canvas menu** built from commands tagged `menu: "canvas"`. Every chrome button that runs a command gets its `title` from one registry helper, `commandHint(id)`, of the form `Title · key`, and a source-scanning test keeps it that way.

## Boundaries & Constraints

**Always:**
- Keys are read from the registry's effective `binding` on every render, so rebinds and unbinds in `keybindings.json` show up the next time a menu or button renders. The format is `formatKeybinding`, in the palette's key look `<kbd className="palette-row-key">`.
- The canvas menu reuses `ContextMenu.tsx`: the same look, keys, Esc through `contextMenu.close`, close on an outside press or window blur, and only enabled rows. It opens only on a right-button release that moved at most `DRAG_THRESHOLD` from a press on the background (`.react-flow__pane` or the empty-canvas hint), never from a press on a node, an edge or a handle. A right-drag still pans.
- Canvas menu rows, in `menuOrder`: Add project folder… (`ctrl+o`) · Import from Claude… | Fit view (`ctrl+0`) | Help (`f1`) · Open settings (`ctrl+,`).
- `help.open` and `settings.open` have no key of their own. They display the key of their toggle (`help.toggle` / `settings.toggle`) through a new optional `Command.keyFrom?: string`, which names the command whose effective binding is shown. Dispatch is unchanged.
- `commandHint(id, label?)` returns `label ?? command.title`, then ` · ` and the key when there is one, or only the label when there is none. It also works for an unregistered id, in which case it returns `label` or the id.
- Tokens only, no accent, no new motion. DESIGN.md already describes all three pieces (lines ~376–388); keep it accurate.

**Never:**
- No custom tooltip component. Tooltips are the native `title`.
- No change to keyboard dispatch, to `nodeMenuCommands()` membership, or to the node menu's behaviour beyond the key column.
- Item-level buttons (a toast's Allow, a tab's ×, a review row, a commit row) keep their own words.
- No settings.json, workspace.json or state.json change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bound | `commandHint("pane.close")` | `Close pane · esc` | N/A |
| Label override | `commandHint("pane.close", "Close")` | `Close · esc` | N/A |
| Unbound | `commandHint("project.expand")` | `Expand project` | N/A |
| Rebound | override `review.open` → `ctrl+r` | `Review changes · ctrl+r` | N/A |
| keyFrom | `commandHint("help.open")` | `Help · f1` | N/A |
| Unknown id | `commandHint("nope", "X")` | `X` | no throw |
| Bg right-click | press and release on the pane, moved ≤ 4 px | canvas menu at the pointer, selection unchanged | N/A |
| Right-drag | moved > 4 px | pan only, no menu | N/A |
| Edge/handle | press on an edge or a handle | no menu (as today) | N/A |
| Empty canvas | no projects | the menu still opens, and Fit view is dropped by its `when` | N/A |

</frozen-after-approval>

## Code Map

- `src/commands/registry.ts` -- `Command.menu` (line ~37) widens to `"node" | "canvas"`. Add `keyFrom?: string`. `getCommand` and `listCommands` are unchanged.
- `src/commands/keybindings.ts` -- `formatKeybinding` (line ~125). Add `commandHint` and `displayBinding(cmd)`, which reads `keyFrom`'s command when it is set.
- `src/commands/nodes.ts` -- `nodeMenuCommands()` (line ~31). Add a sibling `canvasMenuCommands()`. Add `rightClickCanvas(at)`, which opens the canvas menu without touching the selection.
- `src/state/ui.ts` -- `contextMenu: MenuPoint | null` (lines 143, 198, 310). Store `{ x, y, menu: "node" | "canvas" }`, where `openContextMenu(at, menu = "node")` defaults to the node menu, so existing callers and tests keep working. `isContextMenuOpen` (~502) is unchanged.
- `src/components/ContextMenu.tsx` -- choose rows by `at.menu`, with `aria-label` "Node actions" / "Canvas actions". Each row is `<span>` title plus `<kbd className="palette-row-key">`, as in `Palette.tsx:112-113`. Add the needed CSS to the existing context-menu rules (flex, key pushed right). Check where `.context-menu-item` is styled with `grep`.
- `src/canvas/nodes.ts` -- `RightPress` (~350) gains `onBackground: boolean`. Add a pure `rightClickBackground(press, release): boolean` beside `rightClickTarget` (~358) with the same threshold.
- `src/canvas/Canvas.tsx` -- `onPointerDownCapture` / `onPointerUpCapture` (~215-229). Set `onBackground` when the target is inside `.react-flow__pane` (and not inside a node or edge) or `.canvas-hint`. On release, run `rightClickNode` or `rightClickCanvas`.
- `src/commands/builtins.ts` -- tag `menu: "canvas"` and `menuOrder` on `project.add` (366), `project.import` (373), `canvas.fitView` (357), `help.open` (257) and `settings.open` (244). Add `keyFrom` to the last two.
- Buttons to switch to `commandHint`:
  - the pane-header Close buttons (`title="Close (Esc)"` in EdgePane, HelpPane, ImportPane, LaunchPane, RemoveWorktreePane, ReviewPane, SettingsPane, WorktreePane), using `commandHint("pane.close", "Close")`
  - `EdgePane` delete (`edge.delete`)
  - the ProjectNode chevron (`chevronCommandId`) and branches chip (`project.toggleBranches`)
  - the ChildNode review flag (~93)
  - the ChecklistCard step rows (`step.command`)
  - the ReviewPane refresh, mode, filter, comment (keep `commentBlocked ??`) and back-to-commits buttons
  - the `LinkHandles.tsx:24` handle, using `commandHint("edge.link", "Drag to link")`
  - Leave EdgePane's descriptive titles (re-send, revoke, retry, restart) as they are, but move them into the allow-list.
- `src/commands/audit.test.ts` -- reuse its exported `handlersIn`, `runsCommand` and the `auditedSources` read pattern for the new test.
- Docs: `docs/help/keyboard.md`, `docs/help/canvas.md`, and `CHANGELOG.md` (Unreleased).

## Tasks & Acceptance

**Execution:**
- [x] `src/commands/registry.ts`, `keybindings.ts` -- widen `menu`, add `keyFrom` and `commandHint` -- the core helper.
- [x] `src/commands/keybindings.test.ts` -- cover the matrix's six `commandHint` rows.
- [x] `src/state/ui.ts` (+ `ui.test.ts`) -- add the `menu` kind to the context menu state.
- [x] `src/commands/nodes.ts` (+ `nodes.test.ts`) -- `canvasMenuCommands`, `rightClickCanvas`; test the order and that disabled rows are dropped.
- [x] `src/canvas/nodes.ts` (+ `nodes.test.ts`), `Canvas.tsx` -- background detection; test `rightClickBackground` at the threshold, beyond it, and on a non-background press.
- [x] `src/commands/builtins.ts` -- the canvas tags and `keyFrom`.
- [x] `src/components/ContextMenu.tsx` + its CSS -- the key column, both menus.
- [x] The components and canvas files listed in the Code Map -- titles via `commandHint`.
- [x] `src/commands/hints.test.ts` -- scan every `<button`/element whose `onClick` `runsCommand` in `src/components` and `src/canvas`, and fail on a `title="…"` literal or a `title={"…"}` / template literal with no `commandHint`. Keep an allow-list of item-level titles with reasons, plus a stale-entry check.
- [x] Docs and CHANGELOG -- keyboard.md: menus and tooltips show keys. canvas.md: the canvas menu. CHANGELOG Unreleased: three bullets under Canvas and Keyboard. Keep each page within the 10.2 word budget (`pages.test.ts`).

**Acceptance Criteria:**
- Given a node menu is open, when a command has an effective key, then its row ends with it in the palette's key look. After a `keybindings.json` unbind, the next opening shows no key.
- Given the canvas menu is open, when I press ↑/↓/Enter/Esc, then it behaves exactly like the node menu.
- Given any chrome button that runs a command, when I hover it, then its tooltip is `Title · key` or `Title`.
- Given the full suite, when it runs, then the audit test passes with no new direct-handler exemption.

## Implementation Notes

- `commandHint` prefers a command's `dynamicTitle` over `title`, as `listCommands` does.
- The matrix's Rebound row says `review.open`; "Review changes · r" is `review.changes`, which the test rebinds to `ctrl+r`.
- Empty canvas: `canvas.fitView`'s `when` is only `isCanvasReady` (ctrl+0 goes home on an empty canvas, tested). To meet the matrix without changing dispatch, `Command.menuWhen` (menu-only condition) was added and Fit view's is `hasProjects` (`src/state/workspace.ts`).
- Tooltips that had descriptive words keep them as `commandHint(id, label)` (checklist steps, review refresh/mode/filter/comment/back, Elsewhere chip, What's new chip); the review layout buttons and checklist Dismiss gained titles.
- `hints.test.ts` imports `runsCommand` from `audit.test.ts`, so the audit's tests also run under it.

## Spec Change Log

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | ~13 command buttons have no title; scan passes untitled ones | medium | HelpPane ← Contents / Show on canvas, ImportPane add, LaunchPane add folder / start, RemoveWorktree, Settings, Worktree buttons have `runCommand` and no `title`; frozen intent says every chrome button | patch |
| 2 | Tooltips don't refresh on rebind; docs claim they do | low | memo'd cards and panes don't subscribe; frozen intent only promises "next time it renders", so docs overclaim | patch (docs) |
| 3 | Palette row for Help/Open settings shows no key, menu shows f1 | low | `Palette.tsx:113` uses `row.binding`; toggles are hidden so no duplicate row | patch |
| 4 | `hints.test.ts` imports `audit.test.ts`, running the audit twice | low | top-level `describe` in audit.test runs on import | patch |
| 5 | `commandHint` ids / `keyFrom` targets not checked as registered | low | `commandHint` falls back silently; no test resolves the ids | patch |
| 6 | `.context-menu-title` ellipsis never shows | low | no `white-space: nowrap` / `min-width: 0` | patch |
| 7 | CSS section ruler too long | low | dash count unchanged after longer label | patch |
| 8 | `keyboard.md` lost unrelated info to fit word budget | low | Show terminal example, Help: open page… pick list, "as you left it" cut | patch |
| 9 | `canvas.md` unwrapped ~200-char line, vaguer "opens a menu" | low | line 57 | patch |
| 10 | ContextMenu popup never rendered by a test | medium | no test renders ContextMenu; ternary/kbd removal would pass | patch |
| 11 | `isBackground` untested | medium (unverified) | private DOM helper; no DOM test env | defer |
| 12 | Multi-selection box inside pane opens canvas menu | false | `multiSelectionKeyCode={null}`, `selectionOnDrag={false}`, `elementsSelectable={false}` in Canvas.tsx: no selection box exists | reject |
| 13 | Scan ignores id mismatch between commandHint and runCommand | low | rare; needs extra parsing | reject |
| 14 | Scan only checks `onClick`; handle title unguarded | low | one site; widening adds complexity | reject |
| 15 | Mixed literal branch `cond ? "x" : commandHint()` passes | low | no such site; guard adds complexity | reject |
| 16 | Comments with quotes inside attribute braces confuse the scan | low | no such site | reject |
| 17 | EdgePane per-side Retry template title not in DESIGN exceptions | low | runs `retryEdge`, not a command; item-level | reject |
| 18 | Canvas menu has no keyboard opener | false | not in intent; every row is a palette command with its key | reject |
| 19 | Right-click to dismiss a menu opens the canvas menu | false | matches native context-menu behaviour (new right-click opens a menu there) | reject |
| 20 | Link handle `Drag to link · e` names a different action | false | the epic's AC specifies exactly this title | reject |
| 21 | Review flag tooltip lacks the session name | false | old title also had no name | reject |
| 22 | Spec/code disagree on Fit view (`menuWhen`) | reject | fix is a spec edit; recorded in Implementation Notes | reject |
| 23 | Allow-listed EdgePane titles show no key | false | spec explicitly keeps their words | reject |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass, including the new hints, nodes and keybindings tests, `audit.test.ts`, `pages.test.ts` and the design lint

**Manual checks (if no CLI):**
- In `npm run tauri dev`: right-click the empty canvas to open the canvas menu with keys, and right-drag to pan with no menu. Hover a pane's Close to see `Close · esc`.
