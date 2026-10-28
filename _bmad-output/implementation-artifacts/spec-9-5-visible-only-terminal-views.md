---
title: 'Story 9.5: Rendered terminal views only while shown'
type: 'feature'
created: '2026-10-28'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'a1bad031ca727592ebe8aee54b233b73bde6b826'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
  - '{project-root}/docs/perf.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** NFR-2 (app's own share < 150 MB idle) misses once sessions have output: 10 sessions with full 5,000-line scrollback measure 282 MB, almost all in the WebView2 renderer. Each terminal keeps a full rendered xterm view (DOM, WebGL, scrollback) whether shown or not (`docs/perf.md`, deferred-work 9.3).

**Approach:** Only a terminal that is on screen has a full rendered view. A hidden terminal keeps a "shadow": an unopened xterm `Terminal` with no element, no renderer and no scrollback, fed live output so it can answer the program's queries. When the terminal is shown, its full view is rebuilt from Rust's 2 MiB `term_buffer` ring, using the replay path that already exists. When it is hidden, the full view is disposed and a shadow is rebuilt the same way.

**Decision — replay trim** (Emils, 2026-10-28, after the first measurement: 190.6 MB, of which ~27 MB was replay garbage V8 left uncollected): every terminal keeps its shadow for as long as its PTY lives, also while shown. While a full view exists the shadow is silent (it parses but does not answer; the full view answers). Hiding disposes the full view and lets the shadow answer: no replay on hide. Only showing replays (into the new full view). Then re-measure 10 sessions and the 3-session NFR setup with full scrollback, and record the results as they come out.

**Decisions** (Emils, 2026-10-28: "run it as a story" on the view-per-visible-terminal proposal; details by the orchestrator, for his review):
- **What a switch costs.** Switching to a terminal costs one replay of up to 2 MiB. Its scroll position and selection reset to the bottom.
- **History after a switch.** After a switch, the history shown is whatever the 2 MiB ring holds, capped at 5,000 lines. For plain shells that is the full 5,000 lines. A TUI that redraws heavily may show fewer.
- **Why a shadow and not nothing.** ConPTY is created with `PSEUDOCONSOLE_INHERIT_CURSOR` (portable-pty 0.9), so it sends a cursor-position query (DSR) at start and waits for the reply. Other programs query device attributes too. A hidden terminal must keep answering, so the shadow parses the live output at the PTY size.

## Boundaries & Constraints

**Always:**
- **Who answers queries.** Exactly one model per terminal answers queries in a window: the full view or the shadow, never both. The existing rules carry over to whichever model it is: no answers while replaying, and none in the main window while the terminal is popped out.
- **Where output goes.** Live output that arrives during a rebuild queues and is applied after it, with the byte-offset de-duplication. No chunk is lost or doubled.
- **Pop-out window.** A pop-out window's single terminal always has a full view. Its behaviour does not change.
- **Restarts and reloads.** Restart (`resetView`), resume and re-run (`disposeView` + `restore`), return-from-pop-out (`returned`) and reload (`connectTerminals`) work on whichever model exists.
- **What still works.** The typing probe, the WebGL fallback, fit/resize and `term_resize` ownership work as today on the full view.

**Never:**
- **No Rust changes**, and no change to the ring size or to `term://data`.
- **No new npm dependency.** Do not add `@xterm/headless`. The xterm 6 `Terminal`, left unopened, is the shadow.
- **Don't drop shadows.** No hidden terminal is ever left without a model while its PTY lives.
- **No version-bump loop.** A show or hide swap must not bump the view version that `useHostedView` keys on, or the layout effect would hide what it just showed.
- **Scrollback stays at 5,000.** Do not lower `SCROLLBACK`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Show | Hidden terminal with output; its tab is activated | The shadow is disposed. A full view is created in the pane, replays the ring with answers suppressed, then follows live output | `termBuffer` fails → the view starts empty and follows live output; logged |
| Hide | Shown terminal; another tab activated or the pane hidden | The full view (element and WebGL) is disposed. The shadow replays the ring and follows live output | Same as Show |
| Query while hidden | The program sends `ESC[6n` / `ESC[c` while the terminal is hidden | The shadow's reply reaches `termWrite` once | Popped out in the main window → no reply |
| Output during a swap | `term://data` arrives mid-rebuild | Queued, then applied after the replay, minus what the ring covered | — |
| Start hidden | A session is launched while the pane shows another terminal | It gets a shadow at the PTY size (`terminalInfo`); ConPTY's start-up query is answered | No holder → queued in `early`, as today |
| Rapid toggles | Show, hide and show again before a replay ends | The final state is right: one model, offsets consistent, no stale replay writes into a disposed model | — |

