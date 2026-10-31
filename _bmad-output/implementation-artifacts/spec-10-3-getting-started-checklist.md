---
title: 'Story 10.3: Getting started checklist'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'b7eca1db938f6d76f24ea909016aa4c9453943c9'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-10-2-guide-pages-and-f1-from-where-you-are.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A new operator has nothing that walks them through the app's first moves. The guide pages explain the app, but nobody reads them first.

**Approach:**
- On a fresh profile, a compact **Getting started** card at the canvas's top-right lists six steps.
- Each step ticks itself off from app state as the operator really does it, by any route.
- Progress and dismissal persist in a new app-written `state.json`.
- The same list is a Help page, with **Show on canvas**, so existing profiles can reach it too.

Emils decided on 2026-10-30: a canvas card plus a Help page (PRD Q7).

## Boundaries & Constraints

**Always:**
- The six steps, in order, with their keys:
  - Open the command palette (`ctrl+k`);
  - Add a project (`ctrl+o` or drop a folder);
  - Start a session (`n` on a project node);
  - Open a plain terminal;
  - Link two nodes (`e`);
  - Review changes (`r`).
- A step whose command is enabled now is a button that runs it; otherwise it is plain text.
- A ticked step shows a muted `✓` in `currentColor`.
- Ticks come from state, never from which button was pressed. Once true, a step stays ticked (latched), even when the state later goes away (the palette closes, an edge is deleted).
- `state.json` sits beside `settings.json`.
  - It is schema-versioned, loaded with `persist::load_or_init` and written with `write_atomic_json`.
  - It is never watched and never hand-edited; deleting it resets only the checklist.
  - `settings.json` and `workspace.json` are untouched.
- Every action is a registry command, in the palette and bindable:
  - `checklist.show` "Show getting started";
  - `checklist.dismiss` "Dismiss getting started";
  - `help.gettingStarted` "Help: getting started".
- Follow DESIGN.md: tokens only, no accent, no animation. The card is information: no wizard, overlay or modal.

**Never:**
- Never write `~/.claude`, `settings.json` or `workspace.json` for this.
- No network.
- No new dependency.
- No What's new / version state yet (Story 10.5 adds it to `state.json` later; leave room in the schema).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh profile | `workspace.json` created on this launch | Card shows; `state.json` records it as shown | — |
| Existing profile | `workspace.json` existed; no `state.json` | No card; Help page and `checklist.show` still work | — |
| Restart | Card shown, not dismissed, 2 steps done | Card back with the 2 ticks | — |
| Already true | Projects exist when the card first shows | "Add a project" ticked at once | — |
| Any route | Session started by an agent's approved `start_session` reaches busy/idle/waiting/finished | "Start a session" ticks | `starting` alone does not tick |
| Transient | Palette opened then closed; edge drawn then deleted | Steps stay ticked | — |
| All done | Sixth step ticks | Card reads `All done`; gone at next launch, or at once with Dismiss | — |
| Dismiss | Dismiss, or `checklist.dismiss` | Card gone and stays gone across restarts; the Help page still shows progress | — |
| Bad file | `state.json` unparsable | App runs with defaults (no card unless the profile is fresh); the next write replaces it | Logged once |
| Newer schema | `state.json` version above this build's | Read what is understood, never write it | — |

</frozen-after-approval>

## Code Map

**Rust**
- `src-tauri/src/persist.rs:35-142`: `Loaded{Created,Existing}`, `load_or_init`, `write_atomic_json`, `read_json`, `LoadError`.
- Schema pattern:
  - `graph/mod.rs:28` (`SCHEMA_VERSION`) and `graph/store.rs:24` (`validate`): an older version upgrades silently; a newer one is read-only, as at `graph/mod.rs:792`.
- `src-tauri/src/settings/paths.rs`:
  - add `STATE_FILE_NAME = "state.json"` and `state_path_in(base)` / `state_path()` beside `keybindings_path_in`;
  - add a test like `keybindings_path_sits_beside_settings_json`.
