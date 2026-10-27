# Performance budget

Story 9.3. The product promises a light tool; these are its budgets (NFR-1..3), how they are measured,
and what was measured. Budgets are never relaxed here: a miss is recorded with its cause and a follow-up
in `_bmad-output/implementation-artifacts/deferred-work.md`.

| Budget | Limit | Where |
|---|---|---|
| Cold start to an interactive canvas | < 1 s (< 2 s on a cold Linux laptop) | dev machine, NFR setup |
| Idle RSS of the app's own share, not counting `claude` | < 150 MB | dev machine, NFR setup, 60 s idle |
| Added terminal typing latency | < 16 ms | dev machine, a plain shell terminal |

**NFR setup:** 5 projects on the canvas and 3 live sessions with their terminals open. Sessions are **stub**
sessions only (a stub `claude` named by `claude.path` in the scratch `settings.json`); the real `claude` is
never run and nothing is written under `~/.claude`.

## Measuring points (in the app)

Always on, memory only, nothing logged and nothing sent anywhere. Settings (`ctrl+,`) → Diagnostics →
**Performance** shows them, re-read every 2 s while the pane is open.

- **`startup: N ms`.** Rust takes an `Instant` as the first thing `run()` does (`perf::mark_process_start`).
  The canvas mounts its flow only once the workspace snapshot is in; after its first frame has been painted
  (a `requestAnimationFrame`, then a task) the frontend calls `perf_ready` once, and Rust keeps the elapsed
  time (only the first call counts). This is process start → first canvas frame with the workspace loaded and
  the canvas taking input. It does not include the OS loader and Rust's start-up before `main`. The script's
  outside figure (window created) is not a cross-check of the canvas time: the window exists long before its
  content, so it only shows that window creation is not the slow part.
- **`typing: median N ms · p95 M ms`** over the last 100 keystrokes, or `typing: not enough samples` below 5.
  Each terminal view stamps a printable keydown (no ctrl/alt/meta, not composing; `event.timeStamp`), notes
  when xterm has sent its data to the PTY (`term_write`), takes the next output for that terminal as the
  echo, and closes the sample in the animation frame requested once xterm has parsed the echo, which runs
  right after xterm's own render of it. So a sample is keydown → PTY write → echo drawn. One keystroke is
  timed at a time; keys typed while one is in flight are not sampled. A sample is given up when the echo, or
  the frame drawing it, comes more than 1 s after the keydown (frames are held while the window is hidden),
  and a stamped key whose data goes nowhere (the view is replaying, or the terminal is popped out and this is
  the main window) is forgotten, so a later key cannot close a sample timed from it. Samples go to Rust's ring
  (`perf_typing`) in batches a second after the last one, so pop-out windows count too; a non-finite value is
  dropped before sending.
- `perf_get` returns both (`{ startup_ms, typing: { samples, median_ms, p95_ms } }`).
- For the script only: with the environment variable `SWITCHBOARD_PERF_OUT` naming a file by an **absolute**
  path, the first `perf_ready` also appends `{"startup_ms":N,"pid":P}` to it. Unset, empty or relative (always
  unset outside the script), nothing is written. `run()` reads the variable once, first thing, while the
  process still has only its main thread, and removes it from the environment, so no child (shells, sessions,
  `git`) inherits it. Removing it there rather than at each spawn site covers every child, including ones
  added later.

## Method

### Build

The release build without installers: `npm run tauri build -- --no-bundle` →
`src-tauri/target/release/switchboard.exe`.

### Scratch config

The app always reads `%APPDATA%\switchboard` (the Known Folder; setting `APPDATA` does not move it), so the
script moves the real folder aside for the run and puts it back afterwards, and only when told to
(`-SwapRealConfig`). Prepare a scratch config folder holding:

- `settings.json`: `claude.path` pointing at the stub `claude` by an absolute path, `close_to_tray: false`
  (closing quits, which the start runs rely on), `notifications.*: false`, `shell` a plain `cmd` or `pwsh`.
  The script refuses to run (even with `-DryRun`) unless `claude.path` is set, absolute and an existing file
  that does not resolve, directly or through a link, to `%USERPROFILE%\.local\bin\claude.exe`: a guard
  against running the real `claude`.
