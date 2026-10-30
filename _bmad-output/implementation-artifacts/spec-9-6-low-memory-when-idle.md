---
title: 'Story 9.6: WebView2 low memory target while idle'
type: 'feature'
created: '2026-10-28'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '8d8ba2da3db320ad158392a9fcd38396a0196782'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/docs/perf.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** NFR-2 (app's own share < 150 MB working set, idle) still misses with full scrollback after Story 9.5. The figures are 183.5 MB with 10 sessions and 150.3 MB with 3.

A trial build that set WebView2's `MemoryUsageTargetLevel` to Low at startup measured 148.1 MB and 69.9 MB. Private bytes did not change (WebView2 trims pages out of RAM), and typing latency was unchanged (median 15.3 vs 15.4 ms).

**Approach:** Set the level to Low while the app is idle and back to Normal as soon as it is used. Idle means no app window is focused (unfocused, minimized, hidden to the tray), or a window is focused but has had no keyboard, pointer or wheel input for 30 s. Normal returns on the next input or focus.

**Decisions** (Emils, 2026-10-28: "Low when idle", the recommended option, over "Low always" and "don't ship"):
- **Idle threshold.** 30 s with no input.
- **Which windows.** All of the app's webview windows (main and pop-outs) get the same level.
- **On Linux.** WebKitGTK has no equivalent, so the switching is a no-op there.

## Boundaries & Constraints

**Always:**
- **One owner.** Rust owns the state and is the only caller of the WebView2 API.
- **No redundant calls.** The level is applied only when it changes.
- **Input in any window counts.** Activity in any app window, pop-outs included, counts as use.
- **Diagnostics shows the level.** Settings → Diagnostics → Performance shows the current level: `memory target: normal` / `low`, or `not supported` off Windows.

**Never:**
- **No user setting** and no new permission.
- **No `Low` while the app is in use.** The app must not stay at `Low` once input or focus has arrived; Normal comes back on the first input or focus event.
- **No more IPC than once per second.** Activity reports from the frontend are throttled to at most one call per second per window. Typing must not cost one IPC per key.
- **No other behaviour changes.** Do not touch the terminal registry or any other app behaviour.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Idle while focused | Focused, no input for 30 s | Level → Low, once | Apply fails → logged once, state still tracked |
| Use | At Low, then a key, pointer or wheel event in any window | Level → Normal right away (that report is not throttled away) | — |
| Unfocus | All app windows lose focus (another app, minimize, tray hide) | Level → Low without waiting 30 s | — |
| Refocus | A window gains focus | Level → Normal | — |
| Main ↔ pop-out | Focus moves from main to a pop-out | No change: an app window is still focused | — |
| Steady | Continuous typing at Normal | No apply calls; at most 1 activity IPC/s per window | — |
| Non-Windows | Any | State machine runs; apply is a no-op; Diagnostics says `not supported` | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/memlevel.rs`** (new; mirror `perf.rs`'s style: a module doc, pure logic separate from the glue).
  - A pure state machine:
    - inputs: the set of focused window labels, the last activity `Instant`, and the current level;
    - `wanted(now) -> Level`, and an `apply`-on-change that goes through a trait. The tests inject a recorder and a clock.
  - A ticker thread every 1 s, started in `setup`.
  - The Windows applier: for each `app.webview_windows()`, `with_webview` → `controller().CoreWebView2()` → `cast::<ICoreWebView2_19>()` → `SetMemoryUsageTargetLevel(LOW|NORMAL)`.
  - The working trial code (it compiled): `use ::windows::core::Interface;`. Note the leading `::` — the crate has its own `mod windows`.
- **`src-tauri/Cargo.toml`.** Under `[target.'cfg(windows)'.dependencies]` add `webview2-com = "0.39"` and `windows = "0.62"`. Both are already in `Cargo.lock` as Tauri dependencies, so they build `--offline`.
- **`src-tauri/src/lib.rs`.**
  - `on_window_event`: feed `WindowEvent::Focused(bool)` for every window label.
  - `on_window_destroyed`: drop the label.
  - `setup`: start the ticker.
  - Register the new command.
- **`src-tauri/src/ipc/mod.rs`.** Add a `memory_activity` command (no arguments), which records activity and applies Normal at once when the level is Low. Extend the `perf_get` result with `memory_level: "normal" | "low" | "unsupported"`. Alternatively add a separate getter; mirror what `perf_get` does.
- **`src-tauri/src/settings/mod.rs` (`AppState`).** Holds the state, behind a `Mutex`. Hold no lock across `with_webview`.
- **`src/perf.ts`.** Add an activity reporter: capture-phase `keydown`, `pointerdown` and `wheel` on `window`, throttled to one `memory_activity` call per second. Start it in the main window (`src/App.tsx`, next to the other perf hooks) and in the pop-out (`src/terminal/TerminalWindow.tsx`).
- **`src/ipc/index.ts`.** The command wrapper and the extended `perf_get` type.
- **`src/components/diagnostics.ts` and `SettingsPane.tsx`.** The `memory target` row under Performance.
- **`docs/perf.md`.** The orchestrator records the measurements; the implementer leaves it alone.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/memlevel.rs` + `Cargo.toml` + `lib.rs` + `ipc/mod.rs` + `settings/mod.rs` -- the state machine, ticker, applier, focus wiring and command -- the core.
- [x] `src/perf.ts`, `src/App.tsx`, `src/terminal/TerminalWindow.tsx`, `src/ipc/index.ts` -- the throttled activity reporter in both windows -- the input signal.
- [x] `src/components/diagnostics.ts`, `SettingsPane.tsx` -- the memory-target row -- visibility.
- [x] Tests -- Rust unit tests covering every Matrix row with a fake clock and applier, plus the IPC command test the existing `lib.rs` command tests use; vitest for the throttle (one call per second, at most) and the diagnostics row -- regression guard.

**Acceptance Criteria:**
- Given the release build and the 9.5 measuring passes (`s95d/pass.sh`, `pass3.sh`), when the orchestrator measures after 60 s idle, then the app share is below 150 MB working set in both, and Diagnostics showed `low` while idle.
- Given the typing pass (`s95d/passT.sh`), when 50 keys are typed after the idle, then the typing median stays within 1 ms of the 9.5 build's 15.4 ms.
- Given the existing suites, when they run, then all pass.

## Implementation Notes

- **Single applier.** Events (focus, `memory_activity`) and the 1 s tick update the `Machine` under `MemLevel`'s mutex and, on a change, push the new level onto an mpsc queue while still holding it, so changes are queued in decision order. The `memlevel` ticker thread is the only consumer and the only caller of `with_webview`; no lock is held while applying. (`with_webview` runs synchronously when called on the main thread, which also delivers focus events, so applying from the event handler could reorder or deadlock.)
- **Low only on the tick, Normal at once.** An event never applies `Low`; the tick does. Losing focus counts as a last use with a 2 s grace (`UNFOCUS_GRACE`), so main → pop-out (lost, then gained) never flips the level, and unfocus reaches `Low` within ~2-3 s rather than 30 s. Gaining focus counts as use (the 30 s count restarts).
- **Throttle.** The frontend's throttle is leading-edge (first input reports at once, then at most one per 1 s). A dropped report always follows one Rust took as use less than 1 s earlier, and Rust cannot go `Low` within 2 s of a use, so no report that would bring `Normal` back is throttled away.
- **`perf_get`** now returns `ipc::PerfReport` (`PerfSnapshot` flattened plus `memory_level`); the JSON shape is the old one plus the new key.
- **Failure logging.** A `with_webview` dispatch failure is logged once by the ticker; a COM failure inside the main-thread closure is logged once through the applier's flag.

**Orchestrator verification (2026-10-28, final build).**
- **Checks.** `tsc` clean; vitest 721/721; `cargo test` 625 passed; clippy clean; release build built.
- **GUI passes** (foreground-guarded):
  - 10 sessions with full scrollback: 49.5 MB working set, PASS;
  - 3 sessions: 37.9 MB, PASS.
  - Private bytes are unchanged (115.3 / 81.7 MB).
  - Typing after the idle: median 15.3 ms, p95 16.0 ms.
  - Diagnostics: `low` after 40 s idle, `normal` right after a click.
- **Not checked.** Linux CI is pending; GitHub Actions is suspended until month end.

**Pop-out GUI pass (2026-10-30, same release build, foreground-guarded).** It settles triage row 14.
- **Setup.** One stub session, popped out with its **Pop out** button. Settings → Diagnostics stayed visible in the main window, and the pop-out kept focus throughout.
- **Active.** Pointer moves in the pop-out every 5 s, plus one key, for 47 s after the pop-out gained focus: `memory target: normal`. Without the pop-out's reporter it would have gone `low` at 30 s.
- **Idle.** Then 40 s with no input: `low`.
- **Wake.** One pointer move in the pop-out: `normal` within 3 s.

## Spec Change Log

## Review Triage Log

Review pass 1 (blind-hunter, edge-case-hunter, verification-gap; diff 8d8ba2d..working tree):

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind, edge (x2), vg | A webview created while Low stays at WebView2's default Normal | medium | The level is applied only on a change, so a pop-out opened without focus or input keeps Normal while Diagnostics says low. patch: the ticker applies the current level to windows not yet applied |
| 2 | blind, edge (x2), vg | Diagnostics says low/normal when the WebView2 call failed | low | The closure's errors only log; `reported()` reads the machine's level. patch: a cast failure marks the level unsupported |
| 3 | blind, edge | Two once-only failure flags give two log lines | low | Separate atomics in `Ticker` and `WebviewApplier`. patch: one shared flag |
| 4 | blind, vg | Destroying a focused window starts no grace; the wiring is untested | medium | `on_destroyed` removes the label without touching `last_use`, so a Low then Normal flip is possible. No lib test calls `on_window_destroyed` with focus. patch: destroy counts as use, plus a lib test |
| 5 | blind | Startup can go Low before the first focus | low | `Machine::new` runs when `AppState` is built. patch: reset `last_use` in `start` |
| 6 | blind | The ticker runs on Linux; the doc says it ends when the sender drops | low | `start` ignores `SUPPORTED`; the sender lives in `AppState`. patch |
| 7 | blind | A test sleeps 2 s; `supported_only_on_windows` is a tautology | low | patch |
| 8 | blind | webview2-com / windows versions are coupled to wry, which nothing documents | low | patch: comment |
| 9 | blind | Pointer movement is not counted as use | low | `ACTIVITY_EVENTS` = keydown, pointerdown, wheel. patch: add `pointermove` (throttled) |
| 10 | blind | Goes Low while a person watches output without input | false | That is the decided behaviour: idle is defined as 30 s with no input (Emils, frozen intent). Rejected |
| 11 | blind | A fixed 1 s tick instead of a computed deadline | low | One wake per second is negligible; rejected |
| 12 | blind | Each window entry point must opt in to the reporter | low | Only two window kinds exist; rejected |
| 13 | blind | TS `PerfSnapshot` vs Rust `PerfReport` names differ | low | Naming only; rejected |
| 14 | vg | The pop-out's reporter wiring is untested | medium (pre-verified) | The repo does not render components in tests. Deferred, then settled by the 2026-10-30 pop-out GUI pass (Verification notes) |
| 15 | edge | Hide-to-tray may not emit `Focused(false)` | maybe-false (low) | At worst Low arrives after 30 s instead of 2 s; rejected as low |
| 16 | vg | No automated check that `SetMemoryUsageTargetLevel` really runs | medium (pre-verified) | Needs a real WebView2. Covered by the orchestrator's measurement (renderer working set 142 to 6.8 MB). defer |

## Verification

**Commands:**
- `cargo test`, `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) -- expected: green
- `npx tsc --noEmit`, `npx vitest run --root /b/projects/ide` -- expected: green
- `npm run tauri build -- --no-bundle` -- expected: builds

**Manual checks:**
- **GUI pass (orchestrator, foreground-guarded).**
  - Diagnostics reads `low` after 30 s idle and `normal` right after a key.
  - The memory and typing passes are recorded in `docs/perf.md`.
