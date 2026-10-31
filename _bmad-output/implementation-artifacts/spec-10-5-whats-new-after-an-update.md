---
title: "Story 10.5: What's new after an update"
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'f518baba94f008175f42c181fb93c4e53b7bfad6'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After an update, nothing tells the operator that the app changed or where to read about it. (FR-HELP-7, FR-HELP-9; epics.md Story 10.5)

**Approach:** `state.json` records the last version seen.
- When the running version differs from that record, a muted `new in <version>` chip shows at the canvas's bottom-left, beside the Elsewhere chip. It stays across launches until the Changelog is opened, by any route; opening it records the version as seen.
- A fresh profile records the version silently and never shows the chip.

## Boundaries & Constraints

**Always:**
- **Show rule:** a pure function `shouldShowWhatsNew(stored, current, firstRun)`.
  - It returns false on a first run, and false while the current version is unknown.
  - Otherwise it returns true exactly when `stored !== current`. Any difference counts: newer, older, or a dev build with a changed version.
  - A missing record (`null`) counts as a difference. **Decision (orchestrator, 2026-10-31):** this follows Emils' 10.4 choice that the version bump is what shows the chip on his existing profile. His profile has no record yet.
- **`state.json`:**
  - Gains `lastSeenVersion: string | null`, and `SCHEMA_VERSION` becomes 2. This is the 10.3 triage note: bump the version when adding a field, so an older build treats the file as newer and never overwrites the field.
  - A version-1 file loads, with `lastSeenVersion` null.
  - On a first run, `load` writes the running version, together with the checklist's `shown`, in one save.
- **The running version comes from Rust** (`CARGO_PKG_VERSION`). The `state_get` snapshot adds `version` and `lastSeenVersion`.
- **Marking seen:** a new async IPC `whats_new_seen`, which takes no argument and records `CARGO_PKG_VERSION`. A read-only store does not write; the chip still goes for this run.
- **Seen by any route:** every Help route reaches the page through `showHelpPage` in `src/commands/help.ts`. Showing `CHANGELOG_PAGE` there marks the version as seen: Contents, `help.changelog`, `help.page`, a page link, F1's last-read page, and `help.whatsNew`. It is idempotent: once seen, no further IPC is sent.
- **The `help.whatsNew` command:**
  - Its title is "What's new". Its `dynamicTitle` is "What's new in <version>" once the version is known.
  - It is always enabled and listed, whether or not the chip shows. It has no default key.
  - It runs the same code as `help.changelog`.
- **The chip:**
  - A `<button>` reading `new in <version>`, with `onClick={() => runCommand("help.whatsNew")}` (the audit rule).
  - It has the Elsewhere chip's look: mono `--text-xs`, `--fg-muted`, a 1-px `--border`, `--radius-sm`, and the same hover and focus.
  - No accent, no OS notification, no banner, no motion.
  - It sits in the same bottom-left row as the Elsewhere chip. With no Elsewhere chip it takes the corner itself.
  - Opening the Elsewhere tray must still work and look as before.

**Never:**
- No network, and no OS toast.
- Never show the chip on a fresh profile.
- Never write `settings.json`, `workspace.json` or `~/.claude`.
- Do not change how the checklist behaves.
- Do not bump the app version.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Fresh profile | first run, no state.json | file gets `lastSeenVersion: <current>`, `shown: true`; no chip | N/A |
| Same version | stored 0.1.0, current 0.1.0 | no chip | N/A |
| Updated | stored 0.1.0, current 0.2.0 | chip `new in 0.2.0` until the Changelog opens | N/A |
| Downgraded / dev build | stored 0.2.0, current 0.1.0 | chip `new in 0.1.0` | N/A |
| Profile from before this story | v1 file or no file, not first run | `lastSeenVersion` null → chip | N/A |
| Changelog opened | any route while the chip shows | chip goes; file records current; next launch has no chip | read-only: chip goes for this run, not written |
| Newer schema file | version 3 on disk | read what is understood, never written (as 10.3) | read-only |
| No Tauri / state_get fails | — | no chip; `help.whatsNew` still opens the Changelog | swallowed, as checklist |

</frozen-after-approval>

## Code Map

