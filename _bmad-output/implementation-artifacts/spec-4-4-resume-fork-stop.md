---
title: 'Story 4.4: Resume, fork, stop'
type: 'feature'
created: '2026-10-18'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5aaf549fd7c9c747519168eee3a1e2d985f43f00'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-2-new-session-launch-sheet.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-3-hook-driven-status.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Switchboard can start a session and watch it, but it cannot pick an old one back up, branch off one, or end one cleanly. The lifecycle stops at "running".

**Approach:**
- **Resume.** Resume on a historic session runs `claude --resume <id>` in that session's folder with the standard app flags. The same node becomes live.
- **Fork.** Fork runs `--resume <id> --fork-session --session-id <new>`. A new node appears, joined to its original by a thin "forked from" line.
- **Stop.** Stop on a live Switchboard session sends `/exit` when the session is idle, otherwise Ctrl+C twice, and kills the process after 5 s if it is still running.

**Facts (claude 2.1.302 `--help`):**
- `--resume <session-id>` continues that session under the same id.
- `--fork-session` creates a new session id when resuming.
- Claude finds a session through the folder it ran in, so a resume must run in the transcript's `cwd`.

**Decisions:**
- **Which sessions:**
  - **Resume** is offered for a selected session that has a transcript and is not live: no live entry, or one that has `exited`.
  - **Fork** is offered for any selected session with a transcript, live or not.
  - **Stop** is offered only for a live session running in a Switchboard terminal (app-running). Sessions started elsewhere keep "Attach in terminal" as the stub. They are never signalled or killed by pid.
- **Folder:** the transcript's recorded `cwd` when that folder exists, else the session's project folder. The launch is refused with `session folder not found: <path>` when neither exists.
- **Flags:**
  - **Model, effort and permission mode** come from the session's project's last choices, then from settings (the 4.2 prefill), and are applied exactly as 4.2 does, so `default` means the flag is left out.
  - **Every launch also gets:** the hooks `--settings` file, `--append-system-prompt` with the node context, and the 4.2 environment with `SWITCHBOARD_NODE` and `SWITCHBOARD_PORT`.
  - **Not passed:** add-dirs and a first prompt.
  - **Resume** passes no `--session-id` and no `--name`, so Claude keeps the session's own name. **Fork** passes `--session-id <new uuid v4>` and `--name <original name or project label>-fork-<first 4 hex of the new id>`, cleaned as the 4.2 default name is.
- **Start:**
  - Resume and Fork start at once, with no sheet. The pane opens on the new terminal, focused, and that node is selected.
  - They are refused with a notice while the same session is starting or running in Switchboard.
  - A resume reuses the terminal id `session:<id>`. An exited terminal with that id is closed first, and its view is reset.
- **Live state:**
  - A resumed id goes through `LiveMap::launched`, which clears any `app_exited` mark, so the same node goes `starting`→`idle`→… exactly as in 4.2 and 4.3.
  - A fork is a new id: a new live-only child, which joins its transcript by id once the transcript appears.
- **Fork link:**
  - `SessionRef` gains `forkedFrom: Option<String>`, saved in the workspace when the fork is launched.
  - The canvas draws a thin, muted, non-interactive line between the fork's card and its original's card when both cards are visible, with no arrowhead and no accent. It is a rendering of `forkedFrom`, not an `EdgeKind`.
  - The fork card's tooltip and accessible label include `forked from <original title>`.
- **Stop:**
  - **Idle sessions** (amended in review round 1). For a session that is `idle` or `finished`, write `/exit` then `\r`.
  - **Any other state.** For `starting`, `busy`, `waiting` or `other`, write `\x03`, wait 300 ms, then write `\x03` again.
  - **Kill after 5 s.** If the process still runs 5 s later, kill it with the Story 4.1 kill. The node then turns `exited` through the existing PTY exit rule.
  - **While stopping.** The card shows `stopping`, muted, until the process exits. A second Stop kills at once.
- **Commands** (node menu and palette, with no new keys):
  - `session.resume`, "Resume", menu order 7.
  - `session.fork`, "Fork", menu order 8.
  - `session.stop`, "Stop", menu order 12.
  - Each has a `when` that matches the rules above.

## Boundaries & Constraints

