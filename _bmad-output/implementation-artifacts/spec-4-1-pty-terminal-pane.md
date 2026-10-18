---
title: 'Story 4.1: PTY terminal pane'
type: 'feature'
created: '2026-10-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'ff5203992aa01f2021ae613f7f912137592edd28'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Switchboard can show sessions but cannot run anything. "Plain terminal…" is a stub, and the Claude TUI, the core of every later story, needs a real terminal: a PTY, full colour, resize, paste, scrollback, and output that survives hiding the pane.

**Approach:**
- **Rust owns the processes.** A `pty/` module spawns shells through `portable-pty`, which uses ConPTY on Windows and a Unix PTY on Linux.
- **Output streams to the webview and is buffered.** Output is coalesced and streamed as events, and each terminal also keeps a byte ring buffer.
- **The webview renders with xterm.js.** xterm 6 uses the WebGL renderer, falling back to its DOM renderer when WebGL is missing or lost.
- **A terminal pane.** It is wider than the other panes and resizable by dragging its left edge, and it shows one terminal at a time.
- **Plain terminal.** "Plain terminal…" on a project opens that project's terminal in its folder, using the configured shell.
- **Hiding keeps it running.** Hiding the pane keeps the process and its output, and reopening shows everything.

**Decisions (recorded; owner away, orchestrator's recommended choices, logged in the Spec Change Log for review):**
- **Renderer:**
  - `@xterm/xterm` 6.0.0 with `@xterm/addon-fit` 0.11.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-unicode11` 0.9.0 and `@xterm/addon-web-links` 0.12.0. No canvas addon: it is stuck at 0.7.0 and requires xterm 5.
  - The Linux acceptance criterion's "canvas renderer" is read as **the non-WebGL fallback**, which on xterm 6 is the DOM renderer. WebGL is tried first. If it fails to load, or its context is lost, the terminal switches to the DOM renderer for the rest of its life.
- **PTY:**
  - **Spawn:** `portable-pty` 0.9.0 opens a PTY. Its first size comes from the pane (fit), else 120 × 30. The child runs the shell from `settings.shell` (default from Story 1.3: `pwsh` or `powershell` on Windows, `$SHELL` on Linux, else `/bin/sh`), with cwd set to the project folder.
  - **Environment:** inherited, plus `TERM=xterm-256color` and `COLORTERM=truecolor`.
  - **Read loop:** one reader thread per terminal. It pushes chunks into a **2 MiB ring buffer** and emits `term://data` `{ id, data }`, coalesced to at most one event per 8 ms per terminal. Payloads are UTF-8 strings, and a split multi-byte sequence is carried over to the next chunk.
  - **Exit:** the child's exit emits `term://exit` `{ id, code }`. The buffer is kept.
- **Commands:**
  - `term_open { kind: "plain", project_id, cols, rows } -> TermInfo { id, project_id, title, cwd, exited: Option<i32> }`. One plain terminal per project: opening again returns the existing one, running or exited.
  - `term_write { id, data }`.
  - `term_resize { id, cols, rows }`, with a minimum of 2 × 1.
  - `term_buffer { id } -> String`, the ring buffer for a terminal view created after output began.
  - `term_restart { id }`, which respawns an exited terminal with the same id.
  - `term_kill { id }`.
  - `term_list`.
- **Exit and quit:** when the app exits, every child is killed. No orphan shells are left.
- **Pane:**
  - **Kind and size:** `ui.pane` gains `"terminal"`. The pane is `min(720px, 70vw)` wide by default, and dragging its left edge resizes it between 360 px and 90vw. The width lives in `localStorage` with try/catch (a per-viewer convenience).
  - **Header:** project label, cwd, state (`running` / `exited N`), and buttons for Restart (when exited), Hide and Kill.
  - **Body:** the xterm view, at a scrollback of **10 000 lines**.
  - **Resizing:** resizing the pane or the window refits and sends `term_resize`, debounced to 50 ms.
  - **Showing:** the pane shows the most recently opened or selected terminal.
- **Keeping output (frontend):**
  - The xterm `Terminal` objects live in a module-level registry. They are never disposed while their PTY lives.
  - Each one's element is moved into the pane when shown and into a hidden holder when the pane hides, so writes continue while hidden and reopening shows everything.
  - A view created later (after a reload) first writes `term_buffer`, then follows events.
- **Keys:**
  - While focus is inside a terminal, the global dispatcher yields every key to it, so Claude's own Esc, `ctrl+c`, `ctrl+o` and `ctrl+r` keep working. Only two bindings still reach the dispatcher there.
  - `` ctrl+` `` (`terminal.toggle`) shows or hides the terminal pane from anywhere, re-focusing the last terminal.
  - `ctrl+shift+k` opens the palette.
  - Esc in the terminal goes to the shell. Outside the terminal, Esc still closes the pane as in the existing order.
- **Copy and paste:**
  - `ctrl+shift+c` copies the selection, and `ctrl+shift+v` pastes through xterm's paste path (bracketed paste).
  - The webview's own paste event (`ctrl+v`, right-click Paste) also works.
  - A selection is never copied automatically.
- **Commands (registry):**
  - `project.terminal` ("Plain terminal…") replaces the 2.4 stub: it opens or shows the project's terminal.
  - `terminal.toggle`, `terminal.kill` and `terminal.restart` are added, each with a `when`.
  - `session.attach` stays a stub (it needs `claude attach` in Story 4.4/4.5).
- **Colours:**
  - The xterm theme is read from CSS variables at runtime. The foreground, background, cursor and selection use the existing tokens.
  - New `--ansi-0`…`--ansi-15` tokens in `tokens.css` hold the 16-colour palette. This is terminal content, not chrome; the accent rule does not apply inside the terminal, and DESIGN.md says so.
  - The cursor uses `--fg`.

## Boundaries & Constraints

**Always:**
- Rust owns processes; the webview never spawns anything.
- PTY I/O never blocks the UI thread or any app lock. Each terminal has its own lock, and none is held across a blocking read.
- Every child is killed on app exit.
- Nothing is written under `~/.claude`.
- Tokens only in CSS; the design lint stays green.
- Both CI runners stay green: PTY tests run on Windows (ConPTY) and Linux, and spawn only `cmd`/`sh` fixtures, never a user shell profile.

**Never:**
- Launching Claude, the launch sheet, hooks, resume, fork or stop (Stories 4.2–4.4).
- Tabs or pop-out windows (Story 4.5).
- Persisting terminals across app restarts.
- Shell integration (prompt marks).
- Search, links opening the browser, or a terminal settings UI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Open | "Plain terminal…" on `ide` | pane opens with the configured shell in `B:\projects\ide`, focused | shell missing → pane shows `could not start <shell>: <cause>` and Restart |
| Colour | `printf '\e[38;5;208mX\e[38;2;10;200;90mY\e[0m'` (or PowerShell equivalent) | X in 256-colour orange, Y in truecolour green | — |
| Resize | drag the pane edge / resize the window | xterm refits, PTY gets the new cols × rows (`mode con` / `stty size` agree) | — |
| Paste | `ctrl+shift+v` or `ctrl+v` with multi-line text | text arrives once, bracketed | — |
| Scrollback | 12 000 lines printed | the last 10 000 reachable by scrolling | — |
| Hide | `` ctrl+` `` while a command prints | process continues; reopening shows all output | — |
| Reopen same | "Plain terminal…" on `ide` again | the existing terminal, no second shell | — |
| Exit | `exit` in the shell | header `exited 0`; Restart respawns in place | — |
| Kill | `terminal.kill` | child killed, header `exited`, buffer kept | — |
| Quit | app quits with terminals open | no orphan shell processes remain | — |
| Keys | focus in terminal; Esc, `ctrl+o`, `ctrl+k`, `ctrl+c` | all reach the shell; `ctrl+shift+k` opens the palette | — |
| No WebGL | WebGL unavailable or context lost | DOM renderer, same output | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/Cargo.toml`:**
  - Add `portable-pty = "0.9"`.
  - tokio currently has only `time` and `sync`; add `rt` only if a task needs it. Prefer `std::thread` for readers.
- **New `src-tauri/src/pty/mod.rs`:**
  - `TermManager` (in `AppState`) holds a `Mutex<HashMap<String, Arc<Term>>>`.
  - `Term { id, project_id, cwd, master: Mutex<Box<dyn MasterPty>>, writer: Mutex<Box<dyn Write + Send>>, child: Mutex<Box<dyn Child>>, buffer: Mutex<Ring>, exited: Mutex<Option<i32>> }`.
  - Functions: `open`, `write`, `resize`, `buffer`, `restart`, `kill`, `kill_all`.
  - A reader thread with a UTF-8 carry and an 8 ms coalescing emitter.
  - `Ring` is a byte ring buffer, unit-tested.
- **Shell:** `src-tauri/src/settings/mod.rs` has `Settings.shell` and `default_shell` (Windows: `pwsh` if on PATH else `powershell`). Resolve the shell through `settings::detect::Search` like the editor (Story 2.4 `resolve_program`, in `src-tauri/src/ipc/mod.rs`).
- **`src-tauri/src/lib.rs`:**
  - `builder().setup` and `run()`: register the commands.
  - Kill all terminals on `RunEvent::Exit` / `ExitRequested`. Switch `run()` to `.build(ctx)?.run(|app, event| …)`.
- **`src-tauri/src/process.rs`:** has `no_window` (`CREATE_NO_WINDOW`). Not needed for ConPTY: a PTY child has no console window of its own.
- **Frontend `src/terminal/` (new):**
  - `registry.ts` holds the `Terminal` instances by id: create with addons, attach/detach the element, write, and dispose on kill.
  - `theme.ts` builds the xterm theme from `getComputedStyle(document.documentElement)`, with a pure mapping that is unit-tested.
  - `keys.ts` has `terminalKeyAllowed(event)`, the pure rule for the two pass-through bindings, unit-tested.
  - `TerminalPane.tsx` holds the header, the drag handle and the host element.
- **`src/ipc/index.ts`:** add the wrappers `termOpen`, `termWrite`, `termResize`, `termBuffer`, `termRestart`, `termKill` and `termList`, plus `onTermData` and `onTermExit`.
- **`src/state/ui.ts`:** `Pane` adds `"terminal"`, plus `activeTerminal: string | null` and the pane width. **`src/App.tsx`:** render `TerminalPane` when `pane === "terminal"`. The hidden holder is always mounted.
- **`src/commands/keybindings.ts`:** `handleKeydown`. Add the rule that inside an element with `[data-terminal]`, only `terminalKeyAllowed` bindings run, and xterm's helper textarea counts as inside.
- **`src/commands/builtins.ts` (+test):** replace the `project.terminal` stub. Add `terminal.toggle` (`` ctrl+` ``), `terminal.kill` and `terminal.restart`. Add `ctrl+shift+k` as a second palette binding (a hidden alias command).
- **`src/commands/navigation.ts`:** `plainTerminalStub` and its notice are removed.
- **`src/theme/tokens.css`:** `--ansi-0`…`--ansi-15`. **`docs/DESIGN.md`:** a terminal section covering the ANSI tokens, the pane, and that the accent rule excludes terminal content. **`src/theme/design.test.ts`:** unchanged rules; the new CSS must pass.
- **`README.md`:** a Terminal section covering opening, keys, copy/paste, hide/kill/restart, renderer fallback and the shell setting.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/pty/mod.rs`, `Cargo.toml` -- `Ring`, `TermManager`, open/write/resize/buffer/restart/kill/kill_all, reader + UTF-8 carry + 8 ms coalescing, exit event; tests (both OSes, `cmd`/`sh` fixtures): output arrives, write echoes, resize accepted, buffer replays, exit reported, restart respawns, kill and kill_all leave no child, ring wraps, split UTF-8 survives -- the PTY core
- [x] `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/settings/mod.rs` (`AppState`) -- commands, shell resolution, kill on exit; wire tests -- wiring
- [x] `package.json` -- the five xterm packages at the versions above -- deps
- [x] `src/terminal/registry.ts`, `theme.ts`, `keys.ts` (+tests), `src/terminal/TerminalPane.tsx`, `src/components/shell.css` -- views, theme, key rule, pane with drag handle -- terminal UI
- [x] `src/ipc/index.ts` (+test), `src/state/ui.ts` (+test), `src/App.tsx`, `src/commands/keybindings.ts` (+test), `src/commands/builtins.ts` (+test), `src/commands/navigation.ts` -- IPC, pane state, key routing, commands -- integration
- [x] `src/theme/tokens.css`, `docs/DESIGN.md`, `README.md` -- ANSI tokens and docs -- docs

**Acceptance Criteria:**
- Given a project, when I run "Plain terminal…", then the pane shows a working shell in the project folder; 256-colour and truecolour render; resizing the pane resizes the PTY; paste works; at least 10 000 lines scroll back.
- Given the pane hidden while a command prints, when I reopen it, then all output is there and the process kept running.
- Given focus in the terminal, when I press Esc, `ctrl+o` or `ctrl+c`, then the shell receives them; `` ctrl+` `` hides the pane and `ctrl+shift+k` opens the palette.
- Given the app quits, when it has terminals open, then no shell process remains.
- Given `cargo test`, `clippy -D warnings`, `npm test` (design lint), `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- 2026-10-18 (dev, owner away). Deviations from the Code Map and decisions taken while building:
  - **`Term` shape:** the running half is one `live: Mutex<Option<Live { master, writer, killer, pid }>>` instead of separate `master` / `writer` / `child` mutexes. The **waiter thread owns the `Child`** and blocks in `wait()` with no lock held; `kill` goes through a `clone_killer()`. Dropping `Live` closes the PTY. There is also a per-terminal `respawn` lock so two overlapping restarts cannot start two children.
  - **`TermInfo` has one extra field, `error: Option<String>`.** It is `could not start <shell>: <cause>` when the shell could not be resolved or spawned. The terminal still opens, exited with code `-1`, and the same line is written to its buffer and view. The header shows it as `.pane-error`.
  - **ConPTY cursor query.** `portable-pty` creates the pseudoconsole with `PSEUDOCONSOLE_INHERIT_CURSOR`, so conhost first sends `ESC[6n` and blocks all output until it gets a reply. xterm answers it through `onData`: the view is created in the hidden holder as soon as output arrives, even before the pane shows it. The PTY tests answer it themselves. Found by test: when nobody has answered, `ClosePseudoConsole` blocks for about 400 s and the headless `conhost.exe` outlives the process. Two fixes follow from that. PTYs are now always closed on a detached thread (`close_detached`), so neither `kill_all` nor the exit report waits on it. On Windows, a `ESC[1;1R` is written first, which lets conhost shut down. Regression test: `kill_all_never_waits_for_a_pseudoconsole_nobody_answered`.
  - **Kill on Unix:** `portable-pty` sends SIGHUP; a child still alive after 300 ms gets SIGKILL to its process group and itself (`libc`, a unix-only dependency already in the tree). On Windows it is `TerminateProcess`, then the pseudoconsole is closed.
  - **Exit:** `run()` is `.build(ctx)?.run(on_run_event)`. `kill_all` runs on `ExitRequested` and on `Exit`, and is idempotent.
  - **Frontend layout:**
    - `src/state/terminals.ts` holds the `TermInfo` store and mirrors `plainTerminalId`, which is `pty::plain_id`, `plain-<project_id>`.
    - `src/commands/terminal.ts` holds the command logic.
    - The palette alias is the hidden command `palette.toggleFromTerminal`.
    - Opening a terminal works in this order: show the pane, wait two animation frames, fit the view, then `term_open` with the fitted size (null → 120 × 30).
  - **Paste:** `ctrl+shift+v` uses `navigator.clipboard.readText()` → `term.paste()` when the async clipboard exists. `ctrl+v` is left to the webview's native paste event, which xterm turns into a bracketed paste, so the shell never receives `^V`. `ctrl+shift+c` copies through `navigator.clipboard.writeText`.
  - **Web links addon:** loaded with a no-op handler. Links underline on hover but never open a browser ("Never: links opening the browser").
  - **Not forwarded:** xterm's `onBinary` (legacy X10 mouse reports). Rust takes UTF-8 strings, and Claude uses SGR mouse.
  - **Reload replay:** after a webview reload, output that arrives while `term_list` / `term_buffer` are in flight is queued and written after the buffer. Payloads carry no sequence number (the spec fixes `{ id, data }`), so a chunk emitted in the few ms around the `term_buffer` read can show twice. This only happens on reload.
  - **CI:** `portable-pty` 0.9 needs no system package on ubuntu-24.04 (its tree is `nix`, `libc`, `serial2`, with no udev or pkg-config), so `ci.yml` is unchanged. `windows-sys` 0.61, already in the lock file, is a Windows-only dev-dependency that the PTY tests use to check a pid is gone, because `tasklist` hung under the test harness.
  - **Not verified here:** the Linux build and tests (no Linux toolchain on this machine; the `cfg(unix)` paths were reviewed by reading only), and the manual GUI checks (WebGL/DOM fallback, colours, drag, paste, focus routing in a real webview).
- 2026-10-18, review patch round 1 (P1–P23). These decisions add to or change the notes above:
  - **P3, additive wire change.**
    - `term://data` is `{ id, data, offset }`. `offset` is the terminal's output byte count at the end of `data`: the ring's running total, minus any UTF-8 bytes still carried over.
    - `term_buffer` returns `{ data, offset }` instead of a bare string.
    - The spec's `{ id, data }` is otherwise unchanged.
    - The frontend drops chunks that end at or before the replayed offset, and cuts a chunk that straddles it at the byte boundary.
  - **P2:** `TermInfo` gains `cols` / `rows`, which is the PTY's size. A view made while hidden is made at that size. `syncSize` writes the new size back to the store.
  - **P4:** `Ring::snapshot()`: after a wrap, the text starts after the first newline, or with `ESC c` when the kept bytes have no newline. A character still arriving at the end is left out, and the offset is moved back to match. The frontend also runs `term.reset()` before writing a replay.
  - **P1:** while a replay is being parsed, a per-view `replaying` flag drops xterm's `onData` replies. The flag clears in `term.write`'s callback.
  - **P5:** `MAX_PAYLOAD` = 256 KiB per event. Anything left over goes in the next tick.
  - **P6:**
    - Each spawn has a writer thread fed by an mpsc FIFO. `term_write` is now a **sync** command that only enqueues; Tauri runs sync commands in invoke order, so keystrokes are never reordered.
    - `live` is never held across PTY I/O.
    - `close_detached` sends the Windows cursor reply through the queue, then drops the sender, then joins the writer thread before dropping the PTY.
  - **P7:** a per-term `starting` lock. `open` takes it on a new terminal before the terminal goes into the map. `open` of an existing terminal, `restart`, `kill` and `kill_all` all wait on it.
  - **P13:**
    - The emitter sends `term://exit` after its final flush, and only once the waiter has handed it the code.
    - Data events are sent while the pending lock is held.
    - If the output never ends (a grandchild still holds the PTY), the waiter reports the exit after `FLUSH_GRACE`. A `done` flag makes sure nothing more of that spawn goes out afterwards.
  - **P10 / P11:**
    - `kill_all` (and `forget_project`) signal every terminal first, then wait one shared 300 ms grace, then SIGKILL the survivors.
    - Hard kill (both paths) only runs while the waiter's `reaped` flag is unset.
    - Corrected the `process_alive` comment: a zombie counts as alive.
  - **P12:**
    - `windows-sys` 0.61 is a normal Windows-only dependency, with features `Win32_Foundation`, `Win32_Security` and `Win32_System_JobObjects`.
    - A kill-on-close Job Object is created and the shell assigned right after spawn. The job lives in `Live`; kill and `kill_all` close it.
    - Grandchildren also die on a normal exit, because closing `Live` closes the job.
    - Test `a_grandchild_dies_with_its_terminal_on_kill_and_on_kill_all`: `start /b cmd /d /k` in the `cmd /d` fixture; the grandchild is found with a ToolHelp snapshot (dev-dependency features). A `Reap` guard terminates both pids if an assertion fails.
    - **Unix is not covered:** a background job in its own process group can outlive SIGHUP or SIGKILL of the shell's group. Killing the whole session is left for a later story.
  - **P16:** `split_command_line` splits on whitespace. Double quotes group words (and are removed) anywhere in a word; backslashes are literal, so Windows paths work. An empty program falls back to the default shell with no arguments.
  - **P17:** `layoutKey` maps `ctrl+Backquote` → `` ` `` and `ctrl+shift+KeyK` → `k`. The dispatcher matches on a copy of the event, so the real event's `preventDefault` is still the one called. `KeyEventLike` gains an optional `code`.
  - **P18 / P19:**
    - `TermManager::forget_project` kills the project's terminals and removes them from the map. `workspace_remove_project` calls it before replying.
    - The frontend's `removeProject` then calls `forgetProjectTerminals`, which removes the store infos, runs `disposeView`, and closes the pane if it showed one of them.
    - A kill still keeps the view.
  - **P8:** an exit for an id the store doesn't know yet is kept in `pendingExits`. It is applied once, by the next upsert of a running info.
  - **P14:** every async handler in `connectTerminals` checks `disposed`.
  - **P15:** `restartTerminal` resets the view before `term_restart`.
  - **P20:** `term_buffer` and `term_list` run through `blocking`. `term_write` deliberately stays sync (see P6).
  - **P21:** when `wait()` fails, `error` is set to `could not wait for the shell: <cause>` and the exit code is `-1`.
  - **P22:**
    - `openProjectTerminal` focuses an existing terminal after the pane has laid out.
    - `hideView` blurs the terminal.
    - The palette remembers whether it was opened from inside a terminal, and gives focus back to the active terminal through xterm.
  - **P9:** `exit_code() as i32`, so NTSTATUS codes show as negative numbers.
  - **P23:**
    - New `src/terminal/registry.test.ts`, with xterm, its addons and `../ipc` mocked through `vi.mock` and a stubbed `document`. It covers the early-holder queue, the hidden size, offset dedupe, replay order, replay input suppression, `handleKey` per key, the `syncSize` guards, and the fitted size reaching `term_open`.
    - New Rust tests: `kill_escalates_to_sigkill_when_hup_is_ignored` (unix, via `kill` and `kill_all`), `a_flood_of_output_goes_out_in_events_of_at_most_256_kib` (unix), `forget_project_kills_and_drops_only_that_projects_terminals`, the wrapped-ring snapshot, and a check that nothing follows the exit.
    - The lib-level wiring test now saves both shell pids and waits until they are gone.

- 2026-10-18 GUI pass (orchestrator, foreground-guarded, debug build): "Plain terminal…" from the palette opened PowerShell in `B:\projects\ide`; 256-colour orange and truecolour green rendered; the PTY reported 99x50, and 127x50 after dragging the pane edge 200 px left; 12 000 lines printed and the tail showed `line 12000` / `DONE-12000`. The pass then aborted on the foreground guard (another app took the foreground; no input sent), so hide/reopen via `` ctrl+` ``, Esc staying in the terminal and the quit orphan check were not driven in the GUI. They are covered by the registry tests and the Rust kill/kill_all/Job Object tests; left for the owner to try by hand. After the app was closed no shell or conhost from it remained.

## Spec Change Log

- 2026-10-18 (checkpoint, owner away): Emils asked the orchestrator to continue with its recommended choices while away. Checkpoint 1 taken as "Keep full spec" + "Approve and continue". Recommended choices made in the frozen block for review: xterm 6 with the DOM renderer as the non-WebGL fallback (the canvas addon is abandoned and xterm-5-only); `` ctrl+` `` / `ctrl+shift+k` as the only keys reaching the dispatcher inside a terminal; one plain terminal per project until tabs (4.5); 10 000-line scrollback; 2 MiB Rust ring buffer.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap; triaged by the orchestrator while the owner is away):

**Patch:**
- P1 Replay answers old queries: suppress `onData` → `term_write` while a buffer replay is being written.
- P2 Hidden/late views at 80×24: `TermInfo` gains `cols`/`rows` (the PTY size); views are created and resized to it.
- P3 Duplicate output after reload: `term_buffer` returns `{ data, offset }` where `offset` is the ring's total pushed byte count; each `term://data` carries `offset` (byte position after the chunk) as an added field; the frontend drops chunks already covered by the replayed buffer. `{ id, data }` stays; `offset` is additive.
- P4 Wrapped ring starts mid-escape: after a wrap, `text()` starts after the first newline (or prefixes `ESC c` when none), and the replay is prefixed with a reset.
- P5 Unbounded events: cap one `term://data` payload at 256 KiB (the rest goes in the next tick). Full watermark flow control deferred (D1).
- P6 Writes hold `live` across `write_all` and concurrent async writes reorder input: one writer thread per spawn fed by a FIFO channel; `term_write` only enqueues; `live` is never held across blocking I/O.
- P7 Open/kill race around map insert: a per-term starting lock so open/kill/restart wait for the spawn to finish.
- P8 Exit before upsert: the frontend records exits for unknown ids and applies them on upsert.
- P9 NTSTATUS exit codes: `exit_code() as i32`.
- P10 Unix quit blocks 300 ms per terminal: `kill_all` signals all first, then waits one shared grace before hard-killing survivors.
- P11 Hard kill after reap can hit a reused pid: a `reaped` flag set by the waiter right after `wait()` returns; hard kill only when not reaped. Fix the `process_alive` comment.
- P12 Windows grandchildren: put each shell into a kill-on-close Job Object right after spawn; test that a grandchild dies on kill and on `kill_all`.
- P13 Exit event before final data: the emitter sends `term://exit` after its final flush (no data for a spawn after its exit).
- P14 StrictMode double `connectTerminals`: guard with `disposed` in the async handlers.
- P15 Restart in stale modes: `term.reset()` before the respawned shell is shown.
- P16 `settings.shell` arguments: split the argument tail honoring quotes (same rules as the program); empty program falls back to the default shell with no arguments.
- P17 Layout-independent keys: `terminal.toggle` and the in-terminal palette binding also match on `event.code` (`Backquote`, `KeyK`).
- P18 Removed project's terminal: `workspace_remove_project` kills and forgets that project's terminals; the frontend drops its views.
- P19 `disposeView` unused: call it on forget (P18); kill keeps the view (buffer kept).
- P20 `term_buffer`/`term_list` sync on the main thread: make them async via `blocking`.
- P21 `wait()` error: set `error` to the wait error text.
- P22 Focus: `openProjectTerminal` focuses an existing terminal; `hideView` calls `term.blur()`; closing the palette that was opened from a terminal returns focus to it.
- P23 Tests: `src/terminal/registry.test.ts` with mocked xterm/addons/ipc and a document stub (replay order, early-holder queue, `handleKey` returns per key, `syncSize` guards, fitted size passed to `term_open`, offset dedupe, replay input suppression); a unix `kill_escalates_to_sigkill_when_hup_is_ignored` test (via `kill` and `kill_all`); the lib-level exit test saves the pid and waits for it to be gone.

**Defer** (to deferred-work.md):
- D1 Watermark flow control from xterm write callbacks back to the reader.
- D2 Timing-based coalescing test (needs the emitter split from the PTY).
- D3 Keyboard-operable pane resize handle (tabIndex, aria values, arrow keys).

**Dismiss:**
- "Linux never compiled": covered by the CI gate before close (both runners must be green), as for every story.

## Design Notes

- **Coalescing:**
  - The reader thread appends to the ring and to a pending `Vec<u8>`.
  - An 8 ms ticker per terminal (or a `Condvar` with a timeout) drains the pending bytes. It decodes the longest valid UTF-8 prefix, keeps the 0–3 trailing bytes, and emits one event.
  - When the child exits, the remainder is flushed before `term://exit`.
- **Windows ConPTY:** `portable-pty`'s native system uses ConPTY on Windows 10 1809+ (this machine runs Windows 11). Resize is `MasterPty::resize(PtySize)`.
- **Focus routing test:** a pure `isInsideTerminal(target)` walks `closest('[data-terminal]')`. `handleKeydown` asks it first. The test builds plain objects with a `closest` stub.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): plant `ide`, select it, then run "Plain terminal…" from the palette.
- Type a PowerShell line that prints a 256-colour and a truecolour escape, plus `$Host.UI.RawUI.WindowSize`, and screenshot.
- Drag the pane edge and print the size again, then screenshot.
- Print 12 000 numbered lines, press `` ctrl+` `` to hide and again to reopen, scroll to the top, and screenshot.
- Press Esc in the terminal and confirm the pane stays open.
- Quit, then confirm no `powershell`/`pwsh` child of Switchboard remains (CIM parent-process query).
