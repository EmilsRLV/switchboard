---
title: 'Story 11.3: The ghost card and inline hints'
type: 'feature'
created: '2026-11-04'
status: 'done'
baseline_commit: 'a69cd100454503d8ca0baac63bd4c3d8fc280d0c'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
  - '{project-root}/docs/DESIGN.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-11-2-the-node-toolbar.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A new operator opens an empty canvas with one muted line of text and then has to read the Getting started card to learn the first moves.

**Approach:** The empty canvas shows a dashed **ghost card** where a project goes, and clicking it adds one. While the checklist is in play, short **inline hints** sit beside the first project and the first live session, naming the next key. Each fades out for good once its step is done, and hints can be hidden or shown from the palette.

## Boundaries & Constraints

**Always:**
- **Ghost card** (DESIGN.md "The ghost card"): replaces `Canvas.tsx`'s `.canvas-hint` line while `empty`. It is a dashed `--fg-faint` box of the project card's size (240 × 80), centred in the canvas element (screen space), reading `Drop a folder here` with the keys line `ctrl+o pick a folder · ctrl+k palette · f1 help` under it.
  - Keys come from the registry (`displayBinding`/`formatKeybinding` for `project.add`, `palette.toggle`, `help.toggle`), so a rebind shows.
  - A click runs `runCommand("project.add")`, with title `commandHint("project.add")`.
  - The rest of the canvas still pans and takes drops. A right-click on the card opens the canvas menu: the 11.1 `isBackground` selector swaps `.canvas-hint` for the ghost card's class.
  - It appears and goes with no animation.
- **Hints** come from a pure `hintsFor(sources, done, hidden)` in a new `src/help/hints.ts`, returning `{ target, kind, text }[]`:
  - `project`: on the first project in `workspace.projects` order, `n new session · hover for more`, until step `session` is done.
  - `handle`: on that same project, `drag to link · e`, only while its handle shows (hover or selected), until step `edge` is done. While it shows it **replaces** the `project` hint, so a card has at most one hint.
  - `review`: on the first session child (snapshot order) that has a live state, `r review changes`, until step `review` is done.
  - At most three. The keys in the texts come from the registry (`project.newSession`, `edge.link`, `review.changes`).
- **Placement**, decided to fit the Story 11.2 toolbar (which is to the right of the card, top-aligned):
  - The `project` hint sits **under** the project card, in the 12 px above `COLUMN_TOP`.
  - The `handle` hint sits right of the handle at the handle's height (below the toolbar row).
  - The `review` hint sits **right** of the session card, vertically centred, because the 8 px child gap is too small for a caption under it. It is not drawn while that card's toolbar shows, since the toolbar offers `review` itself.
- **Decided (Emils, 2026-11-04, after review):** adding a project (picker, drop, or an import that adds exactly one folder) selects its card, so the `n` the project hint names works at once. The hint text stays.
- Hints are a mono `--text-xs` `--fg-muted` caption outside the card box, with no border or surface, never the accent, and `pointer-events: none`. They render in the node components, beside the 11.2 toolbar.
- **When hints show:** the checklist store's state plus `hints.hidden: boolean | null` in `state.json`.
  - `null` (the default) means hints follow the card: shown while `cardVisible`.
  - `false` means shown even with the card dismissed or never shown (for undone steps).
  - `true` means hidden.
  - **Decided:** no hints are drawn while any pane is open. This stands in for "under an open pane" without measuring rectangles.
- **Leaving:** when a hint drops out (step latched, hidden, or its card is no longer first), it fades `opacity` 1 → 0 over 300 ms, then unmounts. Under `prefers-reduced-motion` it goes instantly. It never comes back for a latched step. DESIGN.md's Motion table already has the row; keep it accurate.
- **Commands:**
  - `hints.hide` ("Hide canvas hints", `when` hints would show) sets `hidden: true`.
  - `hints.show` ("Show canvas hints", `when` they would not show) sets `hidden: false`.
  - Both are in the palette and bindable, with no default key.
- **state.json schema 3** (`src-tauri/src/appstate.rs`): `hints: { hidden: Option<bool> }`, default `None`.
  - A version-2 file loads with the default and is written as version 3 on the next write. A newer file stays read-only, as in Story 10.3.
  - `state_get` carries `hints`, and a new `hints_set(hidden: Option<bool>)` IPC writes atomically through the existing write path. It is registered in `lib.rs`.
  - `settings.json` and `workspace.json` are untouched.

