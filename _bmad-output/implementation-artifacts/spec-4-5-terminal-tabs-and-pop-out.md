---
title: 'Story 4.5: Terminal tabs and pop-out'
type: 'feature'
created: '2026-10-18'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '3473838462cd47e8271f475890c961f342c87e9d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-pty-terminal-pane.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The terminal pane shows one terminal at a time, and switching means going back to the canvas for "Show terminal". Two sessions can't be watched side by side.

**Approach:**
- **Tabs.** The pane gets a tab strip: every terminal opened in it becomes a tab, and switching tabs is instant because the views already live on.
- **Pop out.** Any tab can be popped out into its own OS window, which reads the same PTY stream with no restart. Closing that window returns the terminal to its tab.

**Decisions:**
- **Tabs:**
  - **Opening.** `ui` keeps `openTerminals: string[]` (tab order) next to `activeTerminal`. Opening or showing a terminal adds a tab at the end if it is missing, then activates it.
  - **Tab content.** Each tab shows the terminal's title, its state word (muted), and the Story 3.3 attention dot (the existing `.session-attention` class) for a `waiting`/`finished` session.
  - **Close (×).** It removes the tab only: the process keeps running and can be reopened from the node or the palette. On an exited session terminal, × also closes the terminal (`term_close`), as the header's Close does. When a terminal is killed by Rust (project removed), its tab goes.
  - **Overflow.** The strip scrolls sideways.
- **Selection follows.** While the terminal pane is open, selecting a session node that has a Switchboard terminal switches to its tab, adding the tab if needed. Focus stays on the canvas. Selecting a project whose plain terminal is open does the same. With the pane closed, selecting changes nothing.
- **Keys:**
  - **Moving between tabs.** `ctrl+pageup` / `ctrl+pagedown` move to the previous / next tab. They work from inside a terminal too: the Story 4.1 rule that only `` ctrl+` `` and `ctrl+shift+k` leave a focused terminal gains these two (matched on `event.code` too).
  - **Closing a tab.** There is no key for it; use the × button.
- **Pop out:**
  - **The command.** `terminal.popOut` ("Pop out terminal") is offered for the active terminal when it is not already popped out. It is a header button and a palette command.
  - **The window.** Rust opens a `WebviewWindow` labelled `term-<n>` (a counter), titled `<terminal title> — Switchboard terminal`, 900 × 600, resizable, loading the app at `index.html?terminal=<id>`.
  - **Permissions.** A new capability covers `term-*` windows with `core:default`.
  - **Tracking.** Rust keeps `popped: id → window label` and emits `term://popped { id, label | null }`.
  - **One at a time.** A terminal can be in at most one pop-out. Popping out an already popped terminal focuses its window.
- **Pop-out window:**
  - **What it renders.** The app renders only the terminal: a header with the title, state, Restart / Close / Kill as in the pane, and "Return to pane", then the xterm view filling the window.
  - **Its own view.** It builds its own view, replaying `term_buffer` with the 4.1 offset de-duplication, then following `term://data` for that id only.
  - **Input and size.** Input goes through `term_write`. The pop-out owns the PTY size while it is open, and the main window's view sends no `term_resize` for that id.
  - **Keys.** Inside the pop-out only copy and paste work (as in 4.1). No canvas commands.
- **Main window while popped out:**
  - **The tab** stays and is marked `↗` (popped out).
  - **The pane** shows a placeholder: "In its own window", with "Focus window" and "Return to pane" buttons.
  - **Output** keeps being written to the main view while popped, so returning is instant and complete.
- **Returning.**
  - **What returns it.** Closing the pop-out window by any means, or "Return to pane" in either window, closes the window and clears `popped`.
  - **Back in the pane.** The tab shows the live view again and refits, which sends one `term_resize` for the pane's size.
  - **Process exit.** If the terminal's process exits while popped out, the pop-out stays and shows `exited N`.
- **Quit.** App exit closes the pop-out windows, and terminals are killed as in 4.1. Closing the main window behaves as it does today, and pop-outs stay open while the app runs.
- **Look.** Tokens only. Tabs are not buttons with borders: they use the plain text style, with the active tab underlined in `--border-strong`. There is no new motion. DESIGN.md gets a "Terminal tabs and pop-outs" section.