</frozen-after-approval>

## Code Map

- **`src/terminal/registry.ts` (the whole change).**
  - **`View`, `views`, `createView`.** Split today's single model into the full view (opened in an element, with fit, WebGL, the probe and the key handler) and the shadow (`new Terminal({ scrollback: 0, cols, rows, allowProposedApi, windowsPty })` plus Unicode11, never opened, with an `onData` that follows the same suppression rules).
  - **`showView` / `hideView`** become the swap points.
  - **`ensureView` / `writeIncoming`** create a shadow, not a full view, for a terminal that is not shown.
  - **`restore`** replays into whichever model exists.
  - **`hasView`** means "has a model".
  - **`viewRenderer`** returns `null` for a shadow.
  - **`resetView`, `disposeView`, `focusView`, `fitView`, `markSent`, `forgetSentSize`, `returned`** handle both kinds (a shadow has no fit: `returned` resizes it via `term.resize`).
- **`src/terminal/TerminalPane.tsx` (`useHostedView`).** Show and hide already go through `showView` and `hideView`. Keep it untouched unless the version loop forces a change. `TerminalHolder` stays: the full view is created inside it before it moves.
- **`src/terminal/registry.test.ts`.** The `FakeTerminal` mock is already there. Extend it: record `open()` calls and count the live instances.
- **`src/commands/terminal.ts`, `sessions.ts`, `edges.ts`.** These are callers of `resetView`, `disposeView` and `restore`. Their API stays the same; don't change them.
- **`docs/perf.md`, `deferred-work.md`.** The orchestrator updates the figures after measuring. The implementer leaves them alone.

## Tasks & Acceptance

**Execution:**
- [x] `src/terminal/registry.ts` -- add the shadow model and full view swap as mapped above. Update the header comment so it describes the shadow and full view life cycle -- the memory fix.
- [x] `src/terminal/registry.test.ts` -- cover every Matrix row, plus:
  - only the shown terminal's model is `open()`ed;
  - a shadow forwards a query reply exactly once, and none while popped out or replaying;
  - disposal on hide;
  - the toggle race;
  - no version bump on show or hide;
  - restart and return-from-pop-out on a hidden terminal.
  -- the regression guard.

**Acceptance Criteria:**
- Given 10 terminals, one shown, when the registry is inspected, then exactly one xterm instance has been `open()`ed and the other nine are scrollback-0 shadows.
- Given the release build and the 10-session full-scrollback pass (`s93b/pass.sh` with `stubfill`), when the orchestrator measures, then the app's own working set is below 150 MB, or the miss is recorded with its figures.
- Given the existing suites, when they run, then all pass with no edits to tests outside the terminal folder.

## Implementation Notes