**Always:**
- **Rust owns it.** Rust builds every argv, spawns, and owns the stop sequence and its timer.
- **One argv entry per argument.** No shell strings.
- **Nothing outside the session dir.** Nothing is written under `~/.claude`; the session files live in the 4.2 per-user session dir.
- **No real claude in tests.** Tests use fixture programs and pure planners.
- **CI.** Both runners stay green, with the design lint passing.

**Never:**
- Signalling or killing sessions that Switchboard did not start.
- Worktree folders (Epic 5).
- A sheet for resume or fork.
- Tabs (Story 4.5).
- Editing or deleting transcripts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Resume | historic `ide-59cd`, Resume | argv `--resume <id> [--model …] --settings … --append-system-prompt …` in the transcript cwd; same node `starting`→`idle`; pane on it | cwd and project folder missing → refused with notice |
| Resume twice | already running | Resume not offered | — |
| Fork | `ide-59cd`, Fork | argv `--resume <id> --fork-session --session-id <new> --name ide-59cd-fork-xxxx …`; new child with a forked-from line to `ide-59cd` | — |
| Fork link restart | app restarts | `forkedFrom` kept; line drawn again | original no longer listed → no line |
| Stop idle | `idle` | `/exit` + Enter; exits; `exited` | — |
| Stop busy | `busy` | Ctrl+C, 300 ms, Ctrl+C; exits or killed at 5 s; `exited` | — |
| Stop again | `stopping` | killed at once | — |
| External | session started elsewhere | Stop not offered | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/claude/launch.rs`:**
  - `LaunchKind { New, Resume { id }, Fork { from } }`, and `build_args` covering all three.
  - `fork_name(base, new_id)`.
  - `resume_cwd(transcript_cwd, project_path)`.
  - A pure `stop_plan(state) -> StopPlan { Exit | Interrupt }`.
  - Tests for each.
- **`src-tauri/src/ipc/mod.rs`:**
  - `launch_session` is generalised over the kind: Resume and Fork reuse its validation, settings, hooks token and terminal steps.
  - New commands `session_resume { sessionId }`, `session_fork { sessionId }` and `session_stop { sessionId }`.
  - Prefill without a sheet comes from `launch::prefill`.
- **`src-tauri/src/pty/mod.rs`:**
  - Opening a session terminal over an exited one with the same id replaces it.
  - The stop sequence lives in a manager method or the ipc layer: a timer thread, then a kill. A `stopping` flag is exposed in `TermInfo`.
- **`src-tauri/src/claude/live.rs`:** `launched` clears `app_exited`. Check it, and add a test for a relaunch of an exited id.
- **`src-tauri/src/graph/mod.rs`:** `SessionRef.forked_from` (serde default), `set_forked_from`, and `ChildNode.forked_from` in children for the canvas. Tests.
- **Frontend:**
  - `src/commands/sessions.ts` and `builtins.ts` (+tests): the three commands with their `when` rules, using live state and terminal info.
  - `src/ipc/index.ts`: the wrappers, plus `forkedFrom` and `stopping`.
  - `src/canvas/nodes.ts` (+test): `forkLines(nodes)` gives the pairs to draw. `Canvas` renders them as a non-interactive edge type, `fork`, styled with tokens in `nodes.css`.
  - `ChildNode.tsx`: the `stopping` word, and the forked-from text in the title and label.
- **Docs:** `README.md` gets a "Resume, fork, stop" section. `docs/DESIGN.md` gets the fork line and the `stopping` word.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/launch.rs` (+tests) -- kinds, argv, fork name, resume cwd, stop plan -- recipes
- [x] `src-tauri/src/ipc/mod.rs`, `pty/mod.rs`, `claude/live.rs`, `lib.rs` (+tests, including fixture launches for resume and fork checking the argv the child received, a stop of an idle fixture that exits on `/exit`, and a stop of a fixture ignoring input that is killed at 5 s) -- lifecycle
- [x] `src-tauri/src/graph/mod.rs` (+tests) -- `forkedFrom` persisted and exposed -- fork link
- [x] `src/commands/sessions.ts`, `builtins.ts`, `src/ipc/index.ts`, `src/canvas/nodes.ts`, `Canvas`, `ChildNode.tsx`, `nodes.css` (+tests) -- commands, fork line, stopping word
- [x] `README.md`, `docs/DESIGN.md` -- docs