## Boundaries & Constraints

**Always:**
- **Rust owns windows.** Rust creates and tracks pop-out windows, and the frontend asks through commands.
- **One PTY.** A terminal has one PTY whatever the windows. A pop-out never spawns anything.
- **No output lost.** Nothing is lost on tab switch, pop-out or return.
- **Nothing under `~/.claude`.**
- **CI.** Both runners stay green, with the design lint passing.

**Never:**
- Splitting the pane or showing two terminals side by side within the main window.
- Dragging tabs to reorder them.
- Persisting tabs or pop-outs across app restarts.
- Docking a pop-out back by dragging.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Two sessions | open `A` then `B` | tabs `A`, `B`; `B` active | — |
| Switch | click tab `A` | `A` shown at once with all output; `B` keeps writing hidden | — |
| Select node | pane open; select session `A` on canvas | tab `A` active; focus stays on canvas | — |
| Keys | focus in `B`'s terminal; ctrl+pageup | tab `A` active | — |
| Close tab | × on running `A` | tab gone, process runs; Show terminal brings it back | — |
| Pop out | Pop out `B` | new window with `B`'s full output, typing works; main tab `B` shows placeholder | window creation fails → notice, tab unchanged |
| Popped twice | Pop out `B` again | the existing window is focused | — |
| Return | close `B`'s window | tab `B` shows live view, refits | — |
| Exit while popped | `B` exits | pop-out shows `exited N` | — |
| Quit | pop-outs open | windows close, no process remains | — |

</frozen-after-approval>

## Code Map

- **`src/state/ui.ts`:** `openTerminals`, plus `openTab(id)`, `closeTab(id)`, `nextTab(delta)` and `poppedOut: Record<id, label>`. Pure tests.
- **`src/terminal/TerminalPane.tsx`:** the tab strip, the placeholder for a popped-out tab, and the Pop out button.
- **New `src/terminal/TerminalWindow.tsx`:** the pop-out root.
- **`src/main.tsx` / `src/App.tsx`:** choose the root from `?terminal=`, using a pure `windowMode(search)` (+test).
- **`src/terminal/registry.ts`:**
  - `connectTerminals({ only?: id })` for the pop-out.
  - `syncSize` skips ids that are popped out (main window).
  - `popOut` / `returnToPane` wrappers.
- **`src/commands/terminal.ts`, `builtins.ts`, `keybindings.ts`, `src/terminal/keys.ts` (+tests):** `terminal.popOut`, `terminal.nextTab`, `terminal.prevTab`, the extended in-terminal pass-through set, and the select-follows-tab rule (in the selection store subscriber or the `select` action).
- **`src/ipc/index.ts` (+test):** `termPopOut`, `termReturn`, `onTermPopped`.
- **`src-tauri/src/pty/` or a new `src-tauri/src/windows.rs`:**
  - `term_pop_out { id }` builds the window, records the label, emits, and hooks `WindowEvent::Destroyed` to clear the record and emit.
  - `term_return { id }` closes the window.
  - Closing all pop-outs on exit.
  - Tests with the mock runtime where possible (the label counter, the popped map, the events).
