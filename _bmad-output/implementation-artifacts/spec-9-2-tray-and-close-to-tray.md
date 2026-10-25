---
title: 'Story 9.2: Tray and close-to-tray'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1949fa60ae5ab47d0256a9256e28444dd0670217'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Closing the Switchboard window quits the app and kills every running session. Tidying the desktop therefore destroys work in progress. There is also no way to see at a glance, without the window, how many sessions are busy or waiting.

**Approach:**
- A tray icon shows the live counts and restores the window when clicked.
- With `close_to_tray` on, closing the window hides it to the tray, and sessions keep running.
- Quit (ctrl+q or the tray menu) still exits and stops sessions, as it does today.

**Decisions** (taken by the orchestrator under Emils' standing authorisation while he is away, recorded for his review):
- **Setting:** `close_to_tray`, a top-level boolean in `settings.json`, default `false` (close-to-tray is an option, not the default, per the planning docs; amended in review round 1). It reloads live, and the close handler reads it at close time.
- **Tray icon:**
  - **Presence.** It is shown whenever the app runs. It uses the app icon, and its tooltip reads `Switchboard — 2 busy · 1 waiting`, or `Switchboard — no live sessions`.
  - **Counts.** Busy means `busy` or `starting`. Waiting means `waiting` or `finished`, the 3.x "needs attention" states.
  - **Updates.** The counts update whenever the live map changes.
  - **Menu.** `Show Switchboard`, a disabled line with the counts, then `Quit`. The `Quit` entry exits like ctrl+q.
  - **Click.** A left click restores the window: unminimize, show, focus.
- **Closing the window:**
  - **With `close_to_tray` on:** the main window is hidden and sessions, terminals and pop-out windows keep running. The first hide in each app run shows one OS notification, `Switchboard is still running in the tray`, if notifications are allowed. A second launch (single-instance) also restores the hidden window.
  - **With it off:** closing quits, as today.
- **Linux closes to the taskbar.** On Linux, a hidden window may be unrecoverable: an indicator library can load with no tray host to show it. So close-to-tray there *minimizes* the window instead of hiding it. Sessions still keep running, and the window stays reachable from the taskbar (amended in review round 1).
- **No tray available.** If the tray cannot be created (some Linux desktops), closing always quits, because a window must never hide where it cannot be brought back. A banner says `tray unavailable: closing the window quits`.
- **Linux .deb.** It adds the appindicator runtime library (`libayatana-appindicator3-1`) to its dependencies.

## Boundaries & Constraints

**Always:**
- **Rust owns it.** The tray, the counts and the close logic live in Rust.
- **Quit stops sessions.** Quit still kills all sessions exactly as today.
- **Tests:** no `~/.claude` writes, and the real `claude` never runs.

**Never:**
- Starting at login, auto-update, or a confirm-on-quit dialog.
- Changing how Quit stops sessions.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Close, tray on | 2 busy sessions; click window close | window hidden (Windows) or minimized (Linux); sessions run; tray tooltip `Switchboard — 2 busy · 0 waiting` | first time: one notification |
| Restore | click tray icon | window shown and focused | — |
| Close, tray off | `close_to_tray:false` | app quits, sessions stopped | — |
| Quit from tray | tray menu Quit | app exits, sessions stopped | — |
| No tray | tray creation fails | close quits; banner | — |
| Counts change | a session goes waiting | tooltip updates | — |
| Second launch | app hidden; start again | hidden window restored | — |

</frozen-after-approval>

## Code Map

- `src-tauri/Cargo.toml` (:17): enable the tauri `tray-icon` feature. This is a feature flag, not a new crate.
- **New `src-tauri/src/tray.rs`:**
  - `TrayIconBuilder` with `app.default_window_icon()`, a menu (Show, a disabled counts line, Quit), and a left-click handler that calls `focus_main_window` (`lib.rs` :200-211).
  - A pure `counts(&LiveSnapshot) -> (busy, waiting)` and a tooltip text function, both tested.
  - Updating: hook `live.rs` `emit_live` (:1085-1101), or `listen_any(LIVE_EVENT)`.
  - Record whether the tray was created in `AppState`.
- **`lib.rs`:**
  - Add `on_window_event` for main's `CloseRequested`: if `close_to_tray` is on and the tray exists, call `api.prevent_close()` and `window.hide()`, and send the one-time notification through `notify.rs`.
  - Otherwise keep the current flow, and keep `on_run_event` (:105-119) as is.
  - Single-instance (:154-157) already calls `focus_main_window`.
- **`settings/mod.rs`:** `close_to_tray` (struct :50-69, default :71-87, test :711-730); TS type in `ipc/index.ts` (~:35); README settings row (:1492-1509).
- **Banner:** `tray.unavailable`, following the settings or detect banners.
- **`tauri.conf.json`:** `.deb` depends gains `libayatana-appindicator3-1`.
- **Docs:** README (tray, close behaviour, the setting) and DESIGN.md (the tray tooltip and menu text).

**Tests:**
- Pure counts and tooltip text.
- The settings default and parsing.
- The close decision as a pure function `(close_to_tray, tray_ok) -> Hide | Quit`.
- A lifecycle test with the mock app if `prevent_close` can be exercised there; otherwise rely on the pure decision.

## Tasks & Acceptance

**Execution:**
- [x] `Cargo.toml`, `tray.rs`, `lib.rs`, `settings/mod.rs`, `claude/live.rs` (hook), `tauri.conf.json` (+tests): the tray, counts, the close-to-tray logic, the setting and the banner.
- [x] `ipc/index.ts` (settings type) and any banner text in the UI (+vitest if touched).
- [x] `README.md` and `docs/DESIGN.md`.

**Acceptance Criteria:**
- Given close-to-tray on, when I close the window, then the sessions keep running, the tray tooltip shows the busy/waiting counts, and clicking the icon restores the window.
- Given close-to-tray off, or no tray, when I close the window, then the app quits as before.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass, and the debug build builds.

## Implementation Notes

- **Tray (`src-tauri/src/tray.rs`).** `tray::setup` runs in `setup` before `settings::initialise`, so a failure's `tray.unavailable` banner (new `SettingsState::tray_banner`, chained last) is in the first snapshot. The icon and its counts `MenuItem` are managed as `TrayParts<R>`; `AppState::tray` (`TrayState`) holds `ok`, the once-per-run `hinted` flag and the last counts pushed. Menu: Show Switchboard, the disabled counts line, a separator, Quit (`app.exit(0)`, the same path as `ipc::app_quit`, so `on_run_event` stops sessions unchanged). Left click (button up) calls `focus_main_window`; `show_menu_on_left_click(false)`.
- **Counts.** `counts()` returns a small `Counts { busy, waiting, live }` rather than a bare `(busy, waiting)`: `live` decides between `N busy · M waiting` and `no live sessions` (idle-only sessions read `0 busy · 0 waiting`). Exited sessions count nowhere.
- **Updates without deadlock.** `live::emit_live` calls `tray::on_live`, which runs under the live map's write lock. Tauri's `TrayIcon::set_tooltip` / `MenuItem::set_text` block until the main thread runs them, and sync IPC commands on the main thread can wait on that lock, so `on_live` only records the counts (skipping unchanged ones) and posts the update with the non-blocking `app.run_on_main_thread`.
- **Close.** `lib::on_window_event` (registered in `builder()`) handles main's `CloseRequested` via `tray::hide_on_close`: pure `close_action(close_to_tray, tray_ok)`; on `Hide` it calls `prevent_close`, hides the window and, the first time per run, sends `notify::on_hidden_to_tray` (title-only toast, no session id; `PluginNotifier` now omits an empty body and an empty `sessionId` extra). "If notifications are allowed" is left to the OS: on desktop the plugin reports permission granted, and a send failure is only logged. Pop-outs stay open while main is hidden.
- **Lifecycle test.** The mock runtime's `close()` removes the window without a `CloseRequested` event, so `prevent_close` cannot be exercised there; tests cover the pure decision plus `hide_on_close` on a mock app (hide + one toast across two closes; quit with the setting off or no tray).
- **Cargo.** The `tray-icon` feature needed no new crates: `tray-icon 0.25.1`, `muda` and `libappindicator` were already in `Cargo.lock`, which is unchanged; builds ran with `--offline` / `CARGO_NET_OFFLINE`.
- **Settings default.** Round 1: `close_to_tray` now defaults to `false` (the amended decision, in line with `epic-9-context.md`).
- **Round 1 fixes.**
  - Linux minimizes instead of hiding: `close_action(close_to_tray, tray_ok, linux) -> Hide | Minimize | Quit`.
  - Linux checks for the appindicator library before building the tray: `ldconfig -p`, then `LD_LIBRARY_PATH` and the usual lib folders. Absent → the tray is skipped and `tray.unavailable` is raised. The parsers are pure and tested; the Linux-only caller was not compiled here, because no Linux target is installed.
  - The close is prevented only when the main window exists and hiding or minimizing succeeded.
  - `hinted` is set only once the toast was really sent. The hint is gated on the new `notifications.tray` setting (default `true`) and the plugin's permission state.
  - A tap on a toast with no session calls `focus_main_window`.
  - The payload is built by the pure `notify::toast_extras`; the tray toast has no `sessionId`.
  - `on_live` and `apply` forget `last` on failure, so the next emit retries.
  - The window-state plugin saves `StateFlags::all() - VISIBLE` (`window_state_flags`).
  - The setup outcome is recorded by the pure `tray::record_setup`.
  - The close-label check is the pure `should_handle_close`.
  - New tests:
    - the counts through `live::apply_and_emit` (busy → waiting);
    - the hint retried after an unsent one;
    - no main window → no prevent;
    - `src/components/Banners.test.tsx`: an unknown banner id renders, via SSR with the settings store mocked.
- **Not done here:** the manual foreground-guarded check (stub `claude`, `WM_CLOSE`, second launch) was not run, by the environment's no-launch rule; Linux tray behaviour is unverified (CI suspended).

- 2026-10-25 GUI pass (orchestrator, debug build; `close_to_tray: true` set explicitly; stub session on `alpha`):
  - `WM_CLOSE` posted to the main window left the app process running and the window hidden (`visible=False`), and the stub session still running.
  - A second launch (single-instance) brought the hidden window back, `visible=True`, with the live session card `alpha-252b idle` shown.
  - ctrl+q then exited, with no app processes and no stubs left.
  - The tray tooltip text was not read on screen; the pure tooltip tests cover it.

- 2026-10-25 A GUI re-run after review round 1 was attempted twice, four minutes apart. Both times the foreground guard stopped it before any input, because another window was in front and the machine was probably in use. It was not retried. Round 1 changed:
  - the default, to `false` (the pass set it explicitly);
  - the Linux minimize branch (not testable here);
  - failure handling, and the hint's setting and click;
  - covered by the new unit and mock-app tests.
- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away):
  - cargo test (589), clippy, tsc, vitest (635) and the debug build all pass;
  - one GUI pass before round 1.

  **Still to check:**
  - Linux: not compiled or tested here; that includes the `cfg(linux)` library check, so CI is needed;
  - Emils: a GUI re-check (close with the setting on and off, clicking the tray icon, the hint), and the logoff and shutdown behaviour.

