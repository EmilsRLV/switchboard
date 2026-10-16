---
title: 'Story 1.4: Single instance, window state, palette skeleton'
type: 'feature'
created: '2026-10-16'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '7855a054d5ea16790978e685a1bb5f74a6f624ba'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Launching the app twice opens two windows, the window forgets its size and place, and the only way to reach any action is a hard-coded shortcut. The PRD's rule "every action is a registered command reachable from `ctrl+k`" has no backbone yet, and Epic 2's context menus and Epic 9's keybinding audit need one.

**Approach:** Three small pieces. (1) `tauri-plugin-single-instance`: a second launch focuses and un-minimises the existing window and exits. (2) `tauri-plugin-window-state`: size, position and maximised state are saved on change and restored on launch. (3) A **command registry** on the frontend — `{ id, title, keybinding?, when?, run }` — that owns all keyboard shortcuts through one dispatcher, plus a **palette** (`ctrl+k`) that lists the commands whose `when` holds, filters as you type, runs on Enter, closes on Esc. Initial commands: Open settings (`ctrl+,`), Reveal settings file, Re-detect binaries, Toggle palette (`ctrl+k`), Quit (`ctrl+q`, via a thin `app_quit` Rust command).

**Decisions (recorded):** single-instance plugin is registered **first** (its docs require it) and only focuses — the forwarded argv/cwd are logged, not acted on, until Epic 2 adds "open project from CLI"; window-state plugin with default flags, its file lives in Tauri's identifier dir (`%APPDATA%\dev.switchboard.app\.window-state.json`, `~/.config/dev.switchboard.app/` on Linux) — accepted and documented rather than hand-rolling persistence; the registry is a plain module (`Map<string, Command>`) with a Zustand store only for palette UI state; keybinding strings are `ctrl+`/`shift+`/`alt+` + key, parsed once at registration, matched on `keydown` with `event.repeat` ignored; Esc precedence is palette → pane; matching is case-insensitive substring over `title` and `id`, ordered by title; the palette is the first element of Story 2.5's visual system and uses tokens only; no mouse-only affordances are added (the palette is also clickable, but nothing requires the mouse).

## Boundaries & Constraints

**Always:** All existing shortcuts (`ctrl+,`, Esc) migrate into the registry — no second keydown listener outside the dispatcher. Commands with a `when` that returns false are hidden from the palette and ignored by the dispatcher. Registration is idempotent per id (re-registering replaces; duplicate ids in one build are a test failure). `app_quit` is the only new Rust command. The mock-runtime IPC tests still build the app with the same `with_commands`.

**Never:** No menu bar, no tray (9.2), no keybinding editor or `keybindings.json` (9.4), no command history/recents, no fuzzy-scoring library, no new npm dependency. Do not touch settings persistence. Do not act on the second instance's arguments.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Second launch | app running, `switchboard.exe` started again | first window focused + un-minimised; second process exits before showing a window | — |
| Window state | move/resize/maximise, close, relaunch | same size, position and maximised state | off-screen saved position → plugin clamps to a visible monitor |
| `ctrl+k` | any state | palette opens with the input focused, listing enabled commands sorted by title | — |
| Filter | type `set` | list narrows to titles/ids containing "set" (case-insensitive); first row selected; ↑/↓ move; Enter runs the selected command and closes | no match → "No matching commands" row, Enter does nothing |
| Esc | palette open; else pane open | closes the palette only; a second Esc closes the pane | — |
| `ctrl+,` | pane closed / open | toggles the settings pane (through the registry) | — |
| `ctrl+q` | any | app exits via `app_quit` | — |
| `when` false | a command whose `when` is false (e.g. "Reveal settings file" with no path) | absent from the palette; its keybinding does nothing | — |
| Held key | `ctrl+k` auto-repeat | one toggle | — |

</frozen-after-approval>

## Code Map

