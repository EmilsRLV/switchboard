---
title: 'Story 9.4: Keybindings and palette completeness'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '642ffba9650ac9fef02e69a4dcac58b081f02a79'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The app is meant to be keyboard-first, but some pane buttons call their actions directly. Those actions have no palette command, so they are mouse-only. Keybindings are also fixed in code (the README says "not editable yet").

**Approach:**
- **Commands for every action.** Every pane-level button and menu item runs through a registered command, so it appears in the palette and can be bound to a key.
- **A static audit test.** It keeps it that way.
- **`keybindings.json`.** A file in the config directory overrides the default bindings. It reloads live, and its errors and conflicts are listed in Settings → Diagnostics.

**Decisions** (taken by the orchestrator under Emils' standing authorisation while he is away, recorded for his review):
- **What must be a command:**
  - **Pane-level controls must be commands.** These are buttons that act on the pane's current subject: the selection, the open sheet, the active terminal, or the oldest pending item.
  - **Missing commands to add:**
    - launch sheet: Start, Add folder;
    - worktree sheet: New / Existing mode and Create;
    - remove-worktree sheet: Remove, Force remove…, Discard and remove;
    - import: Add selected;
    - terminal: Return to pane;
    - review: Side by side, Unified, Back to commits, Dismiss review toast (oldest);
    - approvals: Always for this edge (oldest);
    - Elsewhere: Add folder (selected row) where a selection exists, otherwise exempt.
  - **Buttons that already have an equivalent command run it through `runCommand`:**
    - edge inspector: Revoke, Retry, Restart with flags;
    - terminal pane: Restart, Close, Kill, Pop out;
    - review: mode and filter buttons.
- **Item-level controls are exempt and documented.** These act on one specific row or item:
  - clicking a file, tree, commit or tab row, and a tab's ×;
  - a per-side Retry, and removing one add-dir row;
  - the Allow / Deny / Open / Dismiss buttons on a specific toast;
  - the base `<select>`;
  - pointer gestures on the canvas (click, drag-to-link).

  Each has a palette route over the selection, the current item or the oldest item where one makes sense.
- **Audit test (vitest, static):**
  - It scans `src/components/**/*.tsx` and `src/canvas/**/*.tsx` for `onClick`/`onChange`/`onSubmit` handlers.
  - Each handler must call `runCommand(...)` or appear in an explicit allow-list, which records each exemption with its reason.
  - A new direct handler fails the test.
- **`keybindings.json`:**
  - **Where:** in the config directory beside `settings.json`.
  - **Shape:** `{ "<command id>": "<binding>" | null }`, where `null` unbinds the command. Unknown ids and unparsable bindings are errors, and the default is kept for them.
  - **Reading:** Rust only reads and watches the file, as for `settings.json`, and sends its raw text. The frontend parses it and applies it over the defaults.
  - **When it is missing:** the defaults apply.
- **Conflicts.** After overrides are applied, a conflict is two or more commands with the same binding where at least one binding came from `keybindings.json`. Shared default keys separated by `when` are intended and are not reported.
- **Settings → Diagnostics** gains a "Keybindings" list showing:
  - the file's status (`none`, `ok`, or `n errors`);
  - each error (`unknown command x`, `bad key "ctrl+"`);
  - each conflict (`ctrl+r: review.refresh, terminal.restart`).
- **Terminal pass-through.** The keys the terminal lets through to the app come from the effective bindings of their commands, not from hard-coded strings. Rebinding the terminal toggle therefore still works inside a terminal.
- **Palette** and README show the effective bindings. The README documents the file, the command ids and the exemptions.

## Boundaries & Constraints

**Always:**
- **Behaviour is unchanged by default.** The default bindings and their behaviour stay exactly as they are when no file exists.
- **Frontend owns the commands.** Command ids are stable. The registry stays in the frontend; Rust only provides the file.
- **No new packages.** Tests never run the real `claude`.

**Never:**
- A UI editor for bindings.
- Chords or sequences.
- Changing default keys.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| No file | — | defaults; Diagnostics `keybindings.json: none` | — |
| Override | `{"review.refresh":"ctrl+shift+r"}` | ctrl+shift+r refreshes; palette shows it | — |
| Unbind | `{"terminal.kill":null}` | no key for kill; palette shows none | — |
| Unknown id | `{"nope":"x"}` | error listed; others applied | — |
| Bad key | `{"review.refresh":"ctrl+"}` | error listed; default kept | — |
| Conflict | override `review.refresh` to `ctrl+k` | Diagnostics lists `ctrl+k: palette.toggle, review.refresh` | — |
| Live reload | edit file | applies without restart | invalid JSON → error, previous kept |
| Terminal toggle rebound | `terminal.toggle` → `ctrl+shift+t` | works inside a focused terminal | — |
| New direct onClick | a component adds `onClick={doThing}` | audit test fails | allow-list with reason |

</frozen-after-approval>

## Code Map

- **`src/commands/registry.ts`:**
  - `Command` (:10-40);
  - `prepare` (:59) parses `keybinding`;
  - `registerCommands` (:80) and `runCommand` (:129).

  Add an override layer, e.g. `applyBindingOverrides(map)` returning errors, so the effective binding is computed from default plus override.
- **`src/commands/keybindings.ts`:** `parseKeybinding` (:76), `formatKeybinding` (:120), `handleKeydown` (:137) and `EDITABLE_PASS_KEYS` (:44).
- **`src/terminal/keys.ts`** (:10-22): derive the pass-through keys from the effective bindings of the named commands.
- **`src/commands/builtins.ts`** (`builtinCommands` :157): the new commands. Update the id lists and counts in `builtins.test.ts` (:56-207, :276, :313).
- **Components to route through commands** (from the audit):
  - `EdgePane.tsx` :124, :145, :154;
  - `TerminalPane.tsx` :145-209;
  - `ReviewPane.tsx` :405, :420, :441, :444, :459;
  - `LaunchPane.tsx` :255, :279;
  - `WorktreePane.tsx` :59, :62, :118;
  - `RemoveWorktreePane.tsx` :110, :122, :135;
  - `ImportPane.tsx` :96;
  - `ElsewhereTray.tsx` :70;
  - `ApprovalToasts.tsx` (Always);
  - `ReviewToasts.tsx` (Dismiss).
- **Rust:**
  - `settings/paths.rs`: add `KEYBINDINGS_FILE_NAME` and a path helper.
  - `settings/watch.rs`: reuse `start` (:16). It needs a second watcher slot (`state.watcher` :532 holds one).
  - Add a command `keybindings_get` and an event `keybindings://changed` carrying the raw text or a read error.
- **Frontend wiring:**
  - `src/ipc/index.ts`: the wrapper and event.
  - A new `state/keybindings.ts` store that parses and applies.
  - `SettingsPane.tsx` Diagnostics (:117-181) and `components/diagnostics.ts`: the Keybindings list.
- **`README.md`** "Commands & keys" (:146-213): fix the stale count, document the file, list the ids and the exemptions.

**Tests:**
- Override parsing and applying: unknown ids, bad keys, `null`, conflicts.
- The terminal pass-through follows the overrides.
- The audit test with its allow-list.
- Rust: reading and watching the file, plus missing and invalid cases.

## Tasks & Acceptance

**Execution:**
- [x] `registry.ts`, `keybindings.ts`, `terminal/keys.ts`, `state/keybindings.ts` (+tests): the override layer, conflicts and pass-through.
- [x] `builtins.ts` plus the components listed above (+tests, including the audit test): the missing commands and routing.
- [x] `settings/paths.rs`, `settings/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests): read and watch `keybindings.json`, plus the command and event.
- [x] `SettingsPane.tsx`, `diagnostics.ts`, `README.md`, `docs/DESIGN.md`.

**Acceptance Criteria:**
- Given the command registry, when the audit test runs, then every pane-level button and menu item runs a registered command, and the remaining direct handlers are all allow-listed with a reason.
- Given a `keybindings.json` that rebinds a command, when it is saved, then the new key works without a restart. When it conflicts or is invalid, the problem shows in Settings → Diagnostics.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass, and the debug build builds.

## Implementation Notes

- **Registry override layer** (`commands/registry.ts`): a registration keeps its parsed default (`defaultBinding`);
  `binding` is the effective one and `bindingSource` says whether `keybindings.json` changed it.
  `applyBindingOverrides(obj)` replaces all overrides and returns errors (`unknown command x`,
  `bad key "ctrl+" for <id>`; non-string values too); `bindingConflicts()` lists `key: id, id` groups where one
  binding is an override. An override equal to the default counts as default (so `{"project.newSession":"n"}`
  reports nothing). Unknown ids are judged against what is registered when the file applies (all builtins
  register at module load). Added `runCommandAsync` for the edge inspector's Restart (stays disabled while it runs).
- **`state/keybindings.ts`** parses the raw text; invalid JSON, a non-object or a read error is one error and keeps
  the previous overrides; a missing file resets to defaults; an empty file is `{}`. Wired in `App.tsx` with
  `mirror` (subscribe, then `keybindings_get`).
- **Terminal pass-through** (`terminal/keys.ts`): `PASS_THROUGH_COMMANDS` (toggle, palette second key, prev/next
  tab) use their effective bindings; an unregistered command (the pop-out window has no registry) falls back to
  its default key, so pop-outs behave as before.
- **New commands (16, no default keys):** `launch.start`, `launch.addFolder`, `worktree.modeNew`,
  `worktree.modeExisting`, `worktree.create`, `worktree.remove`, `worktree.forceRemove`,
  `worktree.discardAndRemove` (same delay gate as the button), `import.addSelected`, `terminal.returnToPane`,
  `terminal.focusWindow` (the placeholder's "Focus window", not in the spec's list but a pane-level button),
  `review.layoutSplit` / `review.layoutUnified` (registered **hidden**: the palette already has
  `review.toggleLayout` under the same titles, so visible ones would duplicate rows; still bindable),
  `review.backToCommits`, `review.dismissToast` (oldest), `approval.always` (oldest, where offered). 93 commands,
  79 visible.
- **Routing:** EdgePane Revoke/Retry/Restart, TerminalPane header (pane mode) and placeholder, ReviewPane
  mode/filter/layout/← Commits, Launch/Worktree/RemoveWorktree/Import buttons now run commands. Clicking an
  already-pressed Review mode button is now a no-op (its command's `when` requires another mode).
  In a pop-out window the header buttons still act directly (no registry there; allow-listed).
- **Audit** (`commands/audit.test.ts`): scans `src/components`, `src/canvas` and also `src/terminal` (`.tsx`),
  brace-matches each `onClick`/`onChange`/`onSubmit`, accepts `runCommand(`/`runCommandAsync(` (or a local
  function whose body calls it), else requires an allow-list entry (file + exact handler + reason). Stale entries
  fail; a self-test plants direct handlers; every id named in a `runCommand("…")` must be registered.
- **Rust:** `settings/keybindings.rs` (read, path beside settings.json, watcher in the new
  `AppState::keybindings_watcher` slot reusing `watch::start`, `keybindings://changed`), `ipc::keybindings_get`,
  `paths::KEYBINDINGS_FILE_NAME` / `keybindings_path_in`; `read_with_retry` made `pub(crate)`.
- **Docs:** README "Commands & keys" (count, new commands, `keybindings.json` section, id table, exemptions);
  DESIGN.md Settings → Diagnostics Keybindings list.
- **Test safety fix (pre-existing since Story 1.3):** binary detection's searches are injectable
  (`AppState::detect_searches`, else `settings::default_detect_searches()`): production keeps PATH +
  `~/.local/bin` for `claude` and PATH for `git`; under `cfg(test)` both are `Search::empty()`, so no test can
  locate or run a real `claude`. `initialise`, `redetect` (hence `binaries_redetect` and the watcher's reload) and
  `detect_all` go through it; `redetect_in` stays for explicit searches.
  `binaries_redetect_is_registered_and_resolves_both_binaries` now asserts both come back `missing`; new tests
  `the_test_default_detection_search_finds_nothing` and `redetect_uses_an_injected_search`. The full `cargo test`
  was run with the normal PATH while polling for new `claude` processes: none appeared.

- 2026-10-25 The GUI pass was not run. The foreground guard had just stopped the 9.2 re-run twice, so the machine was probably in use, and launching the app would steal focus. The vitest suite covers the overrides, the conflicts, the terminal pass-through, the audit and the Diagnostics rows. Writing a real `keybindings.json` and pressing the key is left to Emils.
- **Review fixes (round 1):** pass-through commands refuse a bare key (`<id> needs ctrl, alt or shift`) and
  the terminal clipboard keys (`ctrl+shift+c is the terminal's copy`); a pass-through binding also matches on its
  physical key (`codeOfKey`), so a rebound letter works on non-Latin layouts. Conflicts include an override onto a
  clipboard key (`…, terminal copy`) and are keyed as the file writes them (`escape`). Unbinding the palette keys
  or a hidden key-only command is a warning; a watcher that cannot start is `live reload unavailable: …`
  (`KeybindingsFile.watchError`). Entries for ids not registered yet wait and apply on registration (the store
  re-reports through `subscribeBindings`). Status reads `ok, n conflicts` (attention with errors or conflicts).
  The audit now also covers `onKeyDown`, `onDoubleClick`, `onContextMenu`, `…Capture` and `onX = {`, requires
  exactly one command call (or a local function running exactly one), and skips strings/templates/comments when
  matching brackets; the sheets' Enter routes through `launch.start` / `worktree.create` / `import.addSelected`.
  Sheet buttons derive `disabled` from `isCommandEnabled`; `inspectorButtons` / `headerButtons` are tested
  against their commands' `when`s, as are the Review toolbar's buttons. Rust: `production_detect_searches`
  (always compiled, unit-tested), `detect_all(state, …)`, watcher test polls instead of sleeping.

- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away). cargo test (600), clippy, tsc, vitest (675) and the debug build all pass; there was no GUI pass (machine probably in use).
  - **Safety fix made during this story:** since Story 1.3, the test `binaries_redetect_is_registered_and_resolves_both_binaries` and `settings::initialise` ran real binary detection, which could run the real `claude --version` from `~/.local/bin` during `cargo test`. Detection now takes its search from `AppState`. In `cfg(test)` that search is empty by default, and a full run with the normal PATH started no `claude` process.
  - **Linux CI is pending.**
  - **Emils:** check a real `keybindings.json` in the app.

## Spec Change Log

- 2026-10-25, review round 1 (blind-hunter noted deviations missing from the log). Orchestrator record, under Emils' standing authorisation:
  - **Elsewhere "Add folder".** It is allow-listed because the tray has no selection; this is the frozen "otherwise exempt" case.
  - **Audit scope.** The audit also scans `src/terminal`, where `TerminalPane.tsx` lives.
  - **`terminal.focusWindow`.** It was added as a pane-level button command.
  - **Mode buttons.** Clicking an already active Review mode button now does nothing, because its command's `when` requires a different mode. This is accepted.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V). Triaged by the orchestrator.

**Patch:**
- P1 (medium; B, E) Rebinding a terminal pass-through command (`terminal.toggle`, `palette.toggleFromTerminal`, `terminal.prevTab`, `terminal.nextTab`) has two problems:
  - A bare key is swallowed everywhere: xterm drops it, and the dispatcher skips bare keys in its textarea.
  - The terminal's copy and paste keys (`ctrl+shift+c`, `ctrl+shift+v`, `ctrl+v`) are silently taken over.

  Refuse both as errors, for example `terminal.toggle needs ctrl, alt or shift` and `ctrl+shift+c is the terminal's copy`. A rebound letter key must also pass through on non-Latin layouts: derive the `code` from the binding.
- P2 (low; B) Overrides onto other reserved keys are not reported. Report as conflicts any override onto the terminal's copy/paste keys, and any non-terminal override onto a pass-through key.
- P3 (low; B) The user can lock themselves out. Diagnostics warns when the file unbinds `palette.toggle`, `palette.toggleFromTerminal`, or a hidden command that has no other route (for example `palette.close`, `pane.close`).
- P4 (medium; B, E) The audit is too loose:
  - A handler that merely contains `runCommand(` passes, even beside direct work.
  - `onKeyDown`, `onDoubleClick`, `onContextMenu`, the `Capture` variants and `onClick = {` are not scanned.
  - Brace counting is confused by braces inside strings.

  Require each handler to be exactly a command call, or a local function that only runs one. Scan those events too, with allow-list entries where they are item-level. Skip strings and template literals when counting braces.
- P5 (medium; V, B, E) The ids in `REVIEW_MODE_COMMANDS`, `REVIEW_FILTER_COMMANDS` and `REVIEW_LAYOUT_COMMANDS` are never checked. Test that every value is registered and is the id for its own key.
- P6 (low; E) The sheets' Enter shortcuts (launch, worktree, import `onKeyDown`) call their actions directly. Route them through their commands.
- P7 (medium; V, B) Detection seams:
  - The production detection pair cannot be tested; move its composition into an always-compiled function and test it.
  - `detect_all` ignores the injected searches; use them.
  - Rename `binaries_redetect_is_registered_and_resolves_both_binaries` to match what it now asserts.
  - The watcher test waits with a fixed 100 ms sleep; poll for the change instead.
- P8 (low; B, E) If the keybindings watcher cannot start, live reload silently stops. Show `live reload unavailable: …` in Diagnostics.
- P9 (low; B, E) An override for a command registered after the file was applied is dropped. Keep unknown-id entries pending and apply them when the command registers.
- P10 (low; B) Diagnostics wording:
  - name keys the way the README does, e.g. `escape`;
  - the status reads `ok, n conflicts`, with attention, when there are conflicts;
  - use stable React keys.
- P11 (low; B) README and comments:
  - unbind example: use a command that has a default key;
  - fix the broken ``ctrl+` `` code span;
  - update the stale comments in `keybindings.ts` (`handleKeydown`, `layoutKey`);
  - note that the hidden layout carriers can be reached only once bound.
- P12 (low; B) Each button's `disabled` is computed separately from its command's `when`. Derive `disabled` from the command, or test that the two agree. Add store-level tests that each routed command's `when` holds whenever its button is shown (EdgePane, TerminalHeader, Review buttons).
- P13 (low; B) Cleanups: give `terminal.focusWindow`'s `when` a neutral name, and remove the redundant spread in `builtins.test.ts`.

**Reject:**
- (B) Duplicate keys in the JSON win by last occurrence: `JSON.parse` cannot report them without a custom parser, and that edge case is negligible.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator** (foreground-guarded, only when the screen is free):
  - write `keybindings.json` with an override, a conflict and a bad key;
  - check that the new key works;
  - check that Diagnostics lists the conflict and the error.
