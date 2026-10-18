---
title: 'Story 4.2: New session launch sheet'
type: 'feature'
created: '2026-10-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '4c3106bfce14200da2813e609cfca3ba557c6733'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-pty-terminal-pane.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Switchboard can watch Claude sessions and run a shell, but it cannot start a session. "New session…" is a stub, so every session still begins in some other terminal, without an id the app knows in advance.

**Approach:**
- **The sheet.** `n` (or "New session…") on a project opens a launch sheet. Its fields are name, model, effort, permission mode, add-dirs, an optional first prompt, and start in background. Defaults come from the project's last choices, then from settings.
- **Rust owns the launch.** On start, Rust assigns a session id and writes a per-session settings file in the OS temp dir. It builds the argv and runs `claude` in a 4.1 PTY terminal.
- **Immediate feedback.** The session appears at once as a `starting` live child, the terminal pane opens on it, and it turns `idle` on the first PTY output.
- **One node per session.** When the transcript later appears, discovery matches it by session id, so the node is never duplicated.

**Decisions:**
- **`--mcp-config` left out.** Emils decided on 2026-10-18 that the flag stays out until the MCP server ships in Epic 7. The acceptance criterion's argv list is read without it.
- **Argv.** `<claude.path> --session-id <uuid v4> --name <name> [--model <m>] [--effort <e>] [--permission-mode <p>] [--add-dir <d>]… --settings <tmp>/<id>.settings.json --append-system-prompt <context> [<prompt>]`.
  - A field left at "default" is omitted. That includes a permission mode of `default`, because 2.1.302 has no such choice, and an empty model or effort.
  - `--session-id` is always a fresh v4 UUID.
  - The prompt is the last positional argument, and only when it is non-empty.
- **Env.** The inherited environment plus `TERM=xterm-256color`, `COLORTERM=truecolor` (as in 4.1) and `SWITCHBOARD_NODE=<sessionId>`. `SWITCHBOARD_PORT` arrives with the hooks endpoint in 4.3.
- **Choices offered:**
  - **Model:** default, fable, opus, sonnet, haiku, or custom free text.
  - **Effort:** default, low, medium, high, xhigh, max.
  - **Permission mode:** default, manual, acceptEdits, plan, auto, dontAsk.
  - **`bypassPermissions` is not offered.** Rust refuses it in a launch request, and never adds `--dangerously-skip-permissions`.
- **Per-session settings file.**
  - Written to `<session dir>/<sessionId>.settings.json` with the content `{}`. The session dir is `<os temp>/switchboard/sessions` on Windows (per-user) and `$XDG_RUNTIME_DIR/switchboard/sessions` on Linux, else the app's cache dir. On Unix the folder is created 0700 and refused if another user owns it, and each file is created exclusively (`create_new`). Story 4.3 adds the hooks, and the user's own settings layers are untouched.
  - Deleted when the session's process exits and on app exit.
  - At startup the folder is swept of files older than 24 h whose session is not running.
  - Nothing is ever written under `~/.claude`.
- **System prompt.** `--append-system-prompt` gets at most 10 short lines:
  - That the session runs inside Switchboard.
  - The project label and path.
  - The current branch, if known.
  - The session name and node id.
  - No instructions beyond that.
- **Name.** The default is `<project label>-<first 4 hex of the session id>`. It is editable and must not be blank (trimmed).
- **Remembered choices.**
  - Last choices are saved per project in the existing `Project.launchDefaults` (model, effort, permission mode) on every start. The sheet prefills them first, then `settings.defaults`, then "default".
  - Add-dirs, the prompt, the name and background are not remembered.
