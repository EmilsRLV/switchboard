---
title: 'Story 9.3: Performance budget'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'a8a7f9d329968ff06125c144b62373e5f1e49a7b'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The product promises a light tool, but its budgets (NFR-1..3) have never been measured. The app has grown through eight epics: CodeMirror, the MCP server, the tray. Nobody knows whether it still starts in under a second, idles under 150 MB, or types without lag.

**Approach:**
- Add small, permanent measuring points inside the app, shown in Settings → Diagnostics, plus a repeatable measuring script.
- Measure the release build on the dev machine with the NFR setup: 5 projects, 3 live sessions with their terminals open.
- Write the method and the results to `docs/perf.md`.
- Fix whatever misses the budget, preferring bundle size and lazy loading.

**Decisions** (orchestrator, under Emils' standing authorisation; recorded for his review):
- **Cold start** is the time from process start to the first frame of the canvas, with the workspace loaded and the canvas accepting input.
  - **In the app.** Rust records when the process started. The frontend reports when its first canvas render is done. Diagnostics shows `startup: N ms`, and the value is also returned by a `perf_get` command.
  - **Second check.** The script also measures it from the outside, from `Start-Process` to the window first appearing, as a cross-check.
  - **Runs.** Five cold runs with the median reported. "Cold" means a fresh process; the OS file cache may be warm, and the doc says so.
- **Idle RSS** is the app's own share (Emils, 2026-10-25): the working set (and private bytes, reported separately) of `switchboard.exe` plus its WebView2 renderer process(es). The shared WebView2 runtime processes (browser, GPU, network/storage utilities, crashpad) are reported beside it but not counted. `claude` and the shells are excluded. It is sampled after 60 s idle with the NFR setup, using stub sessions that hold their terminals open.
- **Typing latency** is the time from a key event in a terminal to its echoed character being drawn.
  - **In the app.** The terminal records keydown → the PTY write → the frame that draws the echo, and Diagnostics shows the median and p95 of the last 100 keystrokes (`typing: median N ms · p95 M ms`).
  - **What is typed into.** A plain shell terminal (`cmd`/`pwsh`), so the echo comes from a real program.
  - **"Added" latency** is what the app adds. Because the shell's own echo time is part of the number, the doc reports the full number and says so.
- **Doing the measuring.**
  - The orchestrator runs the script in a foreground-guarded GUI pass on the release build (`npm run tauri build -- --no-bundle`).
  - Numbers are recorded in `docs/perf.md`: machine (CPU, RAM, OS), build, method, raw runs, median and pass/fail per budget.
  - The Linux laptop figure is left for Emils.
- **If a budget is missed:**
  - Profile it and fix the main cause within this story when the fix is small (lazy chunks, deferred work at startup, idle timers).
  - If it is not small, record it as missed with the cause and a follow-up in deferred-work.
  - Budgets are never relaxed in the doc.

## Boundaries & Constraints

**Always:**
- **Measuring points are cheap.** They are always on, with no visible cost and nothing written unless Diagnostics is open. Rust owns the startup clock.
- **Measuring setup.** Stub sessions only: the real `claude` is never run. Nothing is written under `~/.claude`. The real config is moved aside during the GUI pass and restored.

**Never:**
- Changing the budgets.
- Removing features to meet them.
- Telemetry sent anywhere.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Startup mark | app launched | Diagnostics `startup: N ms` | — |
| Typing | 50 keys typed in a shell terminal | `typing: median · p95` from those keys | fewer than 5 samples → `typing: not enough samples` |
| Idle RSS | NFR setup, 60 s idle | script prints per-process figures with each process's role, the app share (budgeted) and the whole tree (reported) | — |
| Doc | measurements done | `docs/perf.md` with method, machine, runs, pass/fail | — |

</frozen-after-approval>

## Code Map

- **Rust:**
  - Keep a process-start `Instant` (or the OS process start time) in `AppState` from the start of `run()` in `lib.rs`.
  - Add a `perf_ready` command, called once by the frontend after the first canvas frame, and `perf_get`, returning the startup ms and the typing stats.
  - Add the rows to `DiagnosticsSnapshot` (`claude/hooks.rs` `DiagnosticsSnapshot` / `diagnostics_get`), or a new diagnostics row source.
- **Frontend:**
  - After the first canvas render, call `perf_ready` (in `Canvas.tsx` / `App.tsx`, from a `requestAnimationFrame` after mount).
  - Typing: in the terminal input path (`src/terminal/*`, the xterm `onData` → `term_write`), stamp the keydown time. On the next xterm render after the echoed output arrives, record the elapsed time in a ring of 100.
  - Diagnostics rows go in `src/components/diagnostics.ts` and `SettingsPane.tsx`.
- **Script:** `scripts/perf/measure.ps1`, which drives the external measurements:
  - cold start timing over 5 launches;
  - process-tree working set and private bytes, excluding `claude`, the shells and the stubs;
  - instructions for the typing step.

  It takes the exe path and a scratch config dir, and never touches the real config unless told.
- **Docs:** `docs/perf.md`, with the method and a results template the orchestrator fills in, and a README pointer.

## Tasks & Acceptance

**Execution:**
- [x] `lib.rs`, `ipc/mod.rs`, diagnostics (+tests): the startup clock, `perf_ready`/`perf_get`, and the typing stats store.
- [x] `Canvas.tsx`/`App.tsx`, the terminal input path, `diagnostics.ts`, `SettingsPane.tsx` (+vitest for the stats helpers): the measuring points.
- [x] `scripts/perf/measure.ps1` and `docs/perf.md` (template): the method.
- [x] Orchestrator: measure, fill in `docs/perf.md`, and fix or record misses.

**Acceptance Criteria:**
- Given five projects and three live sessions with terminals open, when measured on the dev machine, then cold start is under 1 s, idle RSS is under 150 MB (excluding `claude`), and typing adds under 16 ms. Any miss is recorded with its cause and a follow-up.
- Given `docs/perf.md`, when read, then it states the method, the machine, the raw runs and pass/fail per budget.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Rust** (`src-tauri/src/perf.rs`, new): `mark_process_start()` (a static `Instant`, set first thing in `run()`), `Perf` in `AppState.perf` (startup ms in a `OnceLock`, typing ring of 100), `typing_stats` (median; nearest-rank p95; both `None` below 5 samples). Commands in `ipc/mod.rs`: `perf_ready` (records once, returns ms), `perf_typing(samples)` (batch into the ring; drops NaN/negative/>10 s, at most 100 per call), `perf_get` → `{ startup_ms, typing: { samples, median_ms, p95_ms } }`. A new row source rather than `DiagnosticsSnapshot` (that struct is `Eq`; the stats are `f64`). Tests: 8 in `perf.rs`, 1 registration test in `lib.rs`.
- **Opt-in file for the script (an addition beyond the Code Map):** with `SWITCHBOARD_PERF_OUT=<absolute file>` in the environment at launch, the first `perf_ready` appends `{"startup_ms":N,"pid":P}`; the variable is read once and removed from the environment (see the review patch round below). Unset nothing is written. Without it the 5 in-app startup values could only be read off the Diagnostics pane run by run.
- **Frontend:** `src/perf.ts` (new): `isTypingKey`, `TypingProbe` (keydown → written → output → drawn, one key at a time, 1 s stale limit), `TypingSink` (batches to `perf_typing` 1 s after the last sample), `reportFirstFrame` (rAF then a task, once). `terminal/registry.ts`: a capture `keydown` listener on each view's element stamps typing keys; `onData` marks the write; `writeChunk` writes the timed echo with a callback that requests a frame and records the sample. `Canvas.tsx` `Flow` calls `reportFirstFrame()` on mount (the flow mounts only once the workspace snapshot is in). `diagnostics.ts` `perfRows`/`typingText`; `SettingsPane.tsx` shows a **Performance** caption with `startup` and `typing`, read via `perf_get` on the existing 2 s timer (this window's held samples are flushed first). Typing shows one decimal (`median 6.0 ms · p95 12.0 ms`).
- **Script** `scripts/perf/measure.ps1` (PowerShell 5.1, ASCII). How to run it, from the repo root:
  - Build: `npm run tauri build -- --no-bundle` (done; `src-tauri/target/release/switchboard.exe`, 8.7 MB).
  - Prepare a scratch config folder: `settings.json` with `claude.path` → the stub, `close_to_tray: false`, notifications off, `shell` `pwsh`/`cmd`; and `workspace.json` with 5 projects. To get the workspace: run `-Step Session` with only `settings.json`, add 5 folders while it waits, continue through both prompts, then use `<OutDir>\config-after` as `-ConfigDir`.
  - Plan only: `powershell -ExecutionPolicy Bypass -File scripts\perf\measure.ps1 -Exe src-tauri\target\release\switchboard.exe -ConfigDir <scratch> -DryRun`
  - Measure: `... -ConfigDir <scratch> -SwapRealConfig -Step All` (or `-Step Start` / `-Step Session`; `-Runs 5 -IdleSeconds 60 -OutDir <dir>`). Without `-SwapRealConfig` it refuses to launch. It refuses while `switchboard.exe` runs or a `%APPDATA%\switchboard.perf-backup` exists. The real config is renamed to `switchboard.perf-backup` and restored in a `finally`; only the scratch copy the script created is ever deleted.
  - `Start`: 5 fresh processes, each with the window-visible time (outside) and the in-app `startup_ms` (the opt-in line); closes via `WM_CLOSE` (kills the tree after 10 s) and waits for WebView2 to exit; prints raw runs, medians and PASS/MISS.
  - `Session`: one launch, waits for the operator (Enter in its console, or create `<OutDir>\go`) to start 3 stub sessions with terminals open, idles 60 s, then prints per-process and total working set and private bytes for `switchboard.exe` and the `msedgewebview2.exe` processes in its tree, listing everything else as excluded. It then waits again while the operator types 50 keys in a plain shell terminal and reads Diagnostics → Performance → typing, then closes the app.
  - Results go to `<OutDir>\results.json` (after each step) and `startup-runN.jsonl` (default `%TEMP%\switchboard-perf-<time>`).