**Acceptance Criteria:**
- Given a historic session, when I choose Resume, then `claude --resume <id>` runs in its folder with the standard app flags and the same node becomes live.
- Given Fork, when it starts, then `--resume <id> --fork-session --session-id <new>` runs and a new node appears with a thin "forked from" line to the original.
- Given a live Switchboard session, when I choose Stop, then `/exit` + Enter is sent if idle, otherwise Ctrl+C twice, then the process is killed after 5 s, and the node becomes `exited`.
- Given `cargo test`, `clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- 2026-10-18 (dev). Decisions taken while building, where the spec left room:
  - **`launch.rs`.** `build_args(kind, req, session_id, settings_path, system_prompt)`; Resume ignores `req.name` (no name is validated or passed), and Resume/Fork never pass add-dirs or a prompt even if the request carried them. `fork_name(base, id)` = `default_name("<base>-fork", id)` after the same cleaning. `resume_cwd` returns the transcript cwd as recorded (not canonicalised) when it is a folder; the refusal names the transcript cwd, else the project folder (`FOLDER_NOT_FOUND`). `stop_plan` maps `starting`/`idle`/`finished` to `Exit`, everything else (and a session the live map does not know) to `Interrupt`; `stop_writes` gives the writes with their pauses. **`/exit` and its `\r` are 100 ms apart** (`EXIT_ENTER_GAP`), so the TUI reads them as typed rather than as one paste; the spec only says "then".
  - **`ipc`.** `launch_session` is split into `prepare_launch` (no side effects: program, batch refusal, session dir, system prompt, argv) and `run_launch` (live entry, token, settings file, terminal; a failure undoes what it created and runs the kind's give-back). New: `launch_session` (claims the sheet's id, remembers choices), `resume_session`, `fork_session`; commands `session_resume { sessionId, cols?, rows? }`, `session_fork { sessionId, cols?, rows? }` (both reply `LaunchResult`), `session_stop { sessionId }` (replies `TermInfo`).
    - **Source.** A Resume/Fork needs a discovered transcript (`NO_TRANSCRIPT` otherwise); its project is the one it was discovered under. The name it goes by is the live entry's name, else the transcript title (not `(untitled)`), else the project label: Resume uses it for the terminal title and live name (not passed to claude); Fork builds `fork_name` from it. Flags come from `launch::prefill` (project's last choices, else `settings.defaults`); Resume/Fork do not update the remembered choices.
    - **"Refused while starting or running" (Resume).** Atomic with taking the live entry: under the live-map write lock a known entry in a live state (any source: Switchboard's own `starting`/running session, or one the poll sees running elsewhere) is `SESSION_RUNNING`; a running terminal `session:<id>` too. Fork needs no such guard (always a fresh id), so Fork of a live session is allowed, as the Decisions say. A refused/failed resume puts the session's previous live record back.
    - **Exit hook order changed:** the token is dropped and the settings file deleted *before* `process_exited` marks the node `exited`, so a resume issued as soon as the node shows `exited` can create its own `<id>.settings.json` (`create_new`) and token. A resume also removes a stale `<id>.settings.json` (from an app that crashed) before writing, since the session is known not to be live.
    - **Fork link** is written after a successful spawn by `graph::set_forked_from(project, new, from)` (upserts the ref; same origin again is a no-op).
  - **`pty`.** `open_session` over an exited terminal with the same id replaces it in place (same list position); a running one is still `terminal already exists`; a failed spawn puts the exited one back. `Term::stop(writes, kill_after)` / `TermManager::stop`: sets `stopping`, a thread writes each step after its pause (only while the same spawn runs), then waits out the 5 s (polling every 50 ms, so it ends early once the child is gone) and kills through `kill_if(generation)` (the 4.1 kill, under the `starting` lock, only for the same spawn). A Stop while `stopping` kills at once. `TermInfo.stopping` = stopping and still running; a new spawn clears it.
  - **Found while testing (Windows): children inherited "ignore Ctrl+C".** A process started with Ctrl+C ignored (the test runner here, and potentially an app launched from such a shell) passes that flag on, so `\x03` written to ConPTY never interrupted the child (`Start-Sleep` ran on). `pty::allow_ctrl_c` now calls `SetConsoleCtrlHandler(NULL, FALSE)` once before the first spawn (new `windows-sys` feature `Win32_System_Console`), so every terminal child gets default Ctrl+C handling. This also fixes Ctrl+C in plain terminals in that situation. Proven by the pty test (a `powershell Start-Sleep` / `sh -c "sleep 60"` child ends within 5 s of the interrupt plan's writes).
  - **Frontend.** `src/commands/sessions.ts`: `hasTranscript(child)` = a session child with a last activity (discovered from a transcript; live-only children have none). `canResumeSession` = transcript, live state absent or `exited`, and no running session terminal; `canForkSession` = transcript; `canStopSession` = a running `session:<id>` terminal. Resume disposes the old view and drops the old info before the call (offsets restart at 0 in the new run, and an exit that overtakes the reply then waits for the upsert), and puts the info back and replays the view if the resume is refused. A second Resume of the same id while one is in flight is a notice. Stop's reply is not applied over an exit that overtook it.
  - **Canvas.** `ChildNode.forkedFrom` (Rust `ChildNode.forked_from` from the ref); `ChildNodeData.stopping` and `forkedFromTitle` (the original's label when listed, else `null`, in which case the tooltip/label say nothing). `FlowInputs.stopping` (session ids whose terminal info has `stopping` and has not exited) comes from the terminal store in `Canvas`. `forkLines(nodes)` gives one line per drawn fork whose original is drawn; `Canvas` renders them as edges of type `fork` (`ForkEdge`, a `BaseEdge` with `forkLinePath`: a cubic curve between the two cards' left-edge anchors bowing 24 px left), not selectable or focusable, `interactionWidth` 0, `pointer-events: none`. Session cards carry two invisible, non-connectable `Handle`s at the left edge as anchors (xyflow needs handles to route an edge). The line is 1 px `--border` (Rule 1: every line is `--border`), not `--fg-faint`. The terminal pane header reads `stopping` while a Stop is under way.
  - **Docs.** README: new "Resume, fork, stop" section, palette count 29, terminal header word, Enter wording; DESIGN: `stopping` row in the session-state table, terminal header word, fork card tooltip, "The fork line" section. The stale "resume and fork arrive in Epic 4" wording (README, `navigation.ts` doc and a test name) is updated; Enter on a session still does nothing.
- **Verified here (Windows):** `cargo test` 362 passed (twice), including `resume_fork_and_an_idle_stop_run_their_recipes` (fixture argv for resume and fork, the transcript folder as cwd, `SESSION_RUNNING` while running, the exited terminal replaced on a second resume, Stop on a `starting` session typing `/exit` + Enter and the fixture exiting 0 before 5 s, `forkedFrom` recorded and exposed, `FOLDER_NOT_FOUND`), `a_busy_stop_interrupts_then_kills_at_five_seconds_and_a_second_stop_kills_at_once` (a PowerShell fixture with `TreatControlCAsInput` ignores both Ctrl+C and is killed at ≥ 4.5 s; Stop twice kills at once; `NOT_STOPPABLE` for a session without a Switchboard terminal), the pty tests for replacement and the stop sequence, and the graph/launch/live unit tests. `cargo clippy --all-targets -- -D warnings` clean, `npm test` 417 passed (design lint included), `npx tsc --noEmit` clean. No test process was left (process list checked; one headless `conhost` from 15:36, before this work began, was not touched). **Not run here:** Linux (the `cfg(unix)` fixtures — `sh` with `read`/`pwd`, `trap '' INT; sleep 60`, `sleep 60; echo late` — were written to the existing patterns and reviewed by reading), `npm run tauri build`, and the manual GUI checks with a real `claude` (left to the orchestrator with consent).

- 2026-10-18 GUI pass (orchestrator, real claude 2.1.302, no prompt, Emils' consent): Resume from the palette on the historic `ide-59cd` showed its history in the pane and the same node went `idle`. Fork from the terminal (ctrl+shift+k) created `ide-59cd-fork-718f` as a new child with a thin muted curved line to `ide-59cd`. Stop on the idle fork showed `stopping`, then `exited 0` with Close. After quitting, no claude process remained once each had finished exiting (the last one took more than 2 s).

- 2026-10-18, review patch round 1 (P1–P14; dev). These change or add to the notes above:
  - **P1 pane re-attach.** `terminal/registry` keeps a per-id view version, bumped when a view is made or disposed, with `subscribeViews` / `viewVersion`. `TerminalPane` reads it through `useSyncExternalStore`, and its show/focus effect depends on `[id, version]`. So a resumed session's fresh view, and the view `restore` makes after a refused resume, are put in the pane and focused even though the id did not change. Covered by a registry test.
  - **P2 / P3 Stop plan.** The exit plan is Ctrl+U (`CLEAR_LINE`, 0x15), then `/exit`, then `\r`, each step 100 ms after the last. `starting` now uses the interrupt plan (Spec Change Log). The lib test makes the session `idle` before Stop. On Windows, `cmd`'s `set /p` keeps the Ctrl+U as a character, so that check only looks for `/exit` there; on Unix the tty drops it.
  - **P4 whole live state restored.** `LiveMap::save(id)` returns a `SavedSession` (the entry, its place in `exited_order`, `app_running`, `app_exited`, `busy_seen`, the hooked count, the wait kind and the last answer). `LiveMap::restore(id, saved)` puts it back exactly, or forgets the id when nothing was saved. `run_launch` saves before `launched` and restores on any failure, for every kind. Tests:
    - a unit test comparing the whole map;
    - the lib test comparing the whole map after a failed spawn and after a settings write that fails (the session dir points at a file).
  - **P5 explicit project.** `session_resume` / `session_fork` take `projectId` (the card's `child.projectId`). Rust looks the transcript up under that project only, and refuses with `unknown project` when the project is gone.
  - **P6.** `ChildNode.hasTranscript` is true for discovered children only. The frontend's Resume and Fork `when` rules use it.
  - **P7 pruning.** `set_discovered` also drops refs that have `forkedFrom` set but whose session is not discovered (any project), not a live or exited child (`live_children`), and not a fork still starting (`Launcher::pending_forks`). When anything is pruned, the file is written and the snapshot emitted. A missing original is never a reason. The pending check runs under the workspace lock, so a fork whose link was just written is never pruned.
  - **P8 link before spawn.** `run_launch` writes the fork link after the settings file and before the spawn. If it cannot be saved (unknown project, or a file write error), the change is taken back, the banner is set, and the fork is refused with `could not save the fork link: …`. After a failed spawn, `graph::clear_forked_from` removes the link (and the ref when nothing else is in it). Since the link exists before the live child is first placed, the fork node is first emitted already linked.
  - **P9 visible flags.** `LaunchResult` gains `choices { model, effort, permission_mode }`, which is `launch::remembered` of the flags used (`default` when a flag is left out). After a success, the frontend shows `resumed with model …, effort …, mode …` (or `forked with …`) as the notice. The README says Resume and Fork use the project's latest choices.
  - **P10 fork names.** `fork_name` strips any trailing `-fork-<4 hex>`, repeatedly, and cuts the base to `FORK_BASE_MAX` = 40 characters (not bytes) before appending.
  - **P11 double fork.** The frontend keeps an in-flight set of "fork from" ids; a second Fork shows `a fork of that session is already starting`. Rust's `Launcher::begin_fork(from, new)` refuses with `FORK_STARTING` while a fork from that id is under way. Its guard is held through the whole launch, and the same map also gives the pending ids for P7.
  - **P12.** Any error from `TermManager::stop` (the child exited after the check) maps to `NOT_STOPPABLE`.
  - **P13.** `allow_ctrl_c` logs a failed `SetConsoleCtrlHandler`. Its doc comment states that this also restores Switchboard's own default console Ctrl+C handling. A debug build run from a console therefore now ends on Ctrl+C there; a release build has no console.
  - **P14 tests.**
    - Node reuse across `stopping` and `forkedFrom` changes, including the original being renamed.
    - `stoppingSessionIds(infos)` and `sessionIdOfTerminal` (the inverse of `sessionTerminalId`), now used by `Canvas`.
    - Resume of a session live elsewhere with no terminal: refused, no terminal, live entry unchanged.
    - A resume replacing a stale `<id>.settings.json`.
    - A failed fork leaving no ref.
  - Not changed: the working paths the GUI pass checked (Resume of a historic session, Fork with the line, Stop on an idle session ending `exited 0`) keep their behaviour. The only difference is the Ctrl+U before `/exit`.
- **Round 1 verified here (Windows):**
  - `cargo test`: 365 passed.
  - `cargo clippy --all-targets -- -D warnings`: clean.
  - `npm test`: 420 passed (design lint included).
  - `npx tsc --noEmit`: clean.
  - No test process was left (process list checked).
  - Not run here: Linux.

- 2026-10-18 GUI re-run after the patch round (orchestrator, real claude, no prompt): resume of `ide-59cd` showed its history in the pane and the node went `idle`. Fork created `ide-59cd-fork-6e7c` with the line. Stop on the idle fork (Ctrl+U, `/exit`, Enter) ended at `exited 0`. The earlier fork `ide-59cd-fork-718f`, which had no transcript, was pruned. No claude process remained.

## Spec Change Log

- 2026-10-18 (review round 1, Emils' decision): Stop on a `starting` session uses the interrupt plan (Ctrl+C twice, then the 5 s kill) instead of `/exit`. During startup Claude may be showing a dialog such as folder trust, and Enter would accept its default. The frozen Stop decision was amended.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 Blank pane on resume: resuming while the pane shows that session's exited terminal must put the new view in the pane and focus it, and so must the restore after a refusal. Make the pane re-attach when the view instance changes, not only when the id does. Registry test.
- P2 `/exit` clears the draft first: the exit plan writes Ctrl+U (0x15) before `/exit`, so an unsent draft is never submitted. A test pins the write order.
- P3 Stop on `starting` uses the interrupt plan (Spec Change Log). Update `stop_plan` and its tests.
- P4 A failed resume restores the whole previous live state: the `sessions` entry, `exited` / `exited_order` membership, `app_exited`, and the busy/hook marks. Snapshot before `launched` and put it back in `forget`. Test with a spawn failure and with a settings-write failure.
- P5 The project is explicit: `session_resume` / `session_fork` take `projectId` from the frontend (`child.projectId`). Rust checks that the id is discovered under that project, and refuses with `unknown project` when the project is gone. That replaces the wrong `NO_TRANSCRIPT` message.
- P6 An explicit transcript flag: `ChildNode` gets `hasTranscript` (true when discovered), and the frontend's Resume and Fork `when` rules use it, not `lastActive !== ""`.
- P7 Fork refs are cleaned up: a `forkedFrom` ref whose fork session is neither discovered nor live after a discovery pass is pruned. A missing original only hides the line. Test.
- P8 The fork link is written before the spawn and undone on failure. The fork child is emitted once with `forkedFrom` already set. If the link write fails, the fork is refused with a notice.
- P9 Flags made visible: the notice after Resume or Fork names the model, effort and mode used ("resumed with model opus, mode plan"; omitted flags read "default"). The README says Resume and Fork use the project's latest choices.
- P10 Fork names: `fork_name` strips an existing `-fork-xxxx` suffix before appending, and cuts the base to 40 characters. Tests.
- P11 Double fork guard: a second Fork of the same session while one is in flight is refused with a notice (frontend in-flight set, plus Rust refusing while a fork from that id is starting).
- P12 A Stop that races an exit maps to the normal "not stoppable" refusal, not the raw "terminal has exited".
- P13 `allow_ctrl_c`: log a failure of `SetConsoleCtrlHandler`. Document in Implementation Notes and the doc comment that it also restores Switchboard's own console Ctrl+C handling.
- P14 Tests:
  - Node reuse with `stopping` and `forkedFrom` changes between two `toFlowNodes` calls.
  - A pure `stoppingSessionIds(infos)` built on the inverse of `sessionTerminalId` (used by `Canvas`).
  - Resume refused for a session that is live elsewhere and has no terminal: no terminal created, live entry unchanged.
  - A resume succeeding when a stale `<id>.settings.json` exists.

**Defer:**
- D1 An isolated test for `allow_ctrl_c` with the test process set to ignore Ctrl+C. It changes process-wide console state, so it needs its own binary.
- D2 Component tests for the fork edge and handles (no component test environment yet).
- D3 Resuming with the session's own last model and mode, read from its transcript, instead of the project's latest choices.

**Dismiss:**
- "Verification incomplete": the real-claude GUI pass ran (Implementation Notes), and Linux is gated by CI.

## Design Notes

- **Kind-specific argv.** Resume and Fork share `launch_session`'s whole path. Only the argv head differs: New gives `--session-id <id> --name <n>`, Resume gives `--resume <id>`, and Fork gives `--resume <from> --fork-session --session-id <new> --name <n>`. The common tail is model, effort, mode, `--settings` and `--append-system-prompt`.
- **Stop timer.** A thread sleeps 5 s, then kills if the terminal's spawn generation is unchanged and the process is still running. A restart or a resume in between therefore never kills the newer process.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):** orchestrator, foreground-guarded, with Emils' consent (real claude, no prompt):
- Resume the historic `ide-a391`, then screenshot the same node live.
- Fork it, then screenshot the forked-from line.
- Stop both, then screenshot `exited`.
- Confirm no claude process remains.
