---
title: 'Story 11.2: The node toolbar'
type: 'feature'
created: '2026-11-04'
status: 'done'
baseline_commit: '6b4bedd8de233a07660054bcf537bd1624f05d14'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A card shows nothing about what it can do. Its actions live in a right-click menu and in keys, so new operators have to guess.

**Approach:** While a project, session or branch card is hovered or selected, a small toolbar hangs to the right of it with up to four short text buttons for that card's main enabled commands, plus `⋯` for the full node menu. It is absent from the DOM otherwise, and it never changes card geometry.

## Boundaries & Constraints

**Always:**
- **Decided (Emils, 2026-11-04, after review):** the toolbar sits to the **right** of the card, outside its fixed box (240 × 80 project, 208 × 40 child), top-aligned with the card's top edge and clear of the link handle. Under the card it covered the next card in the column (8 px gap). Use a plain absolutely-positioned element inside the node's root, not xyflow `NodeToolbar`, so that moving the pointer from the card onto the toolbar keeps the hover. The transparent bridge between card and toolbar counts as hover but never covers the link handle: the handle stays visible, on top and draggable. `nodes.ts` geometry, `toFlowNodes` and the arrow keys are untouched.
- Rendered only while the card is hovered or `data.selected` (the `LinkHandles` rule). No animation. DESIGN.md's **node toolbar** look applies: tokens only, no accent.
- Registry: add `toolbar?: number` (order) and `short?: string` (the button word). Only `menu: "node"` commands may carry `toolbar`.
- Rows come from a pure `toolbarCommands(target)` in `src/commands/nodes.ts`. It returns the card kind's `toolbar` commands that are enabled **for that target**, in order, cut at four. A disabled command is left out, never greyed.
- **Decided (Emils, 2026-11-04, after review):** the buttons do not depend on which pane is open. The toolbar evaluates its commands as if no pane were open, through a pane override beside the selection override (`currentPane()`, read by `noSurfaceOpen` and by the `pane !== "launch"` checks of the toolbar's commands). A click selects the card, closes the open pane first when the command is not enabled with that pane open (`closeOpenPane`, not a command), then runs `runCommand(id)`. So `review` with the terminal pane open swaps to the Review pane, and `new` with the launch sheet open reopens it for the clicked card. Keys and palette behaviour are unchanged.
- Enabled for that target: `when` clauses read the selection, so add `withSelection(target, fn)` / `currentSelection()` in `src/state/ui.ts`. They are a synchronous, non-notifying override for evaluation, and every `useUiStore.getState().selection` read in `src/commands/*` and in `ui.ts` helpers goes through `currentSelection()`. No store write and no subscriber notification happens during evaluation.
- Order and words:
  - project: `new` (project.newSession), `term` (project.terminal), `link` (edge.link), `review` (review.changes)
  - session: `term` (session.showTerminal) or `resume` (session.resume), never both (when both are enabled, as for an exited session whose terminal tab is still open, `resume` wins), then `fork` (session.fork), `link`, `review`
  - branch: `new` (branch.newSession), `worktree` (branch.newWorktree) or `remove` (branch.removeWorktree), `review`
  - **Stop** is never on the toolbar.
- Clicking a button selects the card, then `runCommand(id)` runs from one local function, so the audit passes. The buttons are `nodrag nopan`, `tabIndex={-1}`, with `title={commandHint(id)}`.
- `⋯` selects the card and opens the node menu at the button's bottom-left (`openContextMenuFor`), with title `Menu · right-click`. It is the one new allow-list entry in `audit.test.ts` and in `hints.test.ts`, with the reason "opens a menu at its own position, not a command".
- The card's accessible name is unchanged. The toolbar is not in the Tab order.

**Never:**
- No xyflow `NodeToolbar` portal, no new dependency, and no CSS transition.
- No change to the commands' `when`, `run` or keys, and no change to the node menu's membership.
- Nothing is shown on more rows, edges or other child kinds.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Project | an idle git project | `new term link review ⋯` | N/A |
| Live session in a terminal | session with a terminal | `term fork link review` | N/A |
| Exited session | transcript, no terminal | `resume fork link review` | N/A |
| Branch, no worktree | a branch card | `new worktree review` | N/A |
| Branch with a worktree | worktree exists | `new remove review` | N/A |
| Hover while another card is selected | hover B, A selected | B's toolbar reflects B, and the selection stays A until a click | N/A |
| Click `new` on the hovered B | — | B selected, then the launch sheet opens for B | N/A |
| Nothing enabled | historic session, no link target | only `⋯` (or no toolbar when the node menu is empty too) | N/A |
| Neither hovered nor selected | — | no toolbar element in the DOM | N/A |
| Drag from a toolbar button | press on `new` and move | no node drag, no pan | N/A |
| Exited session, terminal tab still open | `exited` set, transcript | `resume fork link review` | N/A |
| Terminal pane open | hover a project | `new term link review`; a click on `review` closes the terminal pane and opens the Review pane on it | N/A |
| Launch sheet open for A | click `new` on project B | the sheet reopens for B | N/A |
| Selected child card | the next card in the column below it | not covered by the toolbar; it stays hoverable and clickable | N/A |

</frozen-after-approval>

## Code Map

- `src/commands/registry.ts` -- the `Command` type. Add `toolbar`, `short`.
- `src/state/ui.ts` -- `selectedProject` (~525) and `hasSelection` (~504) read `getState().selection`. Add `currentSelection()` and `withSelection(target, fn)` here.
- Selection reads to switch to `currentSelection()`: `src/commands/edges.ts:56,93,184`, `navigation.ts:193,236`, `nodes.ts:145`, `review.ts:51,59`, `sessions.ts:160,180`. Keep `nodes.ts:145` (`removeProject`'s pointed-at check) if it is a run-path read; only reads reached from a `when` must go through the override, but switching all is harmless.
- `src/commands/builtins.ts` -- tag `toolbar`/`short` on project.newSession (~473), project.terminal (~482), edge.link (~703), review.changes (~792), session.showTerminal (~440), session.resume (~419), session.fork (~430), branch.newSession (~678), branch.newWorktree (~665) and branch.removeWorktree (~691). A shared order keeps the kind's sequence: either/or pairs share a slot, and disabled ones drop out.
- `src/commands/nodes.ts` -- add `toolbarCommands(target)` beside `nodeMenuCommands` and `openContextMenuFor` (~170). Filter by card kind using the `menuOrder` groups or an explicit kind list. Decide per command, keep it data, and test it.
- `src/canvas/ProjectNode.tsx`, `src/canvas/ChildNode.tsx` (`SessionNode` ~180, `BranchNode` ~191) -- local hover state on the node root, then render `<NodeToolbar target=… />` when hovered || selected. Both are `memo`, so the hover state stays local and only that node re-renders.
- New `src/canvas/NodeToolbar.tsx` (and CSS in `nodes.css`) -- the row, as DESIGN.md "The node toolbar" describes it (~417).
- `src/commands/audit.test.ts`, `src/commands/hints.test.ts` -- the `⋯` allow-list entries. Shared scan helpers live in `src/commands/sourceScan.ts`.
- `docs/DESIGN.md` -- "The node toolbar" (~417) and Node anatomy (~486) say the toolbar is attached *under* the card. Change them to *right of the card, top-aligned, clear of the handle*, and record that it never depends on the open pane.
- Docs: `docs/help/canvas.md`, `projects.md`, `sessions.md`, `branches.md` (one sentence each, within the `pages.test.ts` budget); `docs/help/terms.md` gains **Toolbar**; DESIGN.md's Node anatomy (~486) already says the toolbar is outside the box, so check it; `CHANGELOG.md` Unreleased.

## Tasks & Acceptance

**Execution:**
- [x] `src/state/ui.ts` (+ test) -- `currentSelection` and `withSelection`: the override is visible inside `fn`, restored after it (including on throw), and never notifies.
- [x] `src/commands/*.ts` -- route the selection reads through `currentSelection()`.
- [x] `src/commands/registry.ts`, `builtins.ts` -- `toolbar` and `short` tags.
- [x] `src/commands/nodes.ts` (+ `nodes.test.ts` / `builtins.test.ts`) -- `toolbarCommands`, with one test per matrix row 1–5 and 8 on real builtins. A test fails if any `toolbar` command lacks `short` or lacks `menu: "node"`.
- [x] `src/canvas/NodeToolbar.tsx`, `nodes.css`, `ProjectNode.tsx`, `ChildNode.tsx` -- render on hover or selection. A `renderToStaticMarkup` test checks: the buttons and `⋯` render with `commandHint` titles and `tabIndex="-1"`, and nothing renders when the card is neither hovered nor selected.
- [x] `audit.test.ts`, `hints.test.ts` -- the `⋯` entries.
- [x] Docs, Terms and CHANGELOG as listed in the Code Map.

**Acceptance Criteria:**
- Given a hovered card, when I click a toolbar button, then the card becomes selected and the command runs as if from its menu.
- Given the full suite, when it runs, then typecheck, audit, hints, `pages.test.ts` and the design lint pass.

## Implementation Notes

- Hover is tracked on a `display: contents` `.node-hover` wrapper around card, handles and toolbar; the toolbar's 4px transparent top padding bridges to the card.
- `.react-flow__node:has(.node-toolbar) { z-index: 1002 !important }` lifts a card showing its toolbar above the next card; needs `:has()` (WebKitGTK ≥ 2.42 on Linux).
- The mounted toolbar subscribes to pane, context menu, palette, terminals and live snapshot so its buttons follow state while shown.
- "Nothing enabled" matrix row: with real builtins a historic session still has `link`, so the empty case is tested with a branch gone from the snapshot and "only ⋯" with a stub command.
- `hints.test.ts` stale check gained an `anyClick` option so the `⋯` title entry (no command) is found.
- Docs write `⋯` as bold, not code: `content.test.ts` treats a one-character code span as a key.

## Spec Change Log

- **Loop 1 (intent_gap, 2026-11-04).** Findings: the toolbar under a card covered about 16 px of the next 40 px card, and selection kept it covered; buttons vanished when a pane opened (`review` after clicking `term`). Emils decided: toolbar to the right of the card, and buttons independent of the open pane. Amended: Approach, the placement bullet, a new pane bullet, the session either/or rule, and five matrix rows. Code reverted to `6b4bedd`.
  - **KEEP (worked well, re-derive the same way):**
    - `currentSelection()` and `withSelection()` in `ui.ts`: a module-level override that nests, restores on throw and never notifies, with all `src/commands/*` selection reads routed through it.
    - `toolbar`/`short` tags with shared slots: 1 new/term/resume, 2 term/fork/worktree/remove, 3 link, 4 review.
    - `TOOLBAR_KINDS` table, `TOOLBAR_MAX`, `hasNodeMenu(target)`.
    - `useHover()` on a `display: contents` `.node-hover` wrapper.
    - The `ShownToolbar` subscription wrapper. Only shown toolbars subscribe.
    - `ToolbarRow` with a local `run` and `openMenu`, plus the `audit.test.ts` and `hints.test.ts` `⋯` entries.
    - The tests on real builtins in `builtins.test.ts`, `NodeToolbar.test.tsx` (static markup plus calling the handlers through the element tree) and the `ui.test.ts` override tests.
    - `.react-flow__node:has(.node-toolbar) { z-index: 1002 !important }` to draw above neighbours.
    - Docs write `⋯` in bold, not as code (`content.test.ts`).
  - **Also fix this time:**
    - Keep only the first enabled command per `toolbar` slot (by the priority above) before cutting at four, and test it with an exited-but-open terminal.
    - Subscribe `ShownToolbar` to `elsewhereOpen` too, and keep a comment listing what the `when`s read.
    - Give each button `aria-label` set to the command's title. Drop the `:focus-visible` rule and DESIGN.md's "focus outline" phrase, because the buttons are never focusable.
    - Hide the node's own toolbar while xyflow reports it `dragging`.
    - Pass `anyClick` to the `hints.test.ts` stale check only for the NodeToolbar entry.
    - Add `renderToStaticMarkup` tests of `ProjectNode`, `SessionNode` and `BranchNode` with `selected` true and false, using a `ReactFlowProvider` if needed, to check the right target and kind are wired.
    - Docs: one sentence per page, without rewording unrelated text in ways that lose meaning. Keep "two sessions", "adds nothing", "A right-drag pans" and the Copy branch name sentence. Terms reads "the buttons beside a hovered or selected project, session or branch node". Fit the 400-word budget by tightening the new sentences.

## Review Triage Log

Loop 1 (diff `6b4bedd`..working tree, reverted):

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Toolbar under a card covers the next card; selection keeps it covered | high | 24 px toolbar vs 8 px `CHILD_GAP`; `z-index: 1002` puts it on top | intent_gap → right of card |
| 2 | Buttons vanish when a pane opens (`review`, `new`) | medium | `review.changes` `when` needs `noSurfaceOpen`; `new` needs `pane !== "launch"` | intent_gap → pane-independent |
| 3 | `term` and `resume` both shown, `review` cut | medium | `canShowSessionTerminal` ignores `exited`; both are slot 1 | patch (carried into the change log) |
| 4 | `ShownToolbar` misses `elsewhereOpen` | low | `noSurfaceOpen` reads it | patch (carried) |
| 5 | Focus style never shows; no aria-label | low | `tabIndex=-1` | patch (carried) |
| 6 | Toolbars mount during drags | low | hover state is unaware of drags; own-node `dragging` is a trivial guard | patch (carried) |
| 7 | Card wiring untested | medium | no test renders ProjectNode/SessionNode/BranchNode | patch (carried) |
| 8 | Docs rewrites lose meaning | low | branches, projects, canvas, terms | patch (carried) |
| 9 | `anyClick` loosens every stale check | low | hints.test.ts | patch (carried) |
| 10 | Live subscriptions untested | medium (unverified) | no DOM test env | defer |
| 11 | Silent no-op when a stale row's command is disabled at click | low | rare; guard adds a branch | reject |
| 12 | `toolbarCommands` ignores `menuWhen`; `hasToolbar` duplicates the kinds | low | no toolbar command has `menuWhen` | reject |
| 13 | `:has()` needs WebKitGTK ≥ 2.42 | low | current distros ship newer; noted in Implementation Notes | reject |

Loop 2 (re-derived code):

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Click closes panes even when the pane isn't what disables the command | medium | loop checks only `!isCommandEnabled(id)` | patch |
| 2 | `new`/`review` on the card whose sheet/Review pane is already open closes and reopens it, losing form/state | medium | `review.changes` and `newSession` are disabled with their own pane open, so the loop closes it | patch |
| 3 | Toolbar click skips `clickNode`: context menu stays open, attention not acknowledged | medium | `stopPropagation` + bare `select` | patch |
| 4 | `dragging` asserted only for ProjectNode; no test that an enabled command leaves the pane; no Help-over-pane test | low | NodeToolbar.test.tsx | patch |
| 5 | Dragged card passes under a selected card showing its toolbar | low | `:has(.node-toolbar)` 1002 beats xyflow's drag lift | patch |
| 6 | Help pages list fixed button sets without "when they can run" | low | projects/sessions/branches | patch |
| 7 | Unrelated doc rewording lost precision again ("a lock", "opens a menu", Settings pane "with Diagnostics", worktree add "it will run") | low | branches, canvas, terms | patch |
| 8 | Hover path untested | medium (unverified) | no DOM test env | defer (with loop 1 #10) |
| 9 | Clicking `new` on B discards A's half-filled sheet | false | Emils decided "reopens it for the clicked card" | reject |
| 10 | Toolbar runs commands the menu hides | false | the decided pane-independence | reject |
| 11 | Silent no-op when `runCommand` returns false | low | carried loop 1 #11 | reject |
| 12 | Subscription list hand-maintained; launch/review stores missing | low | toolbar `when`s read the pane only through the override | reject |
| 13 | `hasNodeMenu` uses the real pane | low | `⋯` hidden only if review is the menu's sole row with a pane open | reject |
| 14 | `currentSelection` rule not enforced for other `when`s | low | none back a toolbar command | reject |
| 15 | Elsewhere tray disables `review` | low | tray open while hovering a card is rare; closing the tray adds a branch | reject |
| 16 | Hover sticks when a card moves under a still pointer | low | next move fixes it | reject |
| 17 | `short` pairing not typed; slots in two places; `term` means two things | low | design choices (Q10); test enforces `short` | reject |
| 18 | `:has()` on older WebKitGTK | low | carried loop 1 #13 | reject |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass

**Manual checks (if no CLI):**
- In `npm run tauri dev`, hover a card: the toolbar is to its right, and moving onto the toolbar keeps it. Click `new` on an unselected project: the card is selected and the launch sheet opens. Pan with about 50 nodes, as `docs/perf.md` describes: it stays smooth.
