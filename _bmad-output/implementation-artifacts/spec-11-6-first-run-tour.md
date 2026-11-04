---
title: 'Story 11.6: The first-run tour'
type: 'feature'
created: '2026-11-04'
status: 'done'
baseline_commit: '8864a4cafec43a9fa820cf6ad81aba2810457b79'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
  - '{project-root}/docs/DESIGN.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-11-3-ghost-card-and-inline-hints.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A new operator has no quick way to learn where things are (the canvas, a card, its toolbar, the handle, the palette) before starting.

**Approach:** On a fresh profile, a skippable six-stop tour starts once, after the first canvas frame. It dims everything except the thing it points at and shows a small card with Back, Next and Skip. It records that it was taken in `state.json` and can be run again from the palette. This deliberately reverses Epic 10's "no overlay tour" (Q9 and Q15 decided by Emils on 2026-11-04).

## Boundaries & Constraints

**Always:**
- **Start:** it starts on its own only when `first_run` (Story 10.3) is true and `tour.done` is false, after `reportFirstFrame` in `Canvas.tsx` (call a tour hook beside it). It starts once per launch at most. A pre-existing profile never starts it on its own.
  - While the tour is on, the Getting started card is held back. When the tour ends it shows as Story 10.3 says, and the Story 11.3 hints follow the card as before.
  - A read-only `state.json` (a newer schema, or unwritable) still lets the tour run, but at most once per launch, and it never writes.