## Spec Change Log

- 2026-10-25, review round 1. **Orchestrator decisions, under Emils' standing authorisation while he is away (for his review):**
  - **Default `false`.** The default for `close_to_tray` is now `false`. My draft's `true` contradicted the planning docs (PRD FR-SYS-5 and the epic context: "an option, not the default"), which the implementer flagged.
  - **Linux minimizes.** On Linux, close-to-tray minimizes rather than hides. Both reviewers showed that libappindicator builds fine with no tray host to display it, so a hidden window could not be brought back.
  - **Matrix text.** The matrix tooltip text is corrected to the real `Switchboard — …` form.

  KEEP: Quit stops sessions exactly as before; the counts semantics; one hint per run; the tray menu.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V). Triaged by the orchestrator.

**Patch:**
- P1 (medium; decisions above) Change the default to `false`, and on Linux minimize instead of hide. Update the README, the defaults test and the epic context.
- P2 (high; E) On Linux, a missing appindicator library can panic inside `build`, and the release build aborts on panic. Before building on Linux, check for the library: `ldconfig -p` output for `libayatana-appindicator3` or `libappindicator3`, or the usual library paths. If it is absent, skip the tray and raise `tray.unavailable`.
- P3 (medium; B, E) A missing main window, or a failed `window.hide()`/minimize, still prevents the close, and the close button does nothing. Prevent the close only when hiding or minimizing succeeds. Skip the hint otherwise.
- P4 (low; B, E) The tray hint:
  - Set `hinted` only after the hint is actually sent.
  - Gate it on a new `notifications.tray` setting (default `true`) as well as OS permission.
  - Clicking it brings the window back through `focus_main_window` (toasts without a session id).