- **Unopened xterm answers queries: confirmed.** A throwaway node script (scratchpad, not in the repo) built `new Terminal({ scrollback: 0, cols: 100, rows: 30, allowProposedApi: true, windowsPty })` from `@xterm/xterm` 6.0.0, never opened, wrote `ESC[6n` and `ESC[c`, and got `ESC[2;6R` and `ESC[?1;2c` through `onData`.
- **Version bumps.** Only `disposeView` bumps the version now. Making a model (`ensureView`) no longer does: a terminal shown before it had a model gets its full view directly in `showView`, and one shown before the holder mounted gets it in `setHolder` (the pane's `hosts` map remembers where). `TerminalPane.tsx` is untouched.
- **Stale replays.** `restore` takes a per-terminal sequence number; `disposeView` and every later `restore` (each swap calls it) bump it. A stale buffer is dropped and does not drain the queue, which the newest replay owns.
- **`sent` survives a swap**, so showing a terminal again at the same size sends no `term_resize`.
- **WebGL context.** Disposing a full view that used WebGL also calls `WEBGL_lose_context` on its canvases, since the addon's dispose leaves the context alive until GC (Story 9.3's trial finding). Every show/hide now creates and drops a context, so leaking them would add up.
- **Pop-out window.** Its terminal is always full (`only === id`); `hideView` there still moves the view into the holder.
- **Test changes inside `src/terminal/`.** Tests that relied on hidden full views (the version test, `syncSize`, the pop-out return, `openProjectTerminal`, typing) now show the terminal first. The version test now expects bumps only on disposal.

- **Replay trim (follow-up, after the 190.6 MB measurement).** The registry now holds a slot per terminal, `{ shadow, full, sent }`. The shadow lives until `disposeView`, also while the terminal is shown, and is fed all live output. It stays silent while a full view exists. `hideView` only disposes the full view, so the shadow answers again with no `term_buffer` call. `showView` makes the full view and replays the ring into it alone; the shadow is untouched.
  - **Per-model queues and offsets.** Each model keeps its own `pending` queue and `offset`, so the shadow never waits for the full view's replay. A model-level replay number replaces the per-terminal counter: a replay skips a model that was disposed or taken over by a later replay.
  - **`restore` and the other paths.** `restore` (reload, resume, return from a pop-out, edge restart) replays into every model the terminal has. `resetView` resets both and `disposeView` disposes both.
  - **Shadow size.** `syncSize` and `markSent` resize the shadow to the PTY size. `returned` resizes both models.
  - **Pop-out window.** It has no shadow; its full view answers.
  - **Acceptance-criterion wording.** With 10 terminals and one shown, there are now 10 scrollback-0 shadows plus one opened full view, not nine shadows. One xterm is still the only one ever opened.
  - Re-verified: tsc clean; vitest 705/705; cargo test 610 passed; clippy clean; release build OK.

- **Review fixes.**
  - `setHolder` sizes (`syncSize`) a terminal that was shown before the holder mounted.
  - Shadows follow the store's `cols` / `rows` through a store subscription in `connectTerminals`, so a hidden session's shadow is no longer stuck at 80x24.
  - A pop-out window drops the shadow its first `showView` made once `only` is set.
  - `disposeView` forgets the host.
  - `hideView` blurs only in the pop-out branch.
  - Comments updated in `TerminalPane.tsx`, `shell.css` and `state/terminals.ts`.