- **Add-dirs.** A list with "Add folder…" (the OS folder dialog, as in Story 1.5's import) and a remove button per row. A path that doesn't exist blocks Start, with a message on the row. Duplicates and the project's own folder are dropped.
- **Batch-file claude.** If `claude.path` resolves to a `.cmd` or `.bat` on Windows, the launch is refused with `claude.path points to a batch file; set it to the native claude.exe`. This avoids cmd.exe re-parsing the prompt.
- **Live state.**
  - `SessionState` gains `Starting` and `StateSource` gains `App`.
  - A launched session enters the live map at once: `Starting`, with its cwd (the project path), project, name and `startedAt`. A snapshot is emitted, so the canvas shows a live-only child before the first poll.
  - It turns `Idle` on its first PTY output or on its first poll row, whichever comes first.
  - Poll rows update it as for any session.
  - While its PTY child runs, missing from a poll does **not** exit it. Its PTY exit turns it `Exited` immediately and emits.
- **Status word.** `starting` is muted, exactly like `idle`. It has no glow and no notification.
- **Terminal.**
  - A session terminal has id `session:<sessionId>` and title = the session name, with cwd = the project path.
  - It is never restarted; Story 4.4 adds resume. Restart is hidden, and Kill stays.
  - With "start in background" off, the pane opens on it, focused, and the new child is selected. With it on, the canvas only shows the child.
- **Show terminal.** A new node-menu and palette command `session.showTerminal` ("Show terminal", menu order 9). Its `when` is that the selected session has a Switchboard terminal, and it opens the pane on that terminal. `session.attach` stays the stub for sessions started elsewhere.
- **Keys.** `n` with a project selected opens the sheet; on a session or branch it does nothing. In the sheet:
  - Enter in any single-line field or select starts.
  - Enter in the prompt adds a newline.
  - `ctrl+Enter` starts from anywhere in the sheet.
  - Esc closes the sheet.
- **Sheet surface.** It is a right-side pane (`ui.pane = "launch"`), like settings and import. It has no new motion and uses tokens only.

## Boundaries & Constraints

**Always:**
- Rust builds the argv, spawns, and owns the session id and temp files. The webview only sends the request.
- Every argument goes to the PTY as a separate argv entry. No shell string is ever built.
- The app's session files live only in the per-user session dir, are deleted on exit, and are never written under `~/.claude`.
- Tests never run the real `claude`. They use fixture programs (`cmd`/`sh`) or the pure argv builder.
- Both CI runners stay green.
- The design lint stays green.

**Never:**
- Hooks content or the hooks HTTP endpoint (Story 4.3).
- Resume, fork or stop (Story 4.4).
- Tabs (Story 4.5).
- `--mcp-config`.
- `--dangerously-skip-permissions` or `bypassPermissions`.
- Worktree launches (Epic 5).
- Context-edge add-dirs (Epic 6).
- Persisting add-dirs or prompts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Open sheet | `ide` selected, `n` | sheet with name `ide-xxxx`, model/effort/mode from `ide`'s last choices else settings | — |
| Start | defaults, Enter | argv `--session-id <uuid> --name ide-xxxx --settings …settings.json --append-system-prompt …` (no model/effort/mode flags for "default"); child `starting` at once; pane opens; `idle` on first output | claude missing → sheet stays, error under Start, no child |
| Chosen flags | opus, high, plan, 1 add-dir, prompt "hi" | `--model opus --effort high --permission-mode plan --add-dir <d> … hi`; `ide.launchDefaults` = opus/high/plan | add-dir missing → Start blocked |
| Background | toggle on | child appears; pane not opened; selection unchanged | — |
| Poll gap | launched, not yet in `agents --json` | stays `starting`/`idle`, not `exited` | — |
| Transcript appears | discovery finds `<id>.jsonl` | the same child (no duplicate), now with transcript facts | — |
| Exit | `/exit` in the TUI | child `exited`; temp settings file deleted; terminal shows `exited 0`, no Restart | — |
| App quit | session running | child killed (4.1), temp files deleted | — |
| Batch claude | `claude.path` = `claude.cmd` (Windows) | refused with the batch-file message | — |
| Bypass | request with `bypassPermissions` | refused by Rust | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/claude/launch.rs` (new):**
  - `LaunchRequest { project_id, name, model, effort, permission_mode, add_dirs, prompt, background }`.
  - A pure `build_args(req, session_id, settings_path, system_prompt) -> Result<Vec<String>, String>`.
  - Also `system_prompt(project, branch, name, session_id)`, the temp file write/delete/sweep, and validation (name, add-dirs, permission mode, batch-file program).
- **`src-tauri/src/pty/mod.rs`:**
  - A terminal kind (plain | session), with `open_session(id, spec, …)`.
  - The exit callback lets the launcher clean up.
  - `SpawnSpec` gains `env: Vec<(String,String)>`.
  - Session terminals refuse `restart`.
- **`src-tauri/src/claude/live.rs`:**
  - Add `Starting` and the `App` source.
  - Add `LiveMap::launched(id, …)`, `first_output(id)` and `process_exited(id)`.
  - `apply_at` must not exit sessions marked app-running.
  - Tests for each.
- **`src-tauri/src/ipc/mod.rs`:** `session_launch(request) -> TermInfo + sessionId`, plus `launch_defaults`, which returns the prefill for a project.
- **`src-tauri/src/lib.rs`:** register the commands, run the startup sweep, and delete temp files on exit.
- **`src-tauri/src/graph/mod.rs`:** `Project.launch_defaults` is reused. Set it through the existing workspace mutation path and emit `workspace://changed`.
- **Frontend:**
  - `src/components/LaunchPane.tsx` (new) is the sheet. A pure `src/commands/launch.ts` (+test) holds the prefill precedence, validation, request building and the key rule (Enter vs `ctrl+Enter` vs prompt newline).
  - `src/state/ui.ts` gets the `"launch"` pane. `src/App.tsx` renders it.
  - `src/commands/builtins.ts` (+test) replaces `project.newSession` with `n` and adds `session.showTerminal`. `src/commands/navigation.ts` drops `newSessionStub`.
  - `src/ipc/index.ts` (+test) adds `sessionLaunch`, `launchDefaults` and the `starting` state type.
  - `src/state/terminals.ts` and `src/terminal/TerminalPane.tsx` handle the session kind: no Restart, title = name.
  - `src/canvas/nodes.ts` plus the `ChildNode` status word: `starting` gets a muted treatment.
- **Docs:** `README.md` gets a "Starting sessions" section. `docs/DESIGN.md` adds the `starting` status word.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/launch.rs` (+tests) -- request validation, argv builder, system prompt, temp settings file lifecycle and sweep -- the launch recipe
- [x] `src-tauri/src/pty/mod.rs`, `src-tauri/src/claude/live.rs` (+tests) -- session terminal kind with env and exit callback; `Starting`/`App` and the poll-gap rule -- process and state
- [x] `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` (+tests, including one fixture-program launch that checks the argv the child received, `starting`→`idle`→`exited`, and temp file deletion) -- wiring
- [x] `src/commands/launch.ts` (+test), `src/components/LaunchPane.tsx`, `src/state/ui.ts`, `src/App.tsx`, `src/components/shell.css` -- the sheet
- [x] `src/commands/builtins.ts`, `navigation.ts`, `src/ipc/index.ts`, `src/state/terminals.ts`, `src/terminal/TerminalPane.tsx`, `src/canvas/nodes.ts`, `ChildNode.tsx` (+tests) -- commands, IPC, terminal kind, status word
- [x] `README.md`, `docs/DESIGN.md` -- docs

**Acceptance Criteria:**
- Given a selected project, when I press `n`, then the sheet shows name/model/effort/permission/add-dirs/prompt/background prefilled from the project's last choices then settings, and Enter starts.
- Given I start, when the process launches, then the argv is the Decisions recipe (no `--mcp-config`), a `starting` child appears immediately, the pane opens on its terminal, and it turns `idle` within 2 s.
- Given the transcript appears, when discovery runs, then the same child is used (no duplicate).
- Given the session exits, when its process ends, then the child is `exited` and its temp settings file is gone.
- Given `cargo test`, `clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- 2026-10-18 (dev). Deviations from the Code Map and decisions taken while building:
  - **Session id and the default name.** The name `<label>-<4 hex>` must be shown before Start, so `launch_defaults` proposes the session id: `Launcher::proposed` keeps one fresh v4 id per project until a launch with it starts (`consume`), and a reopened sheet proposes a new one. A refused start retried from the same sheet keeps the id, so the name still matches it. The id is never one a session has used.
  - **Prefill precedence lives in Rust** (`launch::prefill`, returned by `launch_defaults` as `{ name, model, effort, permissionMode }`); `src/commands/launch.ts` maps it to the form (`formFromPrefill`: a model that is not a named entry becomes `custom` + its text; an effort or mode not offered reads as `default`). Rust's `LaunchPrefill` and `LaunchRequest` are camelCase on the wire; `LaunchResult` is `{ session_id, term }` like the other terminal types.
  - **Remembered choices** are stored verbatim, `default` included (`Some("default")`), so a project whose last choice was `default` does not fall back to `settings.defaults`. `graph::set_launch_defaults` skips the write and the event when nothing changed.
  - **Validation in Rust** (`build_args`, run before anything is written or spawned): a blank name or one starting with `-`, `bypassPermissions` (`BYPASS_REFUSED`), an effort or mode not offered, a custom model starting with `-`. **A prompt starting with `-` is passed after `--`** so it is never read as a flag; any other prompt is the last argument as specified. This `--` is the one addition to the recipe.
  - **Add-dirs:** Rust canonicalises them, drops duplicates and the project folder, and refuses a missing one with `add-dir does not exist: <path>`; the webview has no file-system access, so "blocks Start, with a message on the row" works by Rust refusing, the sheet marking the row (`missingAddDir`) and keeping Start disabled until the row is removed. The folder dialog is the existing `project_pick_folder` (its title still reads "Add project folder").
  - **Claude binary:** a launch needs `claude` detected as `found` (the same rule the poll uses: while it is not found the poll clears the live map, which would drop the session); otherwise `claude not found; set claude.path in settings`. The batch-file refusal is checked on the resolved path. Tests swap the program through a `#[cfg(test)]` `Launcher::program` override (`cmd.exe /d /c set /p x= & echo node=%SWITCHBOARD_NODE% & echo` on Windows, `/bin/sh -c 'read x; printf …'` on Unix).
  - **PTY:** `TermKind` moved from `ipc` to `pty` and `TermInfo` gained `kind` (`plain` / `session`). `open_session` returns `Err` on a spawn failure and leaves no terminal (a plain terminal still opens exited). Hooks: `first_output` runs on the reader thread after the first chunk; the exit hook runs after `term://exit`, with no PTY lock held. `term_open` with `kind: "session"` is refused; `restart` of a session terminal is refused (`a session terminal cannot be restarted`).
  - **Live map:** `app_running` (launch → PTY exit) carries a session missing from a poll over unchanged; `app_exited` makes a late poll row for a session whose PTY already exited not bring it back (the CLI lags the exit); a new `launched` of the id clears both. `launched` registers the session before the spawn (so the first output always finds it) without emitting; after a successful spawn one `sessions://live` + `set_live_children` goes out; a failed spawn `forget`s it. `update_and_emit` is the helper for these app-side changes.
  - **Frontend layout:** the sheet's state is `src/state/launch.ts`; the effectful commands (open with prefill, Start, Add folder, Show terminal) are `src/commands/sessions.ts`; `src/commands/launch.ts` stays pure. `project.newSession` (`n`) is disabled while the sheet is open, so `n` typed on one of its selects never resets the form. `session.attach` is hidden for a session that has a Switchboard terminal (it has Show terminal). A foreground start also expands a collapsed project so the selected child is drawn. The PTY starts at 120 × 30 (the session id, hence the view, is unknown before the reply); the pane refits it on show.
  - **System prompt:** six lines at most (the Switchboard line, project, folder, branch when the git poll knows it and it is not detached, session name, node id).
  - **Temp files:** `Launcher` holds the folder (set in `setup` to `<os temp>/switchboard/sessions`; tests pass their own) and the ids it wrote; the startup sweep runs on a thread with an empty running set (nothing is running at startup); `on_run_event` deletes every file still kept.
- **Verified here (Windows):** `cargo test` (316 passed, including the fixture launch that checks the argv the child printed, `starting`/`idle` → `exited`, the settings file deleted on exit and on app exit, and the refusals), `cargo clippy --all-targets -- -D warnings` clean, `npm test` (393 passed, design lint included), `npx tsc --noEmit` clean. No test process was left running (checked with a process listing). **Not verified here:** the Linux run (the `cfg(unix)` fixture path was written for `/bin/sh` and reviewed by reading), `npm run tauri build`, and the manual GUI checks with a real `claude` (left to the orchestrator with consent).
- 2026-10-18, review patch round 1 (P1-P15). These change or add to the notes above:
  - **P1 session dir:** `launch::default_dir` = `session_root(...)/switchboard/sessions`; `session_root` is pure (OS temp on Windows; else an absolute `$XDG_RUNTIME_DIR`, else `dirs::cache_dir()`, else the temp dir). `prepare_dir` (Unix) creates the folders 0700, refuses a symlink or another owner (checked on `sessions` and its `switchboard` parent), and narrows a wider mode to 0700. Files are opened with `create_new` (0600 on Unix): an existing file is an `Err`, never overwritten, and `remove_settings` only deletes files this run wrote. The Unix refusals are tested through `check_owned_dir(dir, uid)` with another uid, a symlinked folder, and a 0755 folder.
  - **P2 ids:** `LaunchPrefill` and `LaunchRequest` carry `sessionId`. `Launcher::claim` takes the proposed id out atomically (`STALE_SHEET` otherwise); every check without side effects runs first. After the claim, an id already in the terminals or the live map is `ID_IN_USE`; a later failure forgets only the live entry and the settings file this call created and `unclaim`s the id (only if no newer sheet holds a proposal), so a retry from the same sheet keeps its name.
  - **P3:** `state/launch.ts` gains `sessionId`, `opened` (bumped per open) and `sheetToken` / `isSheetOpen`. A late refusal for a closed or reopened sheet becomes the notice; a late success registers the terminal only.
  - **P4:** `default_name` strips control characters and a leading `-` or whitespace from the label (falling back to `session`). `validate_name` and the TS `formErrors` refuse control characters. `system_prompt` strips them from every value, and the test pins 6 lines (5 without a branch).
  - **P5:** `pathext_target` resolves an extensionless `claude.path` through `PATHEXT` before `refuse_batch`. The README explains the native installer.
  - **P6 / P7:** `app_exited` is now `HashMap<id, exited-at ms>`. It expires after `APP_EXITED_TTL_MS` (10 s) in `apply_at`, entries go with evicted sessions, and `process_exited_at` takes the time. When `claude` stops being found, `cleared_keeping_app` keeps the app's sessions and both sets.
  - **Emit order (found while testing P8):** the `sessions://live` emit and `set_live_children` now happen while the live-map write lock is held (in `update_and_emit`, `apply_and_emit`, `acknowledge` and the not-found clear). A first-output change made on a PTY thread can then never be overtaken by an older snapshot. Lock order is map then workspace; nothing takes them the other way round. Tauri's Rust-side listeners can still see events reordered (an event that arrives while another thread is dispatching is queued), so the lib test checks that each state was emitted, not their order.
  - **P8:** `pty::has_printable` skips CSI, OSC/DCS/APC/PM strings, two- and three-byte escapes, control characters and whitespace. The reader calls the first-output hook on the first chunk with printable text. Tests: unit tests on ConPTY's start-up bytes; `a_session_terminal_reports_its_first_printable_output_and_its_exit_once` (both OSes, the fixture waits for a line) checks nothing fires during 0.5 s of answered start-up; the lib launch test asserts `starting` strictly on both OSes.
  - **P9:** `isEditableTarget` counts `SELECT`, and bare keys (other than Esc, Enter and the arrows) do not dispatch while the context menu is open. `project.newSession` keeps its `pane !== "launch"` guard: a focused button in the sheet would otherwise let `n` reset the form. `launchKeyTarget` treats checkbox, radio, button and similar inputs as "other", so Enter on them does not start.
  - **P10:** `TermManager::close` (session terminals that have exited only) and `term_close`; the `terminal.close` command ("Close terminal") and a Close button in the pane header dispose the view and put the pane away.
  - **P11:** all missing add-dirs are in one error, one path per line after `ADD_DIR_MISSING`. `missingAddDirs` marks every row, and the store keeps `missingDirs`.
  - **P12:** `role="alert"` on the refusal and on row errors. `aria-describedby` links the name and custom model to their hints and a disabled Start to its reason, and `startBlockedReason` shows that reason beside Start.
  - **P13:** `project_pick_folder` takes an optional `title` (default `PICK_FOLDER_TITLE`); the add-dir picker passes "Add folder for this session".
  - **P14:** tests added for `term_open` with `kind: "session"` (refused, nothing opened) and the `settings.defaults` fallback of `launch_defaults`. The sweep test sets mtimes with `File::set_modified`: a 23 h file survives and a 25 h one goes. `TerminalPane` uses `isTerminalRestartable`. The stray `live.rs` test comment is fixed, and `launched` clearing `app_exited` is asserted.
  - **P15:** `session_launch_argv_round_trips_through_the_windows_command_line` (Windows) uses `powershell.exe -NoProfile -File <temp>/argv.ps1` as the test program and prints `[Environment]::GetCommandLineArgs()` one per line. It asserts the exact argv, including the multi-line system prompt and a prompt with quotes, spaces and a backslash before a space.
  - **Found while checking for leftover processes:** a spawn that failed after `openpty` left a headless `conhost.exe` behind on Windows. The spawn error path now writes the cursor reply before closing the PTY (on a thread). The new PTY test no longer opens a real plain shell just to test `close`.
- **Round 1 verified here (Windows):** `cargo test` 326 passed, clippy clean, `npm test` 398 passed, `tsc` clean. No test process or headless `conhost` was left (checked after repeated runs), and nothing was written to the real `%TEMP%\switchboard`. Linux has not been run here: the Unix-only folder tests and the `/bin/sh` paths were reviewed by reading.

- 2026-10-18 GUI pass (orchestrator, foreground-guarded, real claude 2.1.302, Emils' consent): `n` on `ide` opened the sheet prefilled `ide-7400` / default / default / default; ctrl+Enter started; the child showed `starting` at once and `idle` once the TUI drew; the settings file existed in `%TEMP%\switchboard\sessions` while running; `/exit` turned the child `exited`, showed `exited 0` with Close (no Restart) and deleted the file; no claude child remained.
- 2026-10-18 Fix found by the GUI pass (orchestrator): the TUI warned "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker", because Switchboard had been started from inside a Claude session and passed its child-session markers on. `pty::PARENT_SESSION_VARS` (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, _ENTRYPOINT, _EXECPATH, _MESSAGING_SOCKET, _MESSAGING_TOKEN, _SESSION_ATTENDED, _SESSION_ID, _SSE_PORT, CLAUDE_EFFORT, CLAUDE_PID) are now removed from every terminal's environment; user configuration is kept. Unit-tested; a second GUI run showed no warning.

## Spec Change Log

- 2026-10-18 (GUI pass, orchestrator): the Decisions' "Env" line ("the inherited environment plus …") now also removes Claude Code's child-session markers (see Implementation Notes); without it a session started from a Switchboard launched inside Claude would not save its transcript, breaking the discovery criterion. Recorded for Emils' review.

- 2026-10-18 (review round 1, Emils' decision): the per-session settings files moved from `<os temp>/switchboard/sessions` to a per-user session dir. Windows keeps `%TEMP%` (already per-user); Linux uses `$XDG_RUNTIME_DIR/switchboard/sessions`, else the app's cache dir; Unix folders are 0700 and owner-checked, and files are created exclusively. Reason: `/tmp` is shared, so another local user could plant or swap the file, which holds hooks from Story 4.3. Frozen Decisions and Boundaries amended.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 Session dir per Emils' decision (Spec Change Log): per-user dir, 0700 and owner check on Unix, `create_new`; tests for each refusal.
- P2 Launch race: `launch_session` claims the proposed id atomically (taken out of `proposed`), and the request carries the id the sheet showed; a mismatch or an id already in the live map or terminals is refused before anything is touched. A failed launch only cleans up what that call created.
- P3 Frontend stale results: `startLaunch` and `pickAddDir` capture a sheet token (project id plus open count) before awaiting; afterwards they act only on the same sheet, and a refusal with no sheet open shows a notice.
- P4 Names: `default_name` strips leading `-` and whitespace from the label, falling back to `session`; names with control characters are refused; the system prompt strips control characters from the label, path and branch, and stays at most six lines (the test asserts the exact count).
- P5 Batch-file check on the resolved path: an extensionless `claude.path` that resolves through PATHEXT to `.cmd`/`.bat` is refused too. The README states the native-installer requirement and how to switch from the npm shim.
- P6 `app_exited`: entries expire after 10 s, and are pruned with `exited_order` evictions.
- P7 Map clears keep app-owned sessions: when `claude` stops being found, sessions in `app_running` (and both sets) survive the clear.
- P8 `starting` → `idle` only on printable output (a chunk with at least one character outside escape sequences and control characters) or the first poll row; the ConPTY start-up query no longer counts. Test both on Windows and Unix.
- P9 Keys: bare-key bindings do not fire when the target is a `SELECT` (in `isEditableTarget`'s bare-key rule) or while the context menu is open; drop the `pane !== "launch"` hack if it is no longer needed; Enter on a checkbox does not start (only text inputs and selects do).
- P10 Exited session terminals: a "Close" button and `terminal.close` command for exited session terminals remove the terminal in Rust and its view; tests.
- P11 All missing add-dirs are reported at once, each row marked.
- P12 Accessibility: refusal text and row errors use `role="alert"`; `aria-describedby` ties invalid fields to their hints; a disabled Start has a visible reason.
- P13 The add-dir picker gets its own dialog title ("Add folder for this session").
- P14 Tests: `term_open` with `kind: "session"` is refused and opens nothing; `launch_defaults` falls back to `settings.defaults`; `TerminalPane` uses `isTerminalRestartable`; the sweep test sets mtimes so a young file survives while an old one goes; the `live.rs` comment is fixed and `launched` clearing `app_exited` is asserted.
- P15 Windows argv round trip: prove the multi-line `--append-system-prompt` and a prompt containing `"` and spaces arrive intact on Windows, with a fixture that prints its argv one entry per line (for example PowerShell `[Environment]::GetCommandLineArgs()` via a test-only program override). If no fixture works, unit-test the command line portable-pty builds.

**Defer:**
- D1 A branch-line test through `launch_session` (the pure formatter is pinned).
- D2 A test of the `setup` wiring (`set_dir` and the startup sweep); covered by the manual launch check.

**Dismiss:**
- The sweep deleting a second instance's file: the single-instance plugin allows one instance, and the sweep runs only at startup.
- "Linux never run": the CI gate before close covers it.

## Design Notes

- **The poll-gap rule.** `LiveMap` keeps a set of app-running session ids, added on launch and removed on PTY exit. In `apply_at`, a session in that set and missing from the rows is carried over unchanged instead of turning `Exited`.
- **Exit cleanup.** The terminal's exit hook calls `live.process_exited(id)` (it sets `Exited`, removes the id from the set, and emits `sessions://live`) and deletes the settings file.
- **Duplicates.** Graph `children` already merges a live row and a discovered transcript with the same id (the Story 3.2 live-only path). A test pins that this holds for an app-launched id.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator, foreground-guarded, with Emils' consent at GUI time, because this starts a real `claude`:
  - Select `ide` and press `n`, then screenshot the sheet.
  - Start with the defaults and no prompt.
  - Screenshot the `starting`/`idle` child and the TUI in the pane.
  - Type `/exit` and Enter, then screenshot the `exited` child.
  - Confirm the temp settings file is gone and that no `claude` child remains.