- `workspace.json` with the 5 projects (scratch folders, git repos or not). The simplest way to get one: run
  `-Step Session` with a scratch folder holding only `settings.json`, add the 5 folders (`ctrl+o`) while the
  script waits, continue through both prompts, and use the `<OutDir>\config-after` folder the script keeps (the
  config as the app left it) as `-ConfigDir` for the measured pass. Or write it by hand following the README's
  [The file](../README.md#the-file).

### Running the script

From the repo root, in a foreground-guarded GUI pass (the script launches the app, the operator drives it):

```powershell
# Plan only: launches nothing, moves nothing.
powershell -ExecutionPolicy Bypass -File scripts\perf\measure.ps1 -Exe src-tauri\target\release\switchboard.exe -ConfigDir <scratch config> -DryRun

# Everything: 5 cold starts, then one session for idle RSS and typing.
powershell -ExecutionPolicy Bypass -File scripts\perf\measure.ps1 -Exe src-tauri\target\release\switchboard.exe -ConfigDir <scratch config> -SwapRealConfig -Step All
```

Options: `-Step Start|Session|All`, `-Runs 5`, `-IdleSeconds 60`, `-StartTimeoutSeconds 20`, `-OutDir <folder>`
(default a new `%TEMP%\switchboard-perf-<time>`; refused inside `%APPDATA%\switchboard` or its backup). The
script refuses to start while `switchboard.exe` runs, or when a `switchboard.perf-backup` from an interrupted
run is still there (that folder is the real config: put it back by hand). A leftover `<OutDir>\go` is deleted
at start. The scratch config's files are copied in by literal path with `-Force` (hidden files included).

The real config is restored in a `finally`, also on error or Ctrl+C, in this order:

1. The app and every `msedgewebview2.exe` captured in its process tree at launch are killed if still alive.
2. What the app left in the scratch copy is kept as `<OutDir>\config-after`.
3. The scratch copy is deleted, retrying for about 10 s (a killed app's watcher or antivirus may still hold it).
4. Only once `%APPDATA%\switchboard` is gone is the backup renamed back.

If the scratch copy cannot be removed, the backup is never moved into it. The script prints a boxed
**REAL CONFIG NOT RESTORED** message saying where the real config is (`switchboard.perf-backup`) and the two
commands that put it back, and exits with code 3.

- **Cold start (`Start`).** Five runs. Each starts a fresh process with `Start-Process` and records:
  - **window**: `Start-Process` → the main window titled `Switchboard` first appears (`MainWindowHandle`; WebView2 helper windows come first and are skipped), from the outside;
  - **in-app**: the `startup` value, from the `SWITCHBOARD_PERF_OUT` line in a fresh
    `<OutDir>\startup-runN.jsonl` per run (absolute path), so no line from an earlier process can match.

  Then it closes the window (`WM_CLOSE`; the app is killed after 10 s) and waits for the WebView2 processes
  to go, killing any from the tree captured at launch that are still alive, even when the app itself has
  already exited. So each run is a fresh process. "Cold" means a fresh process: the OS file cache may be warm (the exe
  and WebView2 were just run), and the reported numbers are for that warm-cache case. The median of the in-app
  values is compared with the budget; the window figure only says when the empty window exists.
- **Idle RSS (`Session`).** One launch. The script waits (Enter in its console, or creating `<OutDir>\go`)
  while the operator starts 3 stub sessions with their terminals open, then waits 60 s without input and
  samples, per process, the **working set** and **private bytes** of `switchboard.exe` and the
  `msedgewebview2.exe` processes in its process tree. Everything else in the tree (`claude`, the stubs, the
  shells, `conhost`) is listed as excluded. Each WebView2 process is labelled with its role (from its
  `--type=` command-line switch).
  - **What the budget counts.** The **app's own share**: `switchboard.exe` plus the renderer process(es) running its page (Emils' decision, 2026-10-25).
  - **What is reported but not counted.** The shared WebView2 runtime processes: browser, GPU, the network and storage utilities, and crashpad. They exist whatever the page does, and are reported beside the share as the whole-tree total.
  - **Why private bytes too.** Summing working sets counts shared pages more than once, so private bytes are reported beside them.
- **Typing (`Session`, after RSS).** The script waits again while the operator focuses a **plain shell
  terminal** (`cmd` / `pwsh`, so the echo comes from a real program), types 50 printable keys at an ordinary
  pace, and reads `typing: median · p95` in Settings → Diagnostics. The number is the **full** keydown → echo
  drawn time: it includes the shell's own echo time (ConPTY and the shell), which a native terminal pays too,
  so it overstates what the app adds. Then the operator continues and the script closes the app.

Raw results land in the out folder: `results.json` (rewritten after each step, so the `Start` results survive
a failed `Session`), the `startup-runN.jsonl` files and `config-after`.

## Results

### Windows dev machine

**Machine:** AMD Ryzen 7 7800X3D (8 cores, 16 threads), 31.2 GB RAM, Windows 11 Pro 10.0.22631 (build 22631)
**Build:** release, `npm run tauri build -- --no-bundle`, exe about 8.7 MB. The measured build has the measuring points as shipped. The review fixes that followed are small changes to the probe's edge cases and to the script, not to the app's start-up, memory or drawing.
**Measured:** 2026-10-25, by the orchestrator (Claude) in a foreground-guarded GUI pass. Setup: 5 projects and 3 stub sessions with their terminals open.

Two builds were measured: the shipped one, and a trial build where terminals held WebGL only while on screen. The trial gave no gain and was reverted (see the misses below). Its numbers are kept for comparison.

**Cold start** (budget < 1000 ms, median of the in-app value):

| Run | In-app startup (ms) | Window created (ms) |
|---|---|---|
| 1 | 450 | 70.3 |
| 2 | 446 | 54.3 |
| 3 | 460 | 53.6 |
| 4 | 447 | 41.5 |
| 5 | 421 | 54.5 |
| **Median** | **447** | **54.3** |

Trial build: 478, 491, 448, 469 and 437 ms, a median of 469 ms (window created at a median of 55.0 ms).

Final build after the review patch round, run with the patched script: 528, 420, 432, 466 and 455 ms, a median of **455 ms** (window created at a median of 54.6 ms). The real config was restored and nothing was left running.

**Idle RSS** after 60 s idle (budget < 150 MB working set of the app's own share, `claude` excluded). The shipped build:

| Process | Working set (MB) | Private bytes (MB) |
|---|---|---|
| switchboard.exe | 27.0 | 8.5 |
| msedgewebview2.exe (browser) | 104.4 | 32.4 |
| msedgewebview2.exe (renderer, the page) | 98.1 | 47.4 |
| msedgewebview2.exe (GPU) | 70.1 | 135.3 |
| msedgewebview2.exe (network service) | 34.8 | 11.1 |
| msedgewebview2.exe (storage service) | 18.3 | 7.1 |
| msedgewebview2.exe (crashpad handler) | 11.0 | 3.1 |
| **App share** (switchboard.exe + renderer) | **125.1** | **55.9** |
| Whole tree (reported, not budgeted) | 363.7 | 244.9 |

Excluded: 3 × `stubclaude.exe`, 3 × `conhost.exe`.

For comparison, per process (MB, working set / private), each sampled after 60 s idle on the same machine.
Both NFR-setup runs were sampled with the 3 stub sessions only (excluded 3 × `stubclaude.exe`, 3 × `conhost.exe`), before the cmd terminal for the typing step was opened:

| Process | 5 projects, no sessions | NFR setup, shipped build | NFR setup, trial build (WebGL while shown) |
|---|---|---|---|
| switchboard.exe | 25.6 / 7.7 | 27.0 / 8.5 | 28.4 / 10.5 |
| browser | 99.5 / 30.9 | 104.4 / 32.4 | 104.4 / 32.2 |
| renderer (the page) | 69.2 / 32.6 | 98.1 / 47.4 | 101.8 / 49.9 |
| GPU | 59.0 / 81.9 | 70.1 / 135.3 | 73.3 / 130.5 |
| network service | 33.2 / 11.1 | 34.8 / 11.1 | 34.8 / 11.2 |
| storage service | 18.3 / 7.1 | 18.3 / 7.1 | 18.3 / 7.1 |
| crashpad handler | 10.5 / 3.0 | 11.0 / 3.1 | 10.4 / 2.9 |
| **Total** | **315.3 / 174.3** | **363.7 / 244.9** | **371.4 / 244.3** |

**Idle RSS with 10 sessions** (2026-10-27, shipped build, the same machine and script). Setup: 5 projects and 10 stub sessions (3 + 3 + 2 + 2 across four projects), each with its terminal tab open, sampled after 60 s idle:

| Process | Working set (MB) | Private bytes (MB) |
|---|---|---|
| switchboard.exe | 34.3 | 12.9 |
| renderer (the page) | 104.4 | 57.3 |
| **App share** | **138.7** | **70.2** |
| browser | 110.4 | 34.1 |
| GPU | 81.5 | 235.5 |
| network service | 36.6 | 11.1 |
| storage service | 18.3 | 7.1 |
| crashpad handler | 10.9 | 2.9 |
| Whole tree (reported, not budgeted) | 396.4 | 360.9 |

Excluded: 10 × `stubclaude.exe`, 10 × `conhost.exe`.

- **The app share passes with 11 MB to spare.** It went from 125.1 MB at 3 sessions to 138.7 MB at 10, about 2 MB per extra session. At that rate the budget would be reached at roughly 15 to 16 sessions; that is an estimate, not measured.
- **The GPU process** (not budgeted) grows the most: 135 → 236 MB private, about 14 MB per extra terminal. That fits one WebGL context per terminal.

**Typing** (budget < 16 ms added; plain `cmd` terminal, 50 keys typed at about 8 keys/s):

| Build | Samples | Median (ms) | p95 (ms) |
|---|---|---|---|
| shipped | 50 | 15.4 | 16.2 |
| trial (WebGL while shown) | 50 | 15.4 | 20.0 |

One pass of 50 keys per build; the p95 of 50 samples rests on about 3 keystrokes, so the difference between the two builds is not established either way.

**Pass / fail:**

| Budget | Measured (shipped build) | Result |
|---|---|---|
| Cold start < 1 s | median 447 ms in-app (window created at 54 ms) | **PASS** |
| Idle RSS < 150 MB (app share) | 125.1 MB working set (55.9 MB private); whole tree 364 MB | **PASS** |
| Typing < 16 ms added | median 15.4 ms, p95 16.2 ms (full keydown → echo frame, including the shell's echo) | **PASS** on the median (0.6 ms to spare); p95 **over** |

The typing verdict is based on the median of the full time, an upper bound on what the app adds. The p95 is recorded as over the budget.

**Misses, causes, follow-ups:**

- **Idle RSS: a pass on the app share, with 25 MB to spare.**
  - The trial build's share was 130.2 MB. With no sessions open it is 95 MB.
  - Before Emils' decision, the budget was compared with the whole tree, which missed: 364 MB.
  - What the whole tree contains:
    - With 5 projects and no sessions, the total is already 315 MB working set (174 MB private). `switchboard.exe` is 26 MB of that, and the page's renderer 69 MB.
    - The browser, GPU, network, storage and crashpad processes make up the other 220 MB.
    - The 3 sessions with their terminals add 48 to 56 MB working set and about 70 MB private. That growth is mostly the GPU process (+53 MB private) and the renderer (+15 to 17 MB private).
- **Budget fix tried and reverted: WebGL only while a terminal is on screen.**
  - The trial build dropped a hidden terminal's WebGL addon and loaded it again on show.
  - Measured with the same setup: GPU private 135.3 → 130.5 MB, total private 244.9 → 244.3 MB. That is within noise, so there was no gain.
  - Review found why: the addon's dispose removes its canvas but does not lose the GL context, so each hide/show cycle would have left a live context behind until garbage collection.
  - Reverted. Terminals load WebGL once, as before.
- **Follow-ups** (in `deferred-work.md`):
  - WebView2 options. `MemoryUsageTargetLevel` low while the window is hidden or minimized helps the tray case, not the foreground budget. Browser flags that drop optional services need care.
  - The app share grows with open terminals: 125 MB at 3 sessions, 139 MB at 10 (measured 2026-10-27, above), about 2 MB per session. Around 15 to 16 sessions would reach the budget (estimate). Levers if that matters: the renderer's per-terminal cost (scrollback, xterm buffers) and the 10,000-line scrollback default.
  - Typing p95 over 16 ms (16.2 ms shipped; 20.0 ms on the trial build), cause not established. A longer typing pass would give a steadier p95.
- **Typing: what the number contains.**
  - It includes the shell's own echo (ConPTY and `cmd`).
  - It also includes the wait until the next animation frame (up to 16.7 ms at 60 Hz).
  - How much of each, and what the app itself adds, was not separated. A Windows Terminal baseline with the same shell would do that.

### Linux laptop

Not measured yet (left for Emils): the cold-start budget there is < 2 s. The script is Windows-only; on Linux,
read `startup` and `typing` in Settings → Diagnostics after a fresh launch, and the RSS of the app and its
`WebKitWebProcess` / `WebKitNetworkProcess` children with `ps -o pid,rss,comm --ppid <pid>` (plus the app itself).