- **Answer hand-over (after the GUI-pass hang).**
  - **Probe.** A throwaway node probe on `@xterm/xterm` 6.0.0 (scratchpad `s95-handover-probe`, not in the repo) confirmed two things:
    - an empty write's callback runs in order between the neighbouring writes, including across a 200 KB chunk;
    - the `onData` reply from parsing the next chunk fires after that marker's callback.
  - **Decision at arrival.** `writeIncoming` picks the owner of each chunk when it arrives, through `owner(slot)`:
    - the full view when it is live (no replay pending), or when there is no shadow (a pop-out);
    - otherwise the shadow.
  - **Carrying the decision.** Each model gets the decision through `mark(view, on)`, which writes `term.write("", () => view.answers = on)` only when the queued value changes. `forward` sends only while `answers` holds (popped-out rule unchanged). The old `replaying` flag and the "shadow silent while a full view exists" check are gone; the flag covers both.
  - **Replay.** The replay buffer is written after `mark(false)`. Each drained chunk keeps the decision made at its arrival. A full view then gets `mark(true)` (it is live, so typing goes out).
  - **Output that waited before any model existed** (a reload's late terminals) is answered by the shadow, or by the full view when there is no shadow.
  - **Gap left on hide.** A chunk the full view owned but had not yet parsed when `hideView` disposed it loses its answer: the shadow got it marked false. This window is sub-millisecond (xterm parses within a frame); recorded and not fixed, per the Design Notes.
  - **Test fake.** It now keeps an ordered write queue, and `parse(chunk, reply)` runs the earlier markers first. Marker writes are not recorded in `written`.

**Orchestrator verification (2026-10-28, final build).**
- **Checks.** `tsc` clean; vitest 715/715; `cargo test` 610 passed; clippy clean; `npm run tauri build -- --no-bundle` built.
- **GUI passes** (foreground-guarded, stub sessions):
  - all 10 sessions start (none stuck `starting` after the hand-over fix);
  - a hidden session replays its full history when its tab is shown.
- **Memory** (`docs/perf.md`):
  - 10 sessions with full scrollback: 183.5 MB (282 MB before), MISS;
  - 3 sessions: 150.3 MB, on the line, marginal MISS.
  - Recorded as allowed by AC 2.
- **Not checked.** Linux CI is pending; GitHub Actions is suspended until month end.

## Spec Change Log

- **2026-10-28, orchestrator (GUI pass after review round 1; for Emils' review).**
  - **Trigger.** In the 10-session pass, one of 10 sessions stayed `starting`, meaning Rust never saw its first output. This matches Triage #11: ConPTY's start-up DSR was answered by nobody.
    - Which model answers was decided when xterm parsed the output (async), not when the output arrived.
    - A query that arrives just before or during a show is parsed by the shadow after the full view exists, so the shadow stays silent. The full view then suppresses the query as part of its replayed buffer, and the de-duplication drops the queued chunk.
  - **Amended.** Design Notes, "Answer hand-over".
  - **Known-bad state avoided.** A session that hangs at start (or any program waiting for a reply) whenever its query meets a show.
  - **KEEP.**
    - Everything else in the current registry: the shadow and full-view slots, no replay on hide, per-model queues and offsets, the stale-replay counter.
    - The review-round-1 fixes: setHolder fit, shadow following the store size, no shadow in the pop-out, `hosts.delete`, the WebGL release and its test.
    - The version-bump rule.

## Review Triage Log

Review pass 1 (blind-hunter, edge-case-hunter, verification-gap; diff a1bad03..working tree):

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind, edge (x3) | `setHolder` makes a hosted terminal's full view but never fits/sizes it (creation no longer bumps the version) | medium | `App.tsx` renders `TerminalPane` before `TerminalHolder`, so the pane's layout effect runs with no holder; only a later ResizeObserver / info effect would fit. Replay is not lost (no slot can exist before a holder; reload replays via `connectTerminals`). patch: `syncSize` in `setHolder` |
| 2 | blind, edge | Shadow made before its info arrives stays 80x24 while hidden | medium | Session / agent terminals never call `markSent` (only `commands/terminal.ts` does); shadow answers DSR at a wrong size. patch: shadows follow the store's info size |
| 3 | edge (x2) | Pop-out window also gets a shadow (layout-effect `showView` runs before `connectTerminals` sets `only`) | low | `TerminalWindow.tsx`: `useHostedView` layout effect precedes the connect `useEffect`; each restore replays into it too. patch: drop it once `only` is set |
| 4 | edge | `disposeView` leaves `hosts` holding the id | low | A late `writeIncoming` / `restore` would rebuild a full view into the stale host. patch: `hosts.delete` |
| 5 | verification-gap | `disposeModel`'s WebGL context release is never exercised | medium (pre-verified) | Fakes never reach `renderer === "webgl"`. patch: test with stubbed `WebGL2RenderingContext` and canvases |
| 6 | blind | Stale comments (`TerminalPane.tsx`, `shell.css`, `state/terminals.ts`, registry header "DOM for the rest of its life"); the history trade-off unstated in code | low | Comments describe views living in the holder. patch: comments |
| 7 | blind | Tests compare instance arrays with `toEqual` | low | Structural equality cannot prove identity. patch: `toBe` per element |
| 8 | blind | Missing cases: `focusView` on a shadow, `hideView` with no shadow | low | Untested branches. patch: tests |
| 9 | blind | `blur()` before disposal is pointless | low | patch: only on the pop-out branch |
| 10 | blind, edge | A `term_buffer` that never settles leaves a shown terminal silent | false | `term_buffer` is a synchronous Rust ring copy behind `invoke`; nothing shows it can hang rather than reject (a rejection drains the queue and the view answers) |
| 11 | (orchestrator, from 10) | A query arriving around a show is answered by nobody | high (verified in the GUI pass) | Was maybe-false and deferred. Then the 10-session pass left one session `starting` (no output: ConPTY's DSR was never answered). Fixed by the answer hand-over (Spec Change Log 2026-10-28); the deferral was withdrawn |
| 12 | blind | `disposeModel` calling `getContext("webgl2")` could create a context on a context-less canvas | maybe-false (low) | The view's canvases are xterm's own (WebGL or 2D; a 2D canvas returns null). Rejected as low |
| 13 | blind | Shadows carry unused fields (probe, fit, element) | low | No named harm beyond style; rejected (fix adds a second type through every path) |
| 14 | blind | Nothing measures the memory goal | false | AC 2: the orchestrator's `measure.ps1` 10-session pass, recorded in `docs/perf.md` |
| 15 | blind | `ensureView` still exported, returns a shadow | low | Only tests call it; rejected |
| 16 | blind | StrictMode double effect / restore racing `showView` untested | low | Rejected: stale-replay counter tested; rejected as low with no shown failure |

## Design Notes

**Why both kinds are xterm instances.** The xterm `Terminal` core (parser and `InputHandler`) answers DSR and DA through `onData` without `open()`. Because both kinds are xterm instances, query answering is identical in both states. If an unopened xterm 6 `Terminal` turns out not to emit replies before `open()`, say so in Implementation Notes and halt. Do not work around it.

**How a swap runs.** Reuse `restore`:
1. Mark the terminal as replaying, so live output queues.
2. Dispose the old model.
3. Create the new model.
4. Fetch `termBuffer`.
5. `reset()`, write with answers suppressed, then set `offset`.
6. Drain the queue.

Guard against an earlier swap's late `termBuffer` result: compare a per-terminal swap counter and drop stale results.

**Answer hand-over (Spec Change Log 2026-10-28).**
- **When the answerer is decided.** For each output chunk, decide at arrival time (in `writeIncoming` or `feed`) which single model answers the queries in it.
  - The full view answers once it is live: it exists, has no replay in flight and has no queued backlog.
  - Otherwise the shadow answers.
- **How the decision travels.** Carry the decision through each model's own ordered write queue. Before writing the chunk, write `term.write("", () => { model.answers = model === owner })`. xterm runs write callbacks in order, so the flag is right while that chunk is parsed. `forward` sends only when `answers` holds; the replay and pop-out rules still apply.
- **Replay and backlog.** The replayed buffer, and the backlog drained into the full view after it, are written with `answers` false: the shadow already answered them when they arrived.
- **The gap left on hide.** A chunk the full view owned but had not parsed when it was disposed loses its answer. This window is sub-millisecond; record it, do not fix it.
- **Test.** A query chunk that arrives between `showView` and the `termBuffer` resolve, and one that arrives just before `showView` but is parsed after it, are each answered exactly once.

## Verification

**Commands:**
- `cargo test`, `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) -- expected: unchanged, green
- `npx tsc --noEmit` -- expected: no errors
- `npx vitest run --root /b/projects/ide` -- expected: all pass
- `npm run tauri build -- --no-bundle` -- expected: builds

**Manual checks:**
- **GUI pass (orchestrator, foreground-guarded).** Switching tabs shows the replayed history. A hidden stub session still starts, so ConPTY's query was answered. Typing echoes.
- **Memory.** The 10-session full-scrollback measurement is recorded in `docs/perf.md`.