- **`src-tauri/capabilities/terminal-window.json` (new):** `windows: ["term-*"]`, `core:default`.
- **Docs:** `README.md` gets a "Tabs and pop-outs" section. `docs/DESIGN.md` gets the tabs section.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/windows.rs` (or `pty/`), `lib.rs`, `capabilities/terminal-window.json` (+tests) -- pop-out windows tracked by Rust -- windows
- [x] `src/state/ui.ts`, `src/terminal/registry.ts`, `src/ipc/index.ts` (+tests) -- tab state, size ownership, pop-out IPC -- state
- [x] `src/terminal/TerminalPane.tsx`, `src/terminal/TerminalWindow.tsx`, `src/main.tsx`, `src/App.tsx`, `src/components/shell.css` -- tab strip, placeholder, pop-out root -- UI
- [x] `src/commands/terminal.ts`, `builtins.ts`, `keybindings.ts`, `src/terminal/keys.ts` (+tests) -- commands, keys, select-follows-tab -- commands
- [x] `README.md`, `docs/DESIGN.md` -- docs

**Acceptance Criteria:**
- Given two live sessions, when I select each (pane open), then both terminals are tabs in the pane, switching is instant, and neither loses output.
- Given "Pop out", when chosen, then a new OS window hosts that terminal with its full output and live input; closing it returns the tab to the pane.
- Given `cargo test`, `clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- 2026-10-18 (dev). Decisions and deviations while building:
  - **Rust `src-tauri/src/windows.rs`:** `PopOuts` (in `AppState.popouts`) holds `next` (the label counter, never reused in a run) and `popped: id → label`. `claim` reserves a fresh `term-<n>` before the window is built, so two quick Pop outs of one terminal never build two windows; a failed build releases it and replies `could not open the terminal window: <cause>` (the notice; the tab is unchanged). An `Existing` record whose window is gone is dropped and a new window built.
  - **Window URL:** `WebviewUrl::App("index.html?terminal=<id>")`, the id percent-encoded (a session id has a `:`). Tauri joins it onto the app URL, so the query survives in dev and in a build. The window is also `theme(Dark)` with the `--bg` background, like `main`.
  - **Destroyed:** handled in `on_run_event` (`RunEvent::WindowEvent { Destroyed }`), not a per-window hook: `term-*` → `window_destroyed` clears the record (only while it still names that label) and emits `{ id, label: null }`. **`main` destroyed → `close_all`**, so closing the main window still quits the app (the last window goes) as before, taking the pop-outs with it. `ExitRequested` also runs `close_all` before `kill_all`.
  - **`term_return`** clears the record and emits at once, then `destroy()`s the window (its later Destroyed finds nothing). Returning a terminal that is not popped is a no-op.
  - **Extra wire, additive:** `term_popped` (the current map, so a reloaded main window does not resize a popped terminal); `term://info { TermInfo }` emitted by `term_restart` (a Restart in the pop-out reaches the pane's store); `term://closed { id }` emitted by `term_close` (a Close in the pop-out drops the pane's tab/view/info). `term_close` and `workspace_remove_project` also close the terminal's pop-out.
  - **Window-state plugin:** `with_filter(!is_popout_label)`, so pop-outs always open at 900 × 600 and no `term-<n>` state is saved.
  - **Frontend state:** `ui.openTerminals`, `poppedOut`, and `focusOnShow` (false only when a canvas selection switched the tab, so focus stays on the canvas). `setActiveTerminal(id)` now opens a tab; `null` only clears the active tab. Pure helpers `withTab`, `withoutTab` (a closed active tab hands over to its right neighbour, else its left), `stepTab` (wraps). With no tab left, the pane is put away.
  - **Select-follows-tab** lives in the existing `useUiStore.subscribe` selection branch (`followSelection` / `terminalOfTarget`).
  - **Tab state word:** a running session terminal shows its session's own word (`busy`, `idle`, `waiting`, …) with the dot for `waiting` / `finished`; otherwise the header's word (`running`, `stopping`, `exited N`, error). Pure `tabState` in `state/terminals.ts` (+test). The dot is static (no new motion); its accent comes through `.session-attention.terminal-tab-dot`, inside the allow-list.
  - **New token `--border-strong`** = `var(--fg-muted)` (the spec names it; it did not exist). Added to `tokens.css` and DESIGN.md's token table.
  - **× on a popped-out tab** removes the tab only; the pop-out stays open (returning it later does not re-add the tab).
  - **Size ownership:** `syncSize` skips a popped id in the main window; `applyPopped(id, label)` also clears the view's last sent size, so the refit on return always sends one `term_resize` for the pane even when the pane's size did not change. The pop-out window's registry runs with `connectTerminals({ only })`: every event of another id is ignored, it never subscribes to `term://popped`, and its view (made by the window's first layout, before the list arrives) still replays `term_buffer` with the 4.1 offset de-duplication.
  - **Resume over a popped exited session terminal** returns it to the pane first (the pop-out would show the earlier run with stale offsets).
  - **Pop-out keys:** no dispatcher is installed there; xterm's handler still swallows the pass-through keys (they do nothing), copy / paste work as in 4.1.
  - **Tests:** Rust `windows::tests` (claim/release/labels/URL/title) and `pop_out_windows_are_counted_tracked_focused_returned_and_closed_on_quit` in `lib.rs` on the mock runtime (unknown terminal, `term-1`, the `?terminal=` URL, refocus without a second window, destroyed → `null` once, return, main-destroyed and quit close all, the fixture shell's pid unchanged and dead after exit). The mock runtime keeps no window title and never runs its event loop, so the title is tested through `window_title` and Destroyed through `on_window_destroyed`. Frontend: `ui.test.ts` (tab helpers, store, select-follows), `terminal.test.ts` (two tabs, tab keys from inside a terminal, × running vs exited, pop out failure/success/return, closed elsewhere), `registry.test.ts` (no resize while popped, one on return, `only` filtering + replay, reload picks up popped), `keys.test.ts`, `windowMode.test.ts`, `terminals.test.ts`, `ipc/index.test.ts`.
  - **Not verified here:** the GUI (real windows, focus, Destroyed from the OS close button, `ExitRequested` destroying pop-outs on a real event loop, the window title), the Linux build, and `npm run tauri build` (a `vite build` to a temp dir succeeded). Left for the foreground-guarded manual checks above.

- 2026-10-18 GUI pass 1 (orchestrator, plain PowerShell terminals, no claude): two plain terminals became the tabs `ide running ×` and `tmp running ×`; ctrl+PageUp switched to `ide` at once with its output intact. Pop out opened "tmp — Switchboard terminal" with the full history, and typing `echo POPPED` there worked; the main tab showed `tmp running ↗`. **Alt+F4 sent to the pop-out did not close it**: with focus in the terminal, xterm consumes the key and prevents the default, so WebView2 never closes the window. The main window likely has the same problem since 4.1.

- 2026-10-18, review patch round 1 (P1–P18). These decisions add to or change the notes above:
  - **P1 Alt+F4:** `terminalKeyAction` has a new `"window"` action for Alt+F4 (no ctrl, shift or meta). `handleKey` returns false for it without `preventDefault`, so xterm stays out and the webview closes the window. The dispatcher has no binding for it, so it never prevents the default either. This applies in the main window and in pop-outs.
  - **P2 Pop-out race:** `PopOuts` gains `building`, a set of labels claimed but not built yet. A second `term_pop_out` checks `is_building` before looking the window up and answers with that label. A build that finishes in between has already registered the window, so the lookup finds it. `finish_build` runs after `build()` whether it succeeded or failed.
  - **P3 Query replies:** while a terminal is popped out, the main window's view drops its `onData` (`only === null && isPoppedOut(id)`), so DSR / DA answers come from the pop-out alone.
  - **P4 Restart reset:** `term://info` resets a view whose info goes from exited to running, unless this window is the one restarting it. `restartTerminal` marks the id with `markRestarting` for the duration of the call, so the restarting window's own event cannot wipe the new shell's first output.
  - **P5 Pane header while popped out:** only the title, the state and Hide remain. Hide is kept because it is the pane's own action.
  - **P6 Reply ordering:** `term://popped` events are counted per id (`applyPoppedEvent` / `poppedSequence`). The `term_pop_out` and `term_return` replies are applied only if no event for that id arrived while they were in flight.
  - **P7 Return:**
    - A return in the main window (`applyPopped(id, null)` when the terminal was popped) resizes the main xterm and the PTY at once, whether or not its tab shows.
    - The size is the last size the pane fitted (`paneSize`, recorded by `syncSize` in the main window), else the view's own.
    - It then calls `restore(id)`: a reset and a `term_buffer` replay, with the 4.1 offsets and replies suppressed.
    - A second null (the reply after the event) does nothing, because the terminal is no longer popped.
    - `forgetTerminal` disposes the view first, so a forgotten terminal is never replayed.
  - **P8:** × on an exited session tab awaits `closeTerminal`. On a refusal the tab stays and the notice shows.
  - **P9:** `TerminalWindow` renders `Notice`, and `.terminal-window` is `position: relative` so the notice sits over its top edge.
  - **P10:** the tab strip is a `<nav aria-label="Terminal tabs">`. Each tab is a plain button with `aria-current="true"` on the active one, followed by a separate × button labelled "Close tab <title>". The tablist and tab roles are gone.
  - **P11 Resume over a pop-out:**
    - The frontend awaits `returnToPane` only after `session_resume` succeeded. A refusal leaves the pop-out as it is.
    - **Rust also returns it to the pane** in the launch path, right after `open_session` succeeds and before the new run's first output event, which comes at least 8 ms later.
    - Without that, the new run's conhost `ESC[6n` would land on the pop-out's stale view, whose offsets belong to the old run, while P3 keeps the main view silent. Nobody would answer it.
    - The frontend's call then finds nothing to return and is a no-op.
  - **P12:** `windows::BACKGROUND` = `--bg-raised` (`#161920`). The test `the_background_is_the_bg_raised_token` reads `../src/theme/tokens.css` and compares.
  - **P13 Title:** `windows::retitle` sets a pop-out's native title from the terminal's info title, after `term_restart`. A resumed terminal's pop-out is returned to the pane (P11), so it has no window to retitle.
  - **P14:** in a pop-out (`only` set), `handleKey` gives the pass-through keys (``ctrl+` ``, `ctrl+shift+k`, `ctrl+pageup` / `ctrl+pagedown`) to the terminal.
  - **P15:** `canPopOut` also requires `pane === "terminal"`.
  - **P16:** `min_inner_size(480, 320)`.
  - **P17 Tests:**
    - **Rust:** `pop_out_edges_failed_builds_stale_records_restart_close_and_project_removal` covers:
      - the building marker;
      - a failed build (label taken), which records nothing and emits nothing;
      - a stale `Existing` record, which emits null and builds a new window;
      - `term_restart` emitting `term://info`;
      - project removal emitting popped null;
      - `term_close` on a popped exited session terminal emitting closed and popped null and dropping the record.

      The session terminal is opened with `open_session` on a `cmd /c exit 0` / `sh -c "exit 0"` fixture and killed. That is needed because on Windows conhost holds it until its cursor query is answered. The mock runtime never runs its loop, so the window's destruction itself is not observable.
    - **Frontend:** live popped / null events with `syncSize` and the replay; no input while popped; `term://info` reset rules; `term://closed`; `only` filtering of info and closed; Alt+F4 in both modes; the pass-through keys in a pop-out; the stale reply; × with a refused close; `canPopOut` needing the pane; resume ordering, and a refused resume.
    - **Test harness:** `registry.test`'s `load()` now resets `termPopped` / `termList`, because mock implementations outlive `resetModules`.
  - **P18:** README and DESIGN describe all of the above: the header while popped out, Alt+F4, the size and minimum, the tab buttons, the notice in the pop-out, the return redraw and resume.
  - **Not verified here:** everything GUI, as before. In particular Alt+F4 in a real WebView2, closing with the OS close button, and the return redraw in a real window.

- 2026-10-18 GUI pass 2 after the patch round (orchestrator, plain PowerShell terminals): two tabs, and ctrl+PageUp switched between them. The pop-out showed the full history and accepted input, and the main tab showed `↗` with a header of only the state and Hide. **Alt+F4 closed the pop-out**, and the tab came back with all output, including `echo POPPED` typed in the pop-out. Typing `echo BACK-IN-PANE` in the pane worked. A second pop-out closed with its title-bar × returned the same way.

## Spec Change Log

- 2026-10-18 (review round 1, orchestrator): clarification, no change of intent. Closing the main window already quits the app, so its pop-outs close with it. The frozen "pop-outs stay open while the app runs" therefore holds: they only close because the app stops running.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap, plus the orchestrator's GUI pass 1):

**Patch:**
- P1 Alt+F4 (GUI pass): with focus in a terminal, Alt+F4 must close the window, in the main window and in pop-outs. `handleKey` lets it through without xterm handling it or preventing the default. Test.
- P2 Pop-out race: `Inner` keeps a "building" marker. A second `term_pop_out` for an id whose window is still being built returns that label, and never releases it and builds a second window. Test.
- P3 Only the size owner answers: while a terminal is popped out, the main window's hidden view never sends `term_write`, so terminal query replies (DSR, DA) come from the pop-out alone. Test.
- P4 Restart in either window resets the other window's view: on `term://info` where a known info goes from exited to running, call `resetView`. Test.
- P5 The pane while popped out shows only the placeholder with Focus window and Return to pane. The pane header loses Restart, Close, Kill and Pop out for that id.
- P6 Popped state follows the events: the `term_pop_out` reply is applied only if no newer `term://popped` for that id arrived (a sequence number or the event alone). Test.
- P7 A returned terminal is correct and sized: on return, the main view is reset and replays `term_buffer` (with the 4.1 offsets) at the pane's size. One `term_resize` for the pane size is sent even when the tab is inactive or the pane is hidden (the last known pane size). Test.
- P8 × on an exited session tab removes the tab only after `term_close` succeeds. A failure keeps the tab and shows the notice.
- P9 Errors in a pop-out show in that window: `TerminalWindow` renders the notice.
- P10 Tab strip semantics: drop the `tablist`/`tab` roles. Each tab is a plain button with `aria-current` on the active one, and its × is a separate labelled button ("Close tab <title>"). No roving tabindex is needed.
- P11 Resume over a popped-out terminal returns it to the pane only after the resume succeeds, and awaits it. Test.
- P12 Pop-out background: the window background matches `--bg-raised` from `tokens.css`. A Rust test reads `src/theme/tokens.css` and asserts the constant equals the token, so the two cannot drift.
- P13 Pop-out title: Rust updates the pop-out window's native title whenever that terminal's info title changes (restart, resume).
- P14 Pop-out keys: inside a pop-out, `ctrl+pageup`/`pagedown`, `` ctrl+` `` and `ctrl+shift+k` go to the terminal (no dispatcher there).
- P15 `terminal.popOut` is offered only while the pane is open on that terminal (`pane === "terminal"`).
- P16 Pop-out minimum size: 480 × 320.
- P17 Tests:
  - The main window applying live `term://popped` events (popped, then null), followed by `syncSize`.
  - `term://info` and `term://closed` handled in the frontend, including `only` filtering.
  - Rust `term_restart` emitting info, and `term_close` on a popped terminal emitting closed and popped null and destroying the window.
  - Project removal closing its terminals' pop-outs.
  - The failed-build path.
  - The stale `Existing` record.
- P18 Docs: README and DESIGN describe the pane-while-popped behaviour, Alt+F4, the minimum size and the tab buttons.

**Defer:**
- D1 Restricting the app commands a `term-*` window may invoke to `term_*`. It needs an app permission manifest covering every command, for main as well.
- D2 Remembering pop-out size and position.
- D3 A test of `on_run_event` routing for `ExitRequested` and `WindowEvent::Destroyed`. Tauri's event types are non-exhaustive, so this is covered by the GUI pass.

**Dismiss:**
- Spec bookkeeping stale: updated by the orchestrator.

## Design Notes

- **Two views, one PTY.** Each webview has its own xterm `Terminal` for a popped-out id. Both receive `term://data`, since Tauri emits to all webviews. Only the window that owns the size sends resizes: the pop-out while it is open, otherwise the main pane. Input from either view goes to the same `term_write`.
- **Replay in the pop-out.** The pop-out's view is created after output began, so it uses the 4.1 replay path: `term_buffer` with its offset, then live chunks above that offset.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):** orchestrator, foreground-guarded (two plain terminals, no claude):
- Open plain terminals on two projects; screenshot the tabs.
- Print in one, then switch tabs with ctrl+pageup/pagedown; screenshot.
- Pop out one, type in it, then screenshot both windows.
- Close the pop-out; screenshot the returned tab with its output.