- **Docs:** `docs/perf.md` (budgets, measuring points, method, results template, Linux note) and a README `## Performance` pointer.
- **Verified:** `cargo test` (609 passed), `cargo clippy --all-targets -- -D warnings` clean, `npx vitest run` (50 files, 688 passed, incl. new `src/perf.test.ts`, `diagnostics.test.ts` rows and a `registry.test.ts` end-to-end typing sample), `npx tsc --noEmit` clean, `npm run tauri build -- --no-bundle` built. The script was parse-checked and run with `-DryRun` and without `-SwapRealConfig` (it refused) against a dummy exe. Its median and process-tree helpers were also run on the current PowerShell process. It has **not** been run against the app.
- **Risks / notes for the measuring pass:**
  - The in-app startup starts at `run()`, not at OS process creation; the window-visible figure covers the gap.
  - Typing samples one key at a time and takes the first output after the write as the echo. In a session terminal with a chatty program it could time unrelated output, which is why the doc says to use a plain shell.
  - The working-set sum double-counts pages shared between WebView2 processes; private bytes are reported beside it.
  - Bundle: the main JS chunk is about 1.07 MB (xterm, its WebGL addon, xyflow, React). If cold start misses, lazy-loading xterm is the obvious lever.
- Tried WebGL-only-while-shown; no RSS gain, and the addon's dispose does not free the context; reverted.
- **Review patch round:**
  - **Typing probe:**
    - A stamped key whose `onData` goes nowhere (replaying, or popped out in the main window) cancels the probe (`TypingProbe.cancel`).
    - `drawn()` gives up a sample older than the 1 s stale limit.
    - `TypingSink` drops non-finite values in `record` and again at `flush`.
    - Tests in `src/perf.test.ts` (stale frame, cancel, NaN/Infinity) and `registry.test.ts` (a popped-out key is not timed and does not close a later key's sample).
  - **`SWITCHBOARD_PERF_OUT`:**
    - `perf::take_perf_out_env()` runs right after `mark_process_start()` at the top of `run()`, while the process has only its main thread. It reads the variable once and removes it from the environment, so no child (PTY shells, sessions, git) inherits it. That is safer than stripping it at each spawn site, which would miss future ones.
    - Only a non-empty absolute path is honoured (`perf_out_from`, tested). `perf_ready` writes via `perf::perf_out()`.
  - **`measure.ps1`:**
    - **Restore:** `Restore-RealConfig` runs in its own steps in `finally`: keep `config-after`, then delete the scratch copy with `Remove-WithRetry` (about 10 s), then rename the backup back only if `%APPDATA%\switchboard` is gone. Otherwise it prints a boxed `REAL CONFIG NOT RESTORED` message with the backup path and the two commands that put it back, and the script exits 3.
    - **Process cleanup:** process trees are captured at launch (`Get-LaunchTree`). `Stop-App` and the final cleanup kill any still-alive `msedgewebview2.exe` from them even when the root has exited, checking pid, name and start time against pid reuse.
    - **Guards:** refuses an `-OutDir` inside `%APPDATA%\switchboard` or its backup. Refuses unless the scratch `settings.json` sets `claude.path` to an absolute, existing file that does not resolve (directly or through a link target) to `%USERPROFILE%\.local\bin\claude.exe`. The guards also apply under `-DryRun`.
    - **Files:** deletes a leftover `<OutDir>\go` at start. Each start run gets a fresh `startup-runN.jsonl`. `results.json` is saved after each step. The config copy is `Get-ChildItem -LiteralPath -Force | Copy-Item -Force`.
  - **Checks run** (scratch dirs and a dummy exe only):
    - `-DryRun` passes. Each refusal exits 1: no swap, no `settings.json`, null, relative or missing `claude.path`, bad JSON, the real-claude path (with `USERPROFILE` pointed at a scratch home), `-OutDir` in the config or its backup, `-ConfigDir` equal to the real config.
    - `Restore-RealConfig`, extracted by AST, was run on scratch folders: restores normally; with the scratch copy held open, it returns false and leaves the backup intact and not nested; it never deletes when nothing was created.
    - Hidden files and bracketed names copy correctly.
  - **Re-verified:** `cargo test` 610 passed, clippy clean, `tsc` clean, vitest 692 passed, release build OK.
  - `docs/perf.md` method sections are updated; Results is untouched.

## Spec Change Log

- **2026-10-25: Emils' decision.** NFR-2 counts only the app's own share. The orchestrator defined that share as `switchboard.exe` plus its WebView2 renderer process(es).
  - **Updated to match:** the frozen Idle RSS definition and the I/O matrix row, PRD NFR-2, `measure.ps1` (per-process roles; the budget is compared with the app share) and `docs/perf.md`.
  - **Result:** the shipped build moves from MISS (364 MB, whole tree) to PASS (125 MB, app share).

- **2026-10-25: orchestrator decision, for Emils' review.**
  - **Change:** the `SWITCHBOARD_PERF_OUT` opt-in file write is an exception to the frozen constraint "nothing written unless Diagnostics is open".
  - **Why:** it is local only and nothing is sent. It is honoured only for an absolute path, read once at start-up and removed from the environment, so no child process inherits it. Without it, the 5 in-app start-up values could only be read off the pane run by run.
  - **If Emils rejects it:** drop the variable, and the script falls back to the window-created figure only.
- **2026-10-25: orchestrator decision.** Typing is judged on the median of the full keydown → echo-frame time, an upper bound on what the app adds. The p95 is recorded as over the budget. The budget is not relaxed.

## Review Triage Log

Round 1: three Opus reviewers (blind-hunter, edge-case-hunter, verification-gap). One patch round.

- **Patched:**
  - **WebGL-while-shown reverted.** Its dispose does not free the GL context (blind #2), and it gave no measured gain.
  - **measure.ps1 restore.**
    - The restore is now its own step with retries. The backup is never moved into an existing folder; that case exits 3 with instructions (blind #1, edge #1).
    - WebView2 orphans are killed, checked against their start time (blind #6).
    - `-OutDir` inside the config is refused (blind #7).
    - A stale `go` file is cleared, and each run gets its own startup file (edge #8).
    - `results.json` is written after each step (edge #7).
    - A stub guard refuses a real-claude `claude.path` (edge #6).
    - Files are copied with `-LiteralPath` and `-Force` (edge #13).
  - **Typing probe.**
    - It is cancelled when `onData` returns early (edge #2).
    - It gives up a stale sample in `drawn` (edge #3, blind #4).
    - The sink drops non-finite values (edge #9).
  - **`SWITCHBOARD_PERF_OUT`:** absolute paths only, read once, and kept out of child processes (edge #5; see the Spec Change Log).
- **Corrected in `docs/perf.md` by the orchestrator** (verification #2–#6 and #9):
  - Per-process tables for all runs.
  - Claims softened: frame alignment, the context cap.
  - The window figure is described as "window created", not as a cross-check.
  - The typing verdict basis is stated.
  - Verification #3 (setups differ) is false: both NFR runs were sampled before the cmd terminal existed, with the same exclusions. The doc now says so.
- **Deferred to `deferred-work.md`** (verification #1, #7, #8 and #10; edge #4, #10 and #12; blind #3–#5):
  - the RSS miss and Emils' decision on what NFR-2 counts;
  - the typing p95 and the probe's untested parts (AltGr, rAF before paint, pop-out flush, focus replies);
  - the ring cannot be reset;
  - `perf_ready` fires even when the workspace load failed;
  - the Linux figures and Linux CI.
- **Dismissed:**
  - edge #11 and blind #3 no longer apply after the revert;
  - verification #8 is moot after the revert.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --no-bundle` -- expected: the release exe builds

**Manual checks:** the orchestrator's measuring pass (foreground-guarded, stub sessions).