- First-run signal: `graph/mod.rs:806-848`. `initialise_at` discards `Created`/`Existing` (`st.accept(loaded.into_inner())`) and must surface it into `AppState`, e.g. as `first_run: bool`.
- `settings/mod.rs:366` (`AppState`): add a `RwLock<AppStateFile>` field with accessors (copy `read_workspace` / `write_workspace`).
- `lib.rs`:
  - setup at 215-250: load `state.json` after `graph::initialise`;
  - `generate_handler!` at :30;
  - IPC tests use `mock_app()` and `invoke_with`, with temp dirs only (as `graph/mod.rs:2541`).

**Frontend**
- `src/ipc/index.ts:919` (`Commands`) and wrappers near `keybindingsGet` (l.1035); add `state_get` and `checklist_set`.
- Startup loads: `src/App.tsx:103-210`; the keybindings store (l.115) is the model, with a `loaded` flag and the `hasTauriRuntime()` guard.
- Detection sources:
  - `useWorkspaceStore.snapshot?.workspace.projects` / `.edges`;
  - `useTerminalStore.infos` (`kind` session / plain), `sessionIdOfTerminal` (`terminals.ts:113`);
  - `useLiveStore.snapshot.sessions[sid].state`;
  - `useUiStore.pane === "review"` together with `useReviewStore.target !== null`;
  - `usePaletteStore.isOpen`, latched (`openPick` also sets it; that counts).
- Step commands in `src/commands/builtins.ts`:
  - `palette.toggle`, `project.add` (l.316), `project.newSession` (l.409), `project.terminal` (l.418), `edge.link` (l.639), `review.changes` (l.728);
  - `isCommandEnabled(id)` is at `registry.ts:360`.
- Placement: `App.tsx:262-295`. Render the card right after `<Canvas/>` in `.shell-body`. z-index:
  - `src/components/shell.css` stack: `.elsewhere` 4, `.notice-region` 5, `.pane` 10, `.approvals` 12, palette 15, menu 20;
  - so give the card z 4 and offset it below the notice line.
- Help page:
  - `docs/help/getting-started.md` goes into `src/help/pages.ts`;
  - `src/help/content.test.ts` requires it to be listed, and every key it names to be a default;
  - `HelpPane.tsx:87`: render the live list and **Show on canvas** for that page, the way the Keyboard page appends its table.