**Never:**
- No change to the checklist's steps, detection or card.
- No hints on non-first cards, edges, panes or the palette.
- No new dependency, and no image assets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty canvas | no projects | ghost card centred, keys from the registry; click → `project.add` | N/A |
| Rebound add | `project.add` → `ctrl+shift+o` | keys line reads `ctrl+shift+o pick a folder` | N/A |
| First project, fresh profile | card visible, nothing done | `project` hint under the first project | N/A |
| Handle showing | first project hovered or selected, `edge` undone | `handle` hint shown, `project` hint not | N/A |
| Live session | first live session, `review` undone | `review` hint right of it; gone while its toolbar shows | N/A |
| Step latches | `session` becomes done | `project` hint fades 300 ms, then removed | instant with reduced motion |
| Dismissed card | `hidden: null`, card dismissed | no hints | N/A |
| Show after dismiss | `hints.show` | hints for the undone steps; `hidden: false` persisted | N/A |
| Hide | `hints.hide` | all fade; `hidden: true` persisted | N/A |
| Pane open | any pane | no hints drawn | N/A |
| Version-2 file | `{version: 2, …}` | loads with `hints.hidden = null` | N/A |
| Newer file | version 4 | read-only, `hints_set` errors as `checklist_set` does | error surfaced like 10.3 |

</frozen-after-approval>

## Code Map

- `src/canvas/Canvas.tsx` -- `empty` and the `.canvas-hint` block (~186-192). Swap in the new `GhostCard` (a new `src/canvas/GhostCard.tsx`). `isBackground` (~251) names `.canvas-hint`; rename it to the ghost class. Move or replace the `.canvas-hint` CSS in `canvas.css` (~42-60).
- `src/canvas/ProjectNode.tsx`, `src/canvas/ChildNode.tsx` -- already hold `useHover` and `NodeToolbar` from 11.2. Add `<NodeHint target… hovered selected toolbarShown />`, with the hint read through a hook over `hintsFor`.
- New `src/help/hints.ts` (+ test) -- `hintsFor`, plus a `useCanvasHints()` hook or store selector that combines the workspace, live, checklist (`done`, `cardVisible`), the hints `hidden` value and the pane.
- `src/state/checklist.ts` -- `cardVisible`, `done`, and the `load` / `persist` pattern. Either add `hintsHidden` here, set from the `state_get` snapshot, or add a sibling `src/state/hints.ts`. Writes go through `hintsSet`.
- `src/ipc/index.ts` -- `AppStateSnapshot` (~103), the command map (~947), and `stateGet` / `checklistSet` (~1065-1080). Add `hints` and `hintsSet`.
- `src-tauri/src/appstate.rs` -- `SCHEMA_VERSION` (18), `AppStateFile` (26), `StateSnapshot` (53), the upgrade check (~127-134), and `set_checklist`, which is the pattern for `set_hints`. Unit tests: v2 upgrade, newer read-only, round trip.
- `src-tauri/src/ipc/mod.rs` -- `checklist_set` (~104) is the pattern for `hints_set`. `src-tauri/src/lib.rs` -- register it (~38) and extend the 10.3 round-trip test (~380).
- `src/commands/builtins.ts` (+ test) -- `hints.hide` and `hints.show`.
- `src/canvas/nodes.css` -- the hint caption and `.is-leaving` fade, using the reduced-motion pattern already in the file. The design lint must pass.
- Docs:
  - `README.md` step 1 (~82) now quotes the ghost card's words, and "Where things live" (~63-66) names the hints setting.
  - `docs/help/getting-started.md`: hints until each step is done, and how to hide or show them.
  - `CHANGELOG.md` Unreleased, under Canvas.
  - DESIGN.md "Inline hints" (~436): update the placement to this spec's (under the project, beside the handle, right of the session).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/appstate.rs`, `ipc/mod.rs`, `lib.rs` -- schema 3, `hints`, `hints_set`, with tests.
- [x] `src/ipc/index.ts`, the state store -- `hints.hidden` loaded and written. The store test covers the matrix's visibility rows.
- [x] `src/help/hints.ts` (+ test) -- `hintsFor`, one test per hint plus the replace rule, the cap at three, the latched steps and hidden/null/false.
- [x] `src/canvas/GhostCard.tsx`, `Canvas.tsx`, `canvas.css` -- the ghost card. A `renderToStaticMarkup` test covers the text, the registry keys including a rebind, and `title`.
- [x] `src/canvas/ProjectNode.tsx`, `ChildNode.tsx`, `nodes.css` -- hints with the fade-out. A test covers which card shows which hint, `pointer-events: none`, and none while a pane is open.
- [x] `src/commands/builtins.ts` (+ test) -- `hints.hide` and `hints.show` with their `when`s.
- [x] Docs, README, DESIGN.md and CHANGELOG as listed in the Code Map. `pages.test.ts`, `content.test.ts` and the design lint pass.