- `src-tauri/src/appstate.rs` -- `SCHEMA_VERSION` :17 → 2. Add `last_seen_version: Option<String>` to `AppStateFile` (:23–34; it uses `#[serde(default, rename_all="camelCase")]`, so a v1 file loads). In `load(path, first_run)` (:116–127), set it to the current version beside `shown=true`, then make one `save()`. Add a `mark_version_seen(&mut self, version)` that saves only on a change. `StateSnapshot` (:47–53) gains `version` and `last_seen_version`. Pass the version in from the caller, so tests can use any string. Tests to update: `defaults_are_version_1…` (:187) and the newer-schema test (:314, whose literal 2 becomes 3). The doc comment at :6 already names this story.
- `src-tauri/src/ipc/mod.rs` -- `state_get` (:94) passes `env!("CARGO_PKG_VERSION")`. Add an async `whats_new_seen`, modelled on `checklist_set` (:102–108). Register it in `src-tauri/src/lib.rs`'s `generate_handler` near :37–38. Extend the round-trip test (:379–424).
- `src/ipc/index.ts` -- `AppStateSnapshot` (:102–107) gains `version` and `lastSeenVersion`. Add `whats_new_seen` to the command map (near :944) and a `whatsNewSeen()` function (near :1068).
- New `src/help/whatsNew.ts` -- the pure `shouldShowWhatsNew`, with tests.
- New `src/state/whatsNew.ts` -- a small zustand store: `version`, `show`, `writable`, `load(snapshot)`, `setLoadError()`, and `markSeen()` (clears `show` and calls `whatsNewSeen()` once, only when writable and Tauri is present). Model it on `src/state/checklist.ts`: `persist` (:47–57), `writable`, `setLoadError`.
- `src/App.tsx` :163–179 -- the same `stateGet()` result also feeds the what's-new store, and an error calls its `setLoadError`.
- `src/commands/help.ts` -- `showHelpPage` (:16–19) is the single chokepoint. When `id === CHANGELOG_PAGE`, call `markSeen()`. Add `whatsNewTitle()`.
- `src/commands/builtins.ts` -- register `help.whatsNew` beside `help.changelog`. `dynamicTitle` examples are at :619–626. Update `builtins.test.ts` (the command count and the title lists).
- `src/components/ElsewhereTray.tsx` -- `.elsewhere` (:54) returns null with no rows (:52). New `src/components/WhatsNewChip.tsx`. Both go in one bottom-left row wrapper rendered in `App.tsx` (:290). Move `.elsewhere`'s `position:absolute; left/bottom:0.75rem` (`shell.css` :868–878) onto the wrapper, keeping the tray's column layout. The chip reuses the `.elsewhere-chip` rules (:880–900), shared or extracted.
- Docs: in `CHANGELOG.md`, a bullet under Unreleased → Help. In `ROADMAP.md`, remove "What's new after an update" from Next. A sentence in `docs/help/canvas.md` or `getting-started.md` (each page has a 400-word cap; keyboard.md is full). In `docs/DESIGN.md`, a chip entry. In `README.md`, the "Where things live" `state.json` row adds the version seen.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/appstate.rs`, `ipc/mod.rs`, `lib.rs` -- add the field and schema 2, the first-run record, `mark_version_seen`, the snapshot fields and the `whats_new_seen` IPC, with Rust tests for the matrix's state rows (temp dirs only) -- persistence
- [x] `src/ipc/index.ts` -- add the types and the function -- the bridge
- [x] `src/help/whatsNew.ts` (+ test) -- add the pure show rule, testing every matrix row -- the decision
- [x] `src/state/whatsNew.ts` (+ test) -- add the store: load, a load error, `markSeen` idempotent and not written when read-only -- state
- [x] `src/commands/help.ts`, `builtins.ts` (+ tests) -- add `help.whatsNew` with its dynamic title; showing the Changelog marks it seen (test: Contents row, `help.changelog`, `help.whatsNew`, `help.page` and the F1 last-read route) -- every route
- [x] `src/components/WhatsNewChip.tsx`, `ElsewhereTray.tsx`, `App.tsx`, `shell.css` (+ render test) -- add the chip and the shared corner row -- the visible pointer
- [x] Docs as in the Code Map -- keep them true

**Acceptance Criteria:**
- Given the palette, when I type "new", then "What's new in 0.1.0" is listed whether or not the chip shows, and running it opens Help → Changelog.
- Given the chip and the Elsewhere chip both showing, when the canvas renders, then they sit side by side at the bottom-left, and the Elsewhere tray still opens.
- Given the audit and the design lint, when the tests run, then both pass.

## Implementation Notes

- **Version plumbing (Rust):** `appstate::load(path, first_run, version)` takes the running version from the caller and keeps it on `AppStateStore.version`; `initialise_at` passes `env!("CARGO_PKG_VERSION")`, tests pass `"0.2.0"`. The snapshot reads it from the store rather than `state_get` passing it in, so `checklist_set` and `whats_new_seen` return the same full snapshot. `whats_new_seen` passes `CARGO_PKG_VERSION` to `mark_version_seen`, which saves only on a change (and `save()` already skips read-only / no path).
- **First run:** the checklist `shown` flag and `lastSeenVersion` are set together and written in one `save()`, only when either changed.
- **The round-trip test** lives in `lib.rs` (`state_get_and_checklist_set_round_trip_through_state_json`), not `ipc/mod.rs` as the Code Map says; extended there, plus a new `whats_new_seen_records_the_running_version` IPC test. The newer-schema test now uses version 3 and also checks `mark_version_seen` stays in memory.
- **Frontend store (`src/state/whatsNew.ts`):** module flags `seen` / `sent` / `pending`. `whats_new_seen` is sent at most once a run, and only when the stored version differs from the running one (nothing to record otherwise). If the Changelog is opened before `state_get` replies, `load` hides the chip and sends the record then. A failed `state_get` (`setLoadError`) leaves `writable` false, so nothing is ever sent. Without Tauri nothing is sent.
- **`whatsNewTitle()`** lives in `src/commands/help.ts` (as the Code Map says), reading the store's version.
- **Palette lists:** "What's new" sorts after "Toggle command palette", and typing `help` also lists it (the palette matches ids, `help.whatsNew`); `builtins.test.ts` and `help.test.ts` lists updated, count 102 → 103.
- **Chip + corner row:** a `.corner-row` wrapper in `App.tsx` now holds the absolute bottom-left position (`align-items: flex-end`, so the chips share the bottom line while the tray's list opens above its own chip); `.elsewhere` keeps its column layout. The chip rules were extracted to a shared `.corner-chip` class (both chips carry it; `.elsewhere-chip[aria-expanded]` keeps the open look).
- **Surprise -- render tests:** `renderToStaticMarkup` reads zustand's initial (server) state, so store-driven components cannot be rendered after `setState`. Added `ElsewhereTrayView` (props `rows`, `open`, optional `trayRef`) and `chipVersion()` / `WhatsNewChipView` so the row test renders from state. CSS is read with the same dynamic `node:fs` trick as the design lint (`?raw` CSS is empty under vitest).
- **Route tests** are in a new `src/commands/whatsNew.test.ts` (it mocks `../ipc` with Tauri present, which `help.test.ts` cannot do without disturbing its other tests): `help.whatsNew`, `help.changelog`, `showHelpPage` (Contents row / page link), the `help.page` pick and F1's last-read page.
- **Docs:** the help sentence went into `getting-started.md` (now ~370 words) under "After an update", linking `CHANGELOG.md`. DESIGN.md gains the chip entry and the chip in the no-animation list.
- `npm run build` still prints the pre-existing >500 kB chunk warning.
- **Review fixes:** App's `stateGet` reply/error handling moved into `applyStateReply` / `applyStateError` (`src/state/appState.ts`, tested; App keeps the `disposed` guard). A rejected `whats_new_seen` now resets `sent`/`pending`, so the next showing of the Changelog retries. Added a chip onClick test, a Rust test for a first run meeting an older `lastSeenVersion`, and reworded the getting-started and README text.

## Spec Change Log

## Review Triage Log

Pass 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG; the three runs were cut by a network error and resumed).

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| VG1 / BH8b | App's `stateGet` reply → what's-new store, and the chip's mount, untested | medium | App.tsx is the only caller of `useWhatsNewStore.load`; no App test; deleting the line keeps the suite green | patch: one exported `applyStateReply` / `applyStateError` in `src/state/` feeding both stores, tested; App calls it |
| VG2 / BH8a | The chip's `onClick` never runs in a test | low | static markup drops handlers; a typo'd id passes; the element's `props.onClick` can be called directly | patch |
| EC2 / BH7 | `send()` sets `sent`/`pending` before the IPC settles; a rejection is never retried | low | `src/state/whatsNew.ts` `send`; direct fix in `.catch` | patch |
| BH8c | No Rust test: first run meeting a valid file with an older `lastSeenVersion` | low | `load` handles it (records the current version); untested branch; one test | patch |
| BH9b | getting-started.md says the chip shows "the first time a new version starts"; it stays until the Changelog opens | low | doc text vs `shouldShowWhatsNew`; direct correction | patch |
| BH9c | README: deleting `state.json` also brings the chip back on an existing profile | low | `null` counts as a difference (frozen decision); one clause | patch |
| BH10c | `ElsewhereTray` doc comment line far past the file's width | low | diff; direct reflow | patch |
| EC3 / BH2 / EC5 | A read-only `state.json` (newer schema after a downgrade, unreadable file, no config dir) keeps the chip back every launch | medium | `mark_version_seen` keeps it in memory only; the snapshot has no `readOnly`, so the frontend cannot tell. The root (read-only state invisible to the UI) is pre-existing from 10.3, where the checklist freezes the same way | defer |
| EC1 | `save()` only logs a failed write; the frontend thinks it was recorded | low | same `save()` contract as the checklist (10.3); a failed atomic write is rare; surfacing it is new error plumbing | reject |
| EC4 / BH1 | Schema 2 makes an older build read the file as read-only after a downgrade | false | the bump is the recorded decision (10.3 triage #13, frozen Always) so an older build never drops `lastSeenVersion` | reject |
| BH3 | `whats_new_seen` uses `env!` while the store holds `self.version` | low | both are `CARGO_PKG_VERSION` of the same crate; no divergence possible in the app | reject |
| BH4 | "new in <version>" after a downgrade or a dev build; Changelog not scrolled to it | false | frozen: any difference counts (epics AC); the Changelog opening at the top is the spec'd route | reject |
| BH5 | `null` treated as an update | false | frozen decision (orchestrator, recorded) | reject |
| BH6 | The chip may move right / the list be squeezed when the Elsewhere list opens | maybe-false | needs a GUI look with Elsewhere rows; cosmetic at worst (low) | reject (note: look when Elsewhere has rows) |
| BH8d | `whats_new_seen`'s returned snapshot is dropped | false | nothing needs it: the store already hid the chip; deliberate | reject |
| BH9a | "What's new" is not titled "Help: …" | false | the epics AC names it "What's new in <version>" | reject |
| BH10a | Unreachable `current === null/""` branches | low | defensive, harmless | reject |
| BH10b | getting-started.md links `CHANGELOG.md` from docs/help | false | `pageIdOfFile("CHANGELOG.md")` resolves; the content test's link check passes | reject |
## Verification

**Commands:**
- `npx tsc --noEmit` -- clean
- `npx vitest run` -- all pass
- `cargo test --offline` and `cargo clippy --offline --all-targets -- -D warnings` in `src-tauri` -- pass, clean
- `npm run build` -- OK

**Manual checks:**
- GUI pass (orchestrator), with a scratch `state.json` holding `lastSeenVersion: "0.0.9"`: the chip shows; clicking it opens the Changelog and the chip goes; the file now holds 0.1.0; a relaunch shows no chip. A fresh config shows no chip.

**Verification results (orchestrator, 2026-10-31):**
- `npx tsc --noEmit` clean; `npx vitest run` 847/847 (65 files); `cargo test --offline` 653 passed; `cargo clippy --offline --all-targets -- -D warnings` clean; `npm run build` OK; release `tauri build --no-bundle` OK.
- GUI pass (release exe, scratch config swapped in each run; real config restored, nothing left running):
  - Run 1, existing profile with `lastSeenVersion: "0.0.9"`: the chip `new in 0.1.0` at the canvas's bottom-left in the muted chip look; clicking it opened Help → Changelog (the new Unreleased bullet visible) and the chip went; `state.json` then held `lastSeenVersion: "0.1.0"`, checklist kept.
  - Run 2, relaunch on that file: no chip.
  - Run 3, fresh profile (settings.json only): no chip; the Getting started card shows; `state.json` written with `version: 2`, `shown: true`, `lastSeenVersion: "0.1.0"`.
  - Not exercised in the GUI: the chip beside a live Elsewhere chip (needs live sessions elsewhere); covered by the corner-row render test (BH6 noted).
- Review: 25 findings; 7 patched, 1 deferred (read-only state.json brings the chip back each launch; deferred-work.md), 17 rejected. Linux CI pending (Actions suspended).