- Lint and docs:
  - `src/commands/audit.test.ts`: the card's step buttons may run `runCommand(step.command)` through one local function; Dismiss runs `runCommand("checklist.dismiss")`.
  - `src/theme/design.test.ts`: no accent.
  - DESIGN.md "Layout pieces" (l.165): add the card.
  - README "Where things live" (l.63-72): add `state.json`.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/appstate.rs` (new, mirroring `graph/store.rs`), `paths.rs`, `graph/mod.rs`, `settings/mod.rs`, `ipc/mod.rs`, `lib.rs` (+ tests) -- the file and its IPC:
  - The file: `{ version: 1, checklist: { shown, dismissed, done: [step ids] } }`.
  - Loading:
    - read at startup;
    - if the workspace was `Created` this launch and the file has `shown: false`, set `shown: true` and write.
  - IPC:
    - `state_get` returns `{ firstRun, checklist }`;
    - `checklist_set(checklist)` validates the step ids and writes atomically, but not when the file is newer-schema.
  - Tests cover every Matrix file row.
- [x] `src/help/checklist.ts` + test -- the steps table (`id`, title, key text, command id) and a pure `detectSteps(stores) -> Set<StepId>`, one test per step, including `starting` not counting.
- [x] `src/state/checklist.ts`, `src/App.tsx`, `src/ipc/index.ts` (+ tests) -- the store:
  - load at startup and latch newly detected steps (union with saved `done`);
  - persist on change through `checklist_set`;
  - when all six are done, `All done` until the next launch, which drops the card.
- [x] `src/components/ChecklistCard.tsx` (+ `shell.css`, render test) -- the card: title **Getting started**, the six rows (button or text, `✓`), **Dismiss**.
- [x] `src/commands/builtins.ts` (+ counts in `builtins.test.ts`), `src/commands/help.ts` -- `checklist.show`, `checklist.dismiss`, `help.gettingStarted`.
- [x] `docs/help/getting-started.md`, `src/help/pages.ts`, `HelpPane.tsx` -- the Help page with the live rows and **Show on canvas**; keep `content.test.ts` green.
- [x] `docs/DESIGN.md`, `README.md` -- the card under Layout pieces; `state.json` in "Where things live".

**Acceptance Criteria:**
- Given a fresh profile, when the canvas shows, then the card is at the top-right under the banner strip, above the canvas and below panes, the palette, the menu and toasts.
- Given the suites, when they run, then the checklist, state, audit, design, builtins and help-content tests pass, and `cargo test` and clippy are green.

## Design Notes

**Card visibility:** `checklist.shown && !checklist.dismissed && !(allDoneAtLoad)`.
- `allDoneAtLoad` is computed once at startup, so the card that reaches `All done` this run stays until the next launch.
- `checklist.show` sets `shown: true` and `dismissed: false`.

Step ids: `palette`, `project`, `session`, `terminal`, `edge`, `review`.

## Verification

**Commands:**
- `npx tsc --noEmit`; `npx vitest run --root /b/projects/ide` -- expected: green
- `cargo test --offline`, `cargo clippy --offline --all-targets -- -D warnings` (in `src-tauri`) -- expected: green
- `npm run tauri build -- --no-bundle` -- expected: builds

**Manual checks:**
- Orchestrator GUI pass. Foreground-guarded; abort if any Switchboard runs; window chosen by process path; a fresh temp config dir and stub `claude`.
  - Fresh profile: the card shows.
  - `ctrl+k` then Esc ticks the palette step.
  - `ctrl+o` is not exercised (it opens a native picker).
  - Restart keeps the ticks; Dismiss hides the card across a restart.

## Implementation Notes

- **Where the state lives.** `AppState.state_file: RwLock<appstate::AppStateStore>` (path, file, read-only reason, `first_run`); `first_run` comes from `WorkspaceState.first_run`, set in `graph::initialise_at` when `load_or_init` returned `Created`.
- **Bad and odd files.** Unparsable: defaults in memory, one `eprintln!`, not rewritten until the next `checklist_set` (or at once on a fresh profile, which marks it shown). Unreadable (e.g. a directory in its place) or newer schema: read-only for the session, changes kept in memory. Unknown step ids in a loaded file are dropped from memory; `done` is always kept once each, in checklist order.
- **`checklist.show` after All done.** The card's visibility rule hides a checklist that was complete at load; `checklist.show` also clears `allDoneAtLoad`, so the explicit command brings the card back (reading `All done`). Without that, Show on canvas would do nothing on a finished checklist.
- **When the commands are enabled.** Both checklist commands only once `state_get` has answered: `checklist.show` while the card is not showing, `checklist.dismiss` while it is; `help.gettingStarted` always. After a failed `state_get` the store ticks in memory but never calls `checklist_set` (`writable: false`).
- **Rust latches too.** `checklist_set` keeps the union of the stored and incoming `done`; a file that cannot be created (`LoadError::Write`) is read-only (`unwritable`) for the session.
- **Detection stops** once all six steps are latched; the hidden card does not follow the stores.
- **Detection details.** Plain terminal: a `plain` terminal whose shell started (`error === null`). Session: a `session:` terminal whose session's live state is busy, idle, waiting or finished. Steps detected before `state_get` answers are kept and added on load.
- **All done.** The card shows a muted `All done` line in place of the six rows.
- **Help page.** `getting-started` is the twelfth entry in `HELP_PAGES` (after Terms, as Contents wants). `help.test` and `pages.test` now count twelve.
- **Docs beyond the Code Map.** The README clean-machine checklist (items 1 and 2) now names the card and `state.json`.

- **Orchestrator fix found in the GUI pass (Story 10.2 hint).** The empty-canvas hint rendered `ctrl+k· F1help`: `.canvas-hint` is a flex box, so each text piece was a flex item and lost its edge spaces. Its content is now one `<span>`.

## Spec Change Log

## Review Triage Log

Review pass 1 (blind-hunter, edge-case-hunter, verification-gap; diff b7eca1d..working tree):

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind, edge | Show before `state_get` answers writes `done: []` and `dismissed: false` over the saved file | medium | `checklist.show`'s `when` is `!isChecklistCardShown()`, which is true before load (`cardVisible` needs `loaded`). patch: enable only once loaded |
| 2 | blind, edge | After a failed `state_get`, later writes replace the real file with defaults | medium | `setLoadError` sets `loaded: true`; `persist` then writes in-memory state. patch: never write after a load error |
| 3 | blind | Rust does not enforce latching | low | `set_checklist` replaces `done`. Direct union. patch |
| 4 | vg | No test pins Rust `STEP_IDS` to the frontend's six | medium (pre-verified) | Rust tests never use `session` or `terminal`. patch: a six-id round-trip test |
| 5 | edge | A `LoadError::Write` leaves the store writable, so every write retries and logs | low | `appstate.rs` `load_into` Write arm. Direct. patch |
| 6 | edge | A second `load()` drops steps latched since the first | low | `main.tsx` uses `React.StrictMode` (a dev double effect). Direct union. patch |
| 7 | blind | Detection and the card's refresh keep running when they no longer matter | low | The hook runs before `return null`; the detector runs after all six are done. Direct moves. patch |
| 8 | vg, edge | **Show on canvas** enablement goes stale | low | `GettingStartedProgress` does not subscribe to the checklist store. patch |
| 9 | edge | The card has no height limit on a short window | low | One CSS rule. patch |
| 10 | blind | getting-started.md: "for good" contradicts Show on canvas | low | Text fix. patch |
| 11 | vg, blind | The `App.tsx` startup wiring (load, `startChecklist`) is untested | medium (pre-verified) | The repo tests no `App.tsx` startup effect (keybindings and live follow the same pattern); needs new infrastructure. defer; the GUI pass covers it |
| 12 | blind, edge | Card key text ignores `keybindings.json` rebinds | low | Rebinding these is rare and the fix adds subscriptions. Rejected |
| 13 | blind | Unknown keys in a same-version file are lost on write | low | Only a downgrade from a later build could hit it; Story 10.5 bumps the schema version when it adds a field. Rejected (noted for 10.5) |
| 14 | blind, edge | Button enablement refreshes only on a chosen set of stores; the `project.add` picker flag is not a store | low | Rows correct themselves on the next render; the fix adds a registry signal. Rejected |
| 15 | blind | A plain terminal may tick before its spawn error arrives | low | Ticks a step early only; unlikely. Rejected |
| 16 | blind | No test for an agent-started session ticking | low | `App.tsx` `onAgentStarted` upserts a `kind: "session"` terminal, which `detectSteps` reads; the route is by code. Rejected |
| 17 | edge | A session that goes starting to exited between polls never ticks | low | Unlikely for a session that really ran. Rejected |
| 18 | blind | Read-only `state.json` is silent in the UI | low | Logged; the case needs a newer or unreadable file. Rejected |
| 19 | blind | Accessibility of unticked rows; hover on muted rows | low | Cosmetic. Rejected |
| 20 | blind | Spec and README leftovers | low | Spec edits or wrap width only. Rejected |

**Orchestrator verification (2026-10-31).**
- **Checks.** `tsc` clean; vitest 800/800; `cargo test` 645 passed; clippy clean; release build built (again after the hint fix).
- **GUI pass** (foreground-guarded, stub `claude`, three launches carrying `config-after` forward):
  - Run 1 is a fresh profile (settings only): the card showed at the top-right; `ctrl+k` then Esc ticked "Open the command palette"; `state.json` = `shown: true, done: [palette]`.
  - Run 2 restarted on that config: the card came back with the tick; "Dismiss getting started" hid it; `state.json` = `dismissed: true`.
  - Run 3 restarted again: no card.
- **Not checked.**
  - The hint's spacing fix was not re-run in the GUI (built, typed, tested only).
  - The other five steps were not exercised in the GUI (unit-tested per step).
  - Linux CI is pending.