**Acceptance Criteria:**
- Given the full suite, when it runs, then `npm run typecheck`, `npm test` and `cargo test` (in `src-tauri`) pass, and the audit and hints scans need no new allow-list entries except for a reason-bearing one where a hint or ghost element has no command.

## Implementation Notes

- The ghost card's keys line is too wide for a 240-px box in mono (about 310 px at `--text-xs`), so the box holds `Drop a folder here` and the keys line sits under it, inside the same button (click and right-click cover both). DESIGN.md says so.
- `commandKey(id)` in `src/commands/keybindings.ts` is the one registry read for a key's text (ghost card and hints).
- Hints are read per card through `useSyncExternalStore` with a string snapshot (`kind|text`), so a live-poll tick re-renders only a card whose own hint changed. Rebinds re-render through `subscribeBindings`.
- A hint fades when it drops out (step latched, hidden, a pane opening, card no longer first; `leavingAfter`). A swap (project ↔ handle), the handle no longer showing or a toolbar showing drop it at once (`isTransientDrop`).
- The ghost card's keys line sits under the box, and the card is out of focus (`tabIndex -1`, no focus on mousedown). Adding exactly one new folder selects its card (`addProjectsAt`). The `review` hint targets the first live session whose card is drawn (`projectColumn`). `hints.hide` / `hints.show` need a hinted step undone.
- `hints_set` never errors: a newer or unreadable file keeps the value in memory and writes nothing, exactly as `checklist_set` does for a valid checklist.
- The `hints` store is a sibling `src/state/hints.ts`, fed by `applyStateReply` / `applyStateError`. `hints.hide` / `hints.show` need it loaded.

## Spec Change Log

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Project/review hints never fade: `n`/`r` open a pane, which drops them instantly | medium | `transient` includes `paneOpen`; matrix row "Step latches → fades" | patch |
| 2 | `n` named by the project hint does nothing on an unselected card | medium | `project.newSession` needs a selected project; adding doesn't select | intent_gap → Emils: select new projects; patch |
| 3 | `hints.show`/`hints.hide` offered when no hint step is left | low | `when` ignores undone steps; trivial | patch |
| 4 | Every card recomputes hints on every store tick, even when off or all done | low | early bail is trivial | patch |
| 5 | Ghost card is a focusable button: Space/Enter re-fire the picker | low | Space is the pan modifier | patch |
| 6 | `review` hint can target a session not drawn (collapsed project / behind show all) | medium | `firstLiveSession` ignores visibility | patch |
| 7 | Handle hint shows while dragging the first project | low | `handleShown` ignores `dragging` | patch |
| 8 | No tests: subscriptions, `transient` rule, ghost click | medium | static renders only | patch (extract pure helpers / View) |
| 9 | Hint captions read by screen readers; ghost button's name runs both spans | low | no `aria-hidden` / `aria-label` | patch |
| 10 | CHANGELOG lacks the handle hint; DESIGN lacks ghost hover state; deferred-work `isBackground` entry names `.canvas-hint` | low | docs | patch |
| 11 | Timer/unmount and `isBackground` untested in a DOM | medium (unverified) | no DOM env | defer |
| 12 | Newer-file `hints_set` doesn't error, matrix says "errors as checklist_set does" | false | `checklist_set` doesn't error on a newer file either; behaviour matches | reject |
| 13 | Nothing resets `hidden` to `null` | low | explicit choice persists by design | reject |
| 14 | `hints: null` hand-edit fails the whole file | low | `state.json` is never hand-edited (README) | reject |
| 15 | Edge latch by link drag drops handle hint instantly | low | rare; extra branch | reject |
| 16 | No-pan zone over the ghost card | false | spec: "the rest of the canvas still pans" | reject |
| 17 | Placement constants not derived from layout | low | cosmetic coupling | reject |
| 18 | README manual check lacks hint steps | low | spec's Verification covers it | reject |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass
- `cargo test --manifest-path src-tauri/Cargo.toml` -- expected: all pass

**Manual checks (if no CLI):**
- In `npm run tauri dev` with a fresh profile: the ghost card is centred and clicking it opens the folder picker. After adding a project, its hint is under the card. Hovering the card shows the handle hint. Pressing `n` and starting a session fades the project hint.