- **State:** `src/state/tour.ts` holds `on`, `stop` and `done` (loaded from `state_get`), with `start()`, `next()`, `back()` and `end()`. `isTourOn()` is the `when` used by the tour commands.
- **Stops:** a typed table in `src/help/tour.ts`. Each stop has an `id`, a `title`, one or two sentences, an optional `target` (a `data-tour="<id>"` attribute on the real element) and an optional `figure` (a Story 11.4 `FIGURES` name). In order:
  1. **The canvas**: target the ghost card, or the canvas element when there are projects. Text: "Projects are cards; sessions and branches hang under them."
  2. **Add a project**: target the ghost card or the first project card. Text names `ctrl+o` and dropping a folder.
  3. **Start a session**: target the first project card's toolbar `new` button. The tour forces that card's toolbar shown, as if hovered. With no project, it uses no target and the `node-anatomy` figure.
  4. **Link nodes**: target the first project card's link handle, shown as if hovered. With no project, it uses the `draw-edge` figure.
  5. **Read the canvas**: no target, the `session-states` figure. Text: "the attention colour means a session needs you; `ctrl+j` goes there".
  6. **Everything is a command**: no target. Text: "`ctrl+k` lists every command with its key; `f1` opens help for where you are".

  Keys in stop text render as `<kbd>`, read from the registry so a rebind shows. A test checks that every target id appears in markup under `src/` (a static scan, the audit's pattern) and every figure is in `FIGURES`.
- **Look** (DESIGN.md **The tour**):
  - A dim layer at the palette backdrop's colour sits at z 14: over the shell, panes and toasts, under the palette (15) and the menu (20). Update the stack comment in `shell.css`.
  - The layer is four rectangles around the target's client rect, leaving a cut-out with the selected node's 1-px `--focus` outline at a 2-px offset.
  - The card sits right of the cut-out, else left, else below, kept in the window by `clampToArea`. With no target it is centred and shows the figure.
  - The cut-out moves between targets over 150 ms (instant under reduced motion). The card appears without animation.
  - No accent and no shadow (the design lint passes).
  - The layer takes pointer events, so nothing underneath can be clicked (Q15). A window resize or a target moving re-measures on the next frame. A target missing from the DOM falls back to no target.
- **Card and keys:**
  - The card's **Back**, **Next** (**Finish** on the last stop) and **Skip** run `tour.back`, `tour.next` and `tour.skip` through `runCommand`.
  - These are hidden commands with `when: isTourOn()` and keys `←`, `→`/`enter` and `esc`.
  - While the tour is on, the dispatcher runs only the tour commands and `palette.toggle`. While the palette is open over the tour, the palette's own commands also run. Every other binding is ignored, so tour keys always win.
  - The card has step text `2 / 6`. Focus moves to Next on each stop and returns to where it was when the tour ends.
  - `ctrl+k` opens the palette over the tour, and closing the palette brings the tour back as it was.
- **Re-run:**
  - `tour.start` ("Take the tour") is always in the palette and is bindable, with no default key. It runs from stop 1 and writes nothing until the tour ends.
  - It is also a **Take the tour** button on the Getting started help page beside **Show on canvas**.
  - A **tour** link sits in the Getting started card's header while `tour.done` is false.
- **Persist:** Finish or Skip writes `tour: { done: true }`:
  - `state.json` schema 3 gains `tour` beside 11.3's `hints`, with `serde(default)`, so v2 and earlier v3 files load with `done: false`.
  - A `tour_set(done)` IPC follows the `hints_set` pattern and is registered in `lib.rs`. `state_get` carries `tour`.
  - `settings.json` and `workspace.json` are untouched.

**Never:**
- The tour runs no command of its own and never selects or changes the canvas.
- No tour on profiles that existed before this build, unless the operator asks.
- No new dependency and no image assets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh profile | `first_run`, `tour.done` false | the tour starts after the first frame; the checklist card is held back | N/A |
| Existing profile | `first_run` false | no auto-start; `tour.start` in the palette | N/A |
| Empty canvas | no projects | stops 1–2 target the ghost card; stops 3–4 show figures | N/A |
| With a project | one project | stop 3 cuts out its toolbar `new` (forced shown), stop 4 its handle | N/A |
| Skip / Esc | any stop | tour ends, `tour_set(true)` written, card shows, focus restored | N/A |
| Finish | stop 6, Next | the same as Skip | N/A |
| Back on stop 1 | — | stays on stop 1 | N/A |
| Palette over tour | `ctrl+k`, then esc | palette opens over the dim; esc closes the palette and the tour is unchanged | N/A |
| Other keys during tour | `n`, arrows to move the selection | ignored (arrows are Back/Next) | N/A |
| Click under dim | click on a card | nothing happens | N/A |
| Re-run | `tour.start` with `done` true | runs from stop 1; ending writes nothing new | N/A |
| Read-only state.json | newer schema | runs once this launch, never writes | N/A |
| v2 / early v3 file | no `tour` key | loads `done: false` | N/A |
| Target missing | stop 3, but toolbar not in the DOM | centred card, no cut-out | N/A |

</frozen-after-approval>

## Code Map

- `src-tauri/src/appstate.rs` -- the `Hints` struct and `set_hints` from 11.3 are the pattern. Add `Tour { done: bool }` and `set_tour`. `src-tauri/src/ipc/mod.rs` gets `hints_set` → `tour_set`, and `lib.rs` registers it and extends the round-trip test.
- `src/ipc/index.ts` -- `AppStateSnapshot`, `hintsSet` → add `tour` and `tourSet`. `src/state/appState.ts` feeds the stores from `state_get`, as 11.3 does for hints.
- `src/state/checklist.ts` -- `cardVisible` (~113). Hold it back while the tour is on, e.g. via `isChecklistCardShown` / `ChecklistCard`'s render check. Keep `cardVisible`'s tested semantics.
- `src/canvas/Canvas.tsx` -- `reportFirstFrame` (~433). Call the tour's auto-start beside it, also outside Tauri, using the loaded flags.
- `src/canvas/GhostCard.tsx`, `ProjectNode.tsx`, `NodeToolbar.tsx`, `LinkHandles.tsx` -- add the `data-tour` attributes: `ghost`, `project` on the first project, `toolbar-new`, `handle`. Forced-shown: the first project's `shown` and `handleShown` also become true while the current stop targets them. Read the tour store with a narrow selector, so other nodes don't re-render.
- `src/commands/keybindings.ts` -- `handleKeydown` (~176) loops `listCommands({ enabledOnly: true })`. Add the tour-mode filter there.
- `src/commands/builtins.ts` -- add `tour.start`, `tour.next`, `tour.back` and `tour.skip`. `palette.toggle` and `palette.close` (~244) and `contextMenu.close` (~228) are for reference.
- `src/components/Tour.tsx` (new) + CSS -- the layer, the cut-out, the card, positioning with `clampToArea` (`src/state/ui.ts`), focus save and restore, and figures via `FIGURES`. Mount it in `App.tsx` beside the palette and menu.
- `src/components/HelpPane.tsx` (~270-280, Show on canvas) gets a **Take the tour** button. `src/components/ChecklistCard.tsx` header (~57-64) gets the **tour** link.
- Docs:
  - `README.md` "Where things live" names `tour.done`.
  - `docs/help/getting-started.md` gains a **The tour** section, within 400 words.
  - DESIGN.md "The tour" (~466-475) already exists: keep it true.
  - `CHANGELOG.md` Unreleased under Help, plus one line saying it replaces the earlier "no tour" stance.

## Tasks & Acceptance

**Execution:**
- [x] Rust `appstate.rs`, `ipc/mod.rs`, `lib.rs` -- `tour` and `tour_set`, with tests (v2/v3 without `tour`, read-only, round trip).
- [x] `src/ipc/index.ts`, `src/state/tour.ts` (+ test) -- the store and the auto-start rule. Tests cover matrix rows 1, 2, 5, 6, 7, 11 and 12.
- [x] `src/help/tour.ts` (+ test) -- the stops table, the static target scan and the `FIGURES` check, plus target selection with and without projects (rows 3 and 4).
- [x] `src/commands/builtins.ts`, `keybindings.ts` (+ tests) -- the tour commands and tour-mode dispatch (rows 8 and 9).
- [x] `src/components/Tour.tsx`, CSS, `App.tsx` (+ render test) -- the layer, the card, positioning, and the missing-target fallback (row 14). Focus moves to Next.
- [x] Node components -- the `data-tour` attributes and forced toolbar/handle.
- [x] `ChecklistCard.tsx`, `HelpPane.tsx` -- holding the card back, the **tour** link and the **Take the tour** button.
- [x] Docs, README, DESIGN.md and CHANGELOG.

**Acceptance Criteria:**
- Given the full suite, when it runs, then `npm run typecheck`, `npm test` (audit, hints, content, pages and the design lint) and `cargo test` pass, and `npx vite build` succeeds.

## Implementation Notes

- `→` and `enter` are two hidden carriers, `tour.next` and `tour.next.enter` (a command has one key; the palette's two toggles are the precedent). All four carriers' `when` is `isTourOn() && !isPaletteOpen()`, so with the palette open over the tour its input keeps `←`/`→` and `esc` closes the palette, not the tour. The dispatcher's tour-mode filter is `tourModeAllows` in `keybindings.ts`.
- The card handles Enter on its own focused button (Back / Skip run their own command, not Next) and traps Tab among its buttons, like the palette.
- The auto-start waits for both the first frame (`tourFirstFrame`, beside `reportFirstFrame`) and the `state_get` reply, in either order; a module flag makes it at most once per launch, and a manual `tour.start` counts.
- The tour holds back the Getting started card (`cardOnCanvas` in `ChecklistCard.tsx`) and the inline hints (`currentHints`); `cardVisible` / `isChecklistCardShown` keep their semantics.
- The figures stay out of the main bundle: `Tour.tsx` imports `help/figures` lazily. A target off screen counts as missing. `tour_set` writes only when `done` changes.
- Not tested in a DOM (the suite has no DOM environment): focus to Next and back, the rAF re-measure, and the forced toolbar / handle on the first card (the selector logic, `forcedOn`, and the markup attributes are tested).

## Spec Change Log

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | A command run from the palette over the tour changes the app under it (panes, projects, terminal focus steals tour keys) | medium | palette rows run normally; spec only covers open/close | patch: running a non-tour command from the palette ends the tour (as Skip) first |
| 2 | Take the tour from the Help pane leaves the pane open under the dim, covering targets | medium | `tour.start` closes only the menu | patch: close the open pane too |
| 3 | Card pinned flush to a corner when no side fits (whole-canvas target) | low | final clamp has no margin, no centring | patch: centre when no side fits; keep the margin |
| 4 | Stop text not announced; focus lands on Next only | low | no `aria-describedby` | patch |
| 5 | Native OS folder drop adds a project mid-tour | low | Tauri drop bypasses the layer | patch: ignore drops while the tour is on |
| 6 | Tab trap from a non-button focus skips to the wrong button | low | index -1 | patch |
| 7 | Keyboard page's table shows two identical "Tour: next" rows | low | `tour.next` / `tour.next.enter` share a title | patch |
| 8 | CHANGELOG says the card's tour link runs it again; link shows only while never taken | low | wording | patch |
| 9 | Untested: hints off during tour, ProjectNode tour wiring, `tour.start` closing the menu, `onCardKeyDown`, ChecklistCard with the tour store, Help button | medium | static/helper tests only | patch |
| 10 | First-frame auto-start wiring in Canvas untested | medium (unverified) | needs Flow mounted in a DOM | defer |
| 11 | Taken before `state_get` loads, or write fails, not recorded | low | auto-start needs `first_run`, true only on the first launch, so it never re-runs anyway | reject |
| 12 | Quit mid-tour on first launch: never auto-starts again | low | spec: auto-start only with `first_run`; `tour.start` stays available | reject |
| 13 | `projects[0]` off screen falls back to figures | low | fallback is designed | reject |
| 14 | rAF re-measure every frame | low | brief, one query per frame; observers add surface | reject |
| 15 | No `inert` on the rest of the app | low | layer takes pointer events; keys filtered | reject |
| 16 | Docs don't say keys are captured during the tour (keyboard/canvas pages); Diagnostics conflict naming `tour.skip` | low | getting-started covers it | reject |
| 17 | Unbound-key fallback text reads badly | low | default keys exist | reject |
| 18 | Approvals can't be answered during the tour | low | the tour is short; Esc skips | reject |
| 19 | Spec not in the diff | false | the spec is a separate artifact | reject |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass
- `cargo test --manifest-path src-tauri/Cargo.toml` -- expected: all pass
- `npx vite build` -- expected: success

**Manual checks (if no CLI):**
- In `npm run tauri dev` with a fresh profile (a temp config dir), the tour starts and the six stops point at the right things. Skip ends it, and a restart doesn't show it again. "Take the tour" runs it again.