- `src-tauri/src/lib.rs:24-31` -- `builder()`: add `.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| { … focus main … }))` **before** `opener`, and `.plugin(tauri_plugin_window_state::Builder::new().build())`; `with_commands` gains `ipc::app_quit`.
- `src-tauri/src/ipc/mod.rs` -- command pattern (`settings_get` etc.); add `app_quit(app: AppHandle<R>)` → `app.exit(0)`. Wire-name test pattern in `lib.rs::tests` (`invoke()` helper) — `app_quit` must **not** be invoked in tests (it exits the process); assert registration by checking it is in the handler list indirectly (a `tauri::ipc` call returning the not-found error for a misspelt name vs. ok for a dry-run flag is not available) → add `#[cfg(test)]` guard: `app_quit` calls `app.exit(0)` only when `!cfg!(test)`, and the test invokes it expecting `Ok`.
- `src-tauri/Cargo.toml` -- add `tauri-plugin-single-instance = "2"` (2.5.4), `tauri-plugin-window-state = "2"` (2.5.0). No JS packages needed (both plugins are Rust-side only here). `capabilities/default.json` unchanged.
- `src/App.tsx:80-94` -- the ad-hoc keydown handler to delete; replace with `useKeybindings()` from the dispatcher. `App.tsx:96-115` -- render `<Palette/>` beside `<SettingsPane/>`.
- `src/state/settings.ts` -- `togglePane`/`closePane`/`paneOpen` used by commands and Esc precedence; `snapshot.path` drives the `when` of "Reveal settings file".
- `src/ipc/index.ts` -- `Commands` map + `call()`; add `app_quit: void` and `appQuit()`; existing `settingsReveal`, `binariesRedetect`.
- `src/components/SettingsPane.tsx:17-29` -- Reveal/Re-detect handlers to reuse from commands (extract to `src/commands/settings.ts`).
- `src/components/shell.css` -- `.pane`, `.btn`, tokens usage to mirror for `.palette`.
- `vite.config.ts` -- vitest `include: src/**/*.test.{ts,tsx}`, node env: registry/dispatcher/store tests are pure TS.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/ipc/mod.rs` -- plugins + `app_quit` (+ test-mode guard and wire-name test) -- Rust side
- [x] `src/commands/registry.ts`, `src/commands/registry.test.ts` -- `Command` type, `registerCommand`, `unregisterCommand`, `getCommand`, `listCommands({ enabledOnly })`, `runCommand(id)`; duplicate-id detection; tests -- the backbone
- [x] `src/commands/keybindings.ts`, `src/commands/keybindings.test.ts` -- `parseKeybinding("ctrl+shift+k")`, `matchesEvent(binding, event)`, `useKeybindings()` hook installing one `keydown` listener that resolves bindings → enabled command → `run`, with Esc precedence handled by the `palette.close`/`settings.closePane` commands' `when`; tests with synthetic events -- the dispatcher
- [x] `src/state/palette.ts`, `src/state/palette.test.ts` -- `{ open, query, selected, open(), close(), toggle(), setQuery(), move(±1), filtered(commands) }`; tests for filtering, selection clamping, reset on open -- UI state
- [x] `src/commands/builtins.ts` -- registers `palette.toggle` (ctrl+k), `palette.close` (Escape, when open), `settings.open` (ctrl+,), `settings.closePane` (Escape, when pane open and palette closed), `settings.reveal` (when path), `binaries.redetect`, `app.quit` (ctrl+q) -- the first commands
- [x] `src/components/Palette.tsx`, `src/components/shell.css` -- centred overlay, input + list, keyboard-driven, tokens only, `role="dialog"` + `aria-activedescendant` -- the UI
- [x] `src/App.tsx`, `src/components/SettingsPane.tsx` -- delete the ad-hoc handler, mount `useKeybindings()` + `<Palette/>`, pane buttons call `runCommand` -- integration
- [x] `README.md` -- "Commands & keys" section (ctrl+k, ctrl+,, ctrl+q, Esc precedence), single-instance note, window-state file location -- docs

**Acceptance Criteria:**
- Given the app running, when I launch it again, then the first window is focused and no second window appears (checked by process count and `MainWindowHandle`).
- Given I resize/move/maximise the window and relaunch, then it reopens with the same bounds and state.
- Given `ctrl+k`, when I type `qu` and press Enter, then the app quits; when I type `set` and press Enter, then the settings pane opens; Esc with both open closes the palette first, then the pane.
- Given `npm test` and `cargo test`, then registry, keybinding and palette-store tests pass alongside the existing suites.

## Implementation Notes

- Implementer (2026-10-16): plugins registered single-instance → window-state → opener; `app_quit` skips `app.exit` under `cfg(test)` so its wire name is testable; registry is a module `Map`, palette UI state in `state/palette.ts`; seven built-ins (the two Escape-carriers `palette.close` / `settings.closePane` give Esc its precedence through mutually exclusive `when`s); `registerCommands` batch API added for duplicate-id detection; `actionBusy`/`actionError` moved to the settings store so pane buttons and palette share outcomes. Verified: cargo 74, vitest 74, tsc clean, debug build; manual run on the debug exe: second launch → 1 process, first un-minimised and focused; window restored at 120,90 1010×640; `ctrl+k` `qu` Enter and `ctrl+q` both exited the process.
- Orchestrator (2026-10-16): independent Win32-level check — second launch: 1 process, second exited, first un-minimised; window moved to 120,90 1000×700, closed, relaunched at exactly 120,90 1000×700; `.window-state.json` written. The palette/Esc/`ctrl+q` keyboard pass was **invalid**: a game held the foreground, `SetForegroundWindow` was refused and every keystroke went to the game; those rows rest on the implementer's run plus the dispatcher tests until the operator frees the screen for a re-run.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-16) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- BH3 / EC3 `settings.open` runs `togglePane`; picking "Open settings" with the pane open closes it, against the AC — **medium**: patch — open-only command; a hidden `settings.toggle` carries `ctrl+,`.
- BH5 / EC10 action errors from palette-run commands are invisible with the pane closed and persist in the store after close — **medium**: patch — open the pane on failure; `closePane` clears `actionError`.
- EC1 `ctrl+,` while the palette is open mounts the pane, which steals focus from the palette input — **medium**: patch — the pane's focus effect yields while the palette is open.
- VG1 Quit chain never exercised past the wire name — **medium** (pre-verified): patch — JS test that `runCommand("app.quit")` reaches `app_quit` (NoTauriRuntimeError message); Rust half **rejected** as untestable: `MockRuntime::request_exit` is `unimplemented!()`; `ctrl+q` stays a manual check.
- VG2 `redetectBinaries` success path and busy guard untested — **medium** (pre-verified): patch — `settings.test.ts` with `vi.mock("../ipc")`.
- BH7 / EC4 `binaries.redetect` runnable while busy from the palette — **low**: patch — `when: !actionBusy`.
- EC5 `registerCommands` half-registers when a later binding fails to parse — **low**: patch — parse all before `set`.
- EC6 `move` adds to a stale `selected` after the row count shrank — **low**: patch — clamp before adding.
- EC7 `settings.reveal` can run twice concurrently — **low**: patch — busy guard.
- EC8 `is_minimized()` Err skips `unminimize` — **low**: patch — `unwrap_or(true)`.
- BH6 dispatcher fires for bare-key bindings while typing in an input (none exist yet) — **low**: patch — skip modifier-less, non-Escape bindings when `event.target` is editable; documented.
- VG-o / EC2 pane Close button is a no-op while the palette is open; palette has no focus trap — **low**: patch — Tab stays in the palette input.
- BH2 the two Escape-carrier commands clutter the palette; README says five — **low**: patch — `hidden?: true` honoured by the palette only; README lists the five visible ones.
- BH1 / EC9 README (and the frozen matrix) say the plugin "clamps" an off-screen position; `restore_state` only applies the position when a monitor intersects it, else the OS places the window — **low** (verified in plugin source by two layers): patch README; the frozen row's wording stands as written and is noted here as inaccurate.
- BH4 "arguments are logged" is false in release Windows builds (`windows_subsystem` detaches stderr) — **low**: patch — README/doc wording "ignored (stderr in debug builds)".
- BH10 one-way key aliases (`ctrl+up` renders `ctrl+arrowup`); layout/shift+punctuation limitation undocumented — **low**: patch — reverse aliases in `formatKeybinding`, one-line note.
- BH12 no `:hover` on rows, `outline: none` on the input without a replacement — **low**: patch — hover rule; keep the dialog border as the focus cue with a comment.
- BH8 / VG3 `Palette.tsx` / `useKeybindings` untested (no DOM env) — **low**: rejected for the DOM part (same call as Stories 1.1/1.3); patch the cheap part — extract the palette input key→action mapping to a pure function with tests.
- BH11 / VG4 plugin wiring and `focus_main_window` untested — **low**: rejected; needs a real OS window and a second process (verified manually by both implementer and orchestrator); patch only the no-`main`-window early return test.
- BH9 spec not updated by the diff — **low**: resolved by the orchestrator (tasks ticked, notes above).

## Verification

**Commands:**
- `cd src-tauri; cargo test` -- expected: all pass incl. `app_quit` wire-name test
- `npm test` -- expected: new registry/keybindings/palette tests pass with the existing 18
- `npx tsc --noEmit` -- expected: clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Launch the debug exe twice: one window, focused. Move/resize, close, relaunch: restored. `ctrl+k` → type → Enter → action. Esc precedence. `ctrl+q` quits.