- P5 (low; B, E) If the dispatch or the tooltip update fails, `last` is already set and later updates are skipped. Clear `last` on failure so the next emit retries.
- P6 (low; B) Quitting while main is hidden could save the window state as invisible. Exclude `VISIBLE` from the window-state flags, or show the window before exiting. Test what is testable.
- P7 (low; V, B) Tests:
  - `on_live` reached through `apply_and_emit` with `tray.ok`, so `tray.last` follows busy, then waiting;
  - a pure `should_handle_close(label)`, where only `MAIN_WINDOW` counts, plus a pop-out case;
  - a pure `record_setup` for both branches (`ok` and the banner);
  - `PluginNotifier` payloads: session toasts keep `sessionId`, and the tray toast has none;
  - a frontend fixture where an unknown banner id (`tray.unavailable`) renders.

**Defer:**
- (low; V) The window's actual hidden state cannot be seen in the mock runtime. The manual GUI pass confirmed it (`visible=False`).
- (maybe-false, medium if real; E) An OS logoff or shutdown sending a close request might hide the window instead of exiting, so cleanup would not run. Settle with a logoff test on Windows and Linux (Emils).

**Reject:**
- (low; B) The tray icon's colour variants per platform: it uses the app icon. Its legibility will be checked during Emils' manual checks.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator, foreground-guarded, stub `claude`:**
  - start a stub session;
  - close the window with its close button, or `WM_CLOSE` sent to the window handle;
  - check the process still runs and the stub still runs, and the window is hidden;
  - read the tray tooltip if possible; otherwise check by restoring through a second launch (single-instance);
  - Quit.
