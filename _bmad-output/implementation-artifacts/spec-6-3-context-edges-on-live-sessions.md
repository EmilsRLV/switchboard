---
title: 'Story 6.3: Context edges on live sessions'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'c4b23e2f7d4dc44a61e8f484f8818dbd1ebf842e'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A context edge drawn from a running session does nothing until that session is restarted by hand. The edge looks like it grants access, but the session cannot see the folder. Edges must never be decorative.

**Approach:**
- When a context edge is added from a live session, Rust waits for the session to be idle and injects `/add-dir <path>` + Enter into its PTY. It then tracks the edge as `pending` → `applied` or `failed`.
- The edge inspector says which state the edge is in and always offers "Restart with flags": stop the session, then resume the same id. Story 6.2's resume already passes the session's edges as `--add-dir`.

**Decisions:**
- **Trigger.** Only a context edge whose `from` is a live session (running terminal, live state not `exited`) is injected. A project's edges stay launch defaults for future sessions (6.2). The target folder comes from the 6.2 resolver for that one edge. An unusable target (`no worktree`, `folder missing`, `not found`) is `failed` with that reason and nothing is injected.
- **Idle.** `idle` and `finished` both count as idle, as Stop treats them. If the session is not idle, the edge is `pending (waiting for idle)`. If it stays not-idle for more than 60 s, the edge is `failed (session stayed busy)`.
- **Applied signal (transcript record; Emils' decision; resolves epic open decision 2).** `/add-dir` is a local command. It writes an `Added <path> as a working directory…` stdout record to the transcript and no assistant turn, so busy/idle cycles are not used. After injecting, Rust tails the session's transcript for a `<local-command-stdout>` record newer than the injection:
  - `Added …` or `… already accessible …` → `applied`.
  - Any other stdout → `failed` with that text (ANSI stripped).
  - No record within 10 s → `failed (not confirmed)`. That also covers a choice dialog waiting for input. The app never presses further keys.
- **Operator's draft (don't inject over it; Emils' decision).** If the operator has typed into that session's terminal and not yet sent or cleared it (Enter, Ctrl+C, Ctrl+U or Retry), nothing is injected automatically. Keys pressed while the session is `waiting` (answering a dialog) do not count. The edge stays `pending (you're typing — Retry when done)`, and the draft is never touched.
- **Injection safety.** Only the single line `/add-dir <path>` + `\r` is written. A path with control characters or a newline is refused (`failed`), never written.
- **Runtime only.** Edge state lives in Rust memory, is broadcast on an `edges://live` event, and is never persisted. After an app restart the edge has no live state. The inspector then shows what the edge does at the next launch or resume.
- **Restart with flags:**
  - stops the session the way Stop does;
  - waits until it has exited;
  - resumes the same id with the 6.2 resume add-dirs.
  The edge is then `applied (restarted with flags)`. Restart needs a discovered transcript, as resume does; without one it reports that and does nothing. Failure states also offer **Retry**, which runs the injection again.
- **Deleting an edge** on a live session removes nothing from the session: Claude has no `/remove-dir`. The directory stays until the session restarts.

## Boundaries & Constraints

**Always:**
- **Rust owns the state.** Rust resolves paths, decides when to inject, and owns the edge state. The UI only renders it and calls commands.
- **No `~/.claude` writes, and the real `claude` never runs in tests.** Tests use stub programs and fake transcripts in temp dirs.
- **CI and lint.** Both CI runners stay green, and the design lint passes.

**Never:**
- Multi-line or arbitrary text injection. Injecting into a session that is `waiting` or `busy`.
- Cooperate edges (6.4). Folder targets (deferred). Project-sourced edges on already-running sessions.
- Persisting live edge state.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Idle live session | session `s` idle; add context edge `s` → project `ui` | PTY gets `/add-dir <ui>\r`; edge `pending` → `applied` once accepted | — |
| Busy, then idle | `s` busy when linked | `pending (waiting for idle)`; injects when idle | busy > 60 s → `failed (session stayed busy)` |
| Not accepted | no acceptance signal in time | `failed (not confirmed)`; inspector: Retry, Restart with flags | — |
| Unusable target | `s` → branch with no worktree | `failed (no worktree)`, nothing written | Restart still offered |
| Restart with flags | failed edge; Restart clicked | session stops, resumes the same id with `--add-dir <ui>`; edge `applied (restarted with flags)` | no transcript → message, nothing stopped |
| Session exits while pending | `s` exits before injection | pending dropped; the edge applies at the next resume (6.2) | — |
| Not a live session | edge from a historic session or a project | no injection, no live state | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `ipc/mod.rs`:
  - `edge_add` (:400) gets an after-hook. After `Ok`, if it is a context edge from a live session, start the live apply.
  - Live check: the `stop_session` pattern (:1309-1325), `terms.get(pty::session_id(id))` running plus `sessions_live` state.
  - Restart: reuse `stop_session` (:1309), then wait for `Exited`, then `resume_session` (:1404). `run_launch` refuses while running or live (:1507-1525), so the wait is required.
- `graph/mod.rs`:
  - Make `context_target` (:1810) usable for one edge: `resolve_context_targets(vec![context_target(..)], cwd)` (:1770). Resolve under the lock and canonicalise after it is released, as 6.2's P2 does.
  - Heads come from `read_live().statuses`, as in `edge_add_dirs` (ipc :1009).
- `claude/live.rs`:
  - `SessionState` (:117). Status changes flow through `emit_live` (:1069) under the map write lock, and nothing can await them today.
  - Add a lightweight notifier, such as a `tokio::sync::watch`/`Notify` bumped in `update_and_emit`/`hook_and_emit`/`apply_and_emit`, or poll `sessions_live` every 250 ms on a blocking/async task. Implementer's choice: keep it small and testable.
- `pty/mod.rs`: `TermManager::write` (:1154) is non-blocking. `Term::stop` (:942) shows the write recipes.
- Draft detection: record the last operator input per session in `term_write` (ipc :776) and compare it with when the session last became idle.
- `claude/transcript.rs`: the transcript reader (applied signal). The session's transcript path is the discovered one, or `<claude_home>/projects/<encoded cwd>/<id>.jsonl` when not yet discovered (discovery runs every 5 s, `sessions.rs:24`). The read is read-only.
- New `claude/live_edges.rs` (or `graph/live_edges.rs`):
  - `EdgeLive { state: Pending|Applied|Failed, detail }` in an `AppState` map keyed by edge id;
  - the event `edges://live` with the full map;
  - commands `edge_live_retry(edgeId)` and `edge_restart_with_flags(edgeId)`;
  - dropping an edge's entry when the edge is removed or its session exits.

**Frontend (`src/`):**
- `ipc/index.ts`: types and wrappers, plus the event constant.
- `ipc/mirror.ts` and `App.tsx` (:61-98): mirror into a new `state/edgesLive.ts` store, following the `useLiveStore` pattern (`state/live.ts:25`).
- `components/EdgePane.tsx` (:20-94): a "Now:" line with the state text and detail, and Retry / Restart with flags buttons (Restart is always offered for a session-sourced context edge).
- `canvas/edges.ts` (`LinkEdgeData` :104, `linkFlowEdges` :113): an `is-pending`/`is-failed` class. Pending is muted; failed uses the attention accent.
- `commands/edges.ts`: palette rows "Retry edge" and "Restart with flags" for the selected edge.

**Tests:**
- `lib.rs` tests module: `mock_app`, `invoke_with`, `launch_fixture`, `wait_until` (:1288), `discover` (:1787), `echo_program` (:1802), and the test-only `launcher.program`.
- Fake status by writing `state.write_sessions_live()…state = Idle/Busy`, as the busy-stop test does (:2219).
- Fake acceptance by appending a stdout record to the temp transcript.

## Tasks & Acceptance

**Execution:**
- [x] `graph/mod.rs`, new live-edges module, `claude/live.rs`, `ipc/mod.rs`, `lib.rs` (+tests): single-edge resolve, the idle wait (60 s), injection (single line, control characters refused), the applied signal, retry, restart with flags, cleanup on edge delete or session exit, and the `edges://live` event.
- [x] `ipc/index.ts`, `ipc/mirror.ts`, `App.tsx`, `state/edgesLive.ts`, `EdgePane.tsx`, `canvas/edges.ts`, `commands/edges.ts`, CSS (+vitest): state display, buttons, palette rows, edge classes.
- [x] `README.md`, `docs/DESIGN.md`, `docs/research/claude-code-integration.md:77`: document the behaviour, the detection, and the delete limitation.

**Acceptance Criteria:**
- Given a live idle session (stub PTY), when a context edge to a project is added, then the PTY receives exactly `/add-dir <canonical path>\r` and the edge goes `pending` then `applied` on the acceptance signal.
- Given a busy session, when 60 s pass without idle (a shortened timeout in tests), then the edge is `failed` and nothing was written.
- Given a failed edge, when Restart with flags runs, then the session is stopped and relaunched with `--resume <same id>` and `--add-dir <path>`.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- Rust: new `claude/live_edges.rs` (state map, one job thread per edge polling every 250 ms, `edges://live`, draft marks, transcript tail); `graph::context_target` made public plus `graph::checked_out_heads`; `ipc` gets `edges_live_get`, `edge_live_retry`, `edge_restart_with_flags`, and hooks in `edge_add`, `edge_remove`, `workspace_remove_project`, `term_write` and the session exit hook (entries dropped before the node shows `exited`, so a restart's mark lands after it).
- Notifier choice: polling `sessions_live` (no watch channel); tests set states directly, as the busy-stop test does.
- Draft rule: printable input, a paste or Up/Down history recall marks a draft; Enter, Ctrl+C or Ctrl+U clear it; focus reports, cursor replies and keys pressed while the session is `waiting` are ignored; a bracketed paste always marks one. Retry clears the mark (the operator says the prompt is clear).
- Injections into one session are serialised, so each confirmation is read against its own line. The transcript is found as `<claude_home>/projects/*/<id>.jsonl`; reading starts at its end at injection time, plus a record-timestamp check (2 s slack).
- Extra details beyond the spec's words: pending `sent /add-dir, waiting for confirmation` after the write; `applied (the session's own folder)` when the target is the session's cwd; `failed (path has control characters)`.

- 2026-10-22 GUI pass (orchestrator, scratch projects `alpha` and `beta`, `claude.path` = the scratchpad stub, which prints its argv and writes no transcript): a background stub session on `alpha` showed `idle`; dragging its handle to `beta` stored a session-to-project context edge, drawn faint (pending) at once and in the accent colour after 10 s. The inspector read `Now: failed (not confirmed)` with Retry, Restart with flags and Delete. Restart with flags showed `that session has no transcript to resume` and left the session running. The injected bytes and the restart argv were not seen on screen; the lib.rs integration test covers them.

- 2026-10-22 GUI re-run after the patch round (orchestrator, same scratch projects, stub `claude`): the same result. The edge drew faint, then in the accent colour after 10 s. The inspector read `Now: failed (not confirmed)` with Retry, Restart with flags and Delete. Restart with flags refused with `that session has no transcript to resume` and the session stayed `idle`.

- 2026-10-22 CI (`dbad870`): typecheck, npm test, cargo test, the release build and the bundle check passed on both Windows and Linux. Only the artifact upload failed, on the storage quota; old artifacts were deleted and retention cut to 7 days (`83cdb0d`).

## Spec Change Log

- 2026-10-22, review round 1 (blind-hunter and edge-case-hunter: the draft mark sticks; the implementation differed from the frozen "since it last went idle"). **Emils' decision:** the draft rule is "typed and not yet sent or cleared (Enter, Ctrl+C, Ctrl+U or Retry)", and keys pressed while the session is `waiting` don't count. The idle-reset rule would have overwritten a draft typed while Claude was busy, which stays in the prompt. KEEP: the per-session mark cleared by Enter, Ctrl+C, Ctrl+U or Retry, and never injecting over a draft.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V):

**Patch:**
- P1 (medium; B, E) `restart_with_flags`: after `cancel_session`, an error from `stop_session`, `DID_NOT_STOP` or `resume_session` leaves the session's entries at `pending` with no job. A resume that fails after the stop leaves the session stopped with only an error string. On every error path, mark the session's live entries `failed` with the error. When the stop succeeded but the resume failed, say so (`stopped but not resumed: …`).
- P2 (medium; B) After a restart, only the clicked edge is marked, and the session's other context edges (also passed as `--add-dir`) show no live state. Mark every context edge from that session: `applied (restarted with flags)` when it resolves, otherwise `failed (<reason>)`.
- P3 (medium; B, E) Restarts are guarded per edge, and only in the TS, so two edges of one session can restart it twice. Add a per-session restarting guard in Rust (`already restarting` error). Key the TS `restarting` set by session id. `cancel_session` also cancels jobs whose stored edge is from that session, not only the ones that already have an entry.
- P4 (medium; B, E, decision above) Draft rule: input while the session is `waiting` does not mark a draft. A bracketed paste (`[200~`) marks a draft even when its content ends in a newline.
- P5 (low; B, V) Retry depends on the prose `TYPING` matched in TS: pin the literal in both test suites (lib.rs asserts the exact string; `edgesLive.test.ts` asserts `TYPING_DETAIL`'s literal).
- P6 (low; B) A `<local-command-stderr>` reply always means `failed`, even if it contains "already accessible".
- P7 (low; V) Tests: Retry on a draft-held edge injects and leaves TYPING; Restart with flags on the `no worktree` edge ends `failed (no worktree)`. A test for the P1/P3 guards where it is cheap.
- P8 (low; B) A test flake risk: `assert_eq!(got().len(), 2)` breaks if the PowerShell stub echoes an earlier line again. Assert the lines' contents, not their count.
- P9 (low; E) `restartEdge`: `void restore(termId)` can reject unhandled. Catch it and notify.
- P10 (low; B) The README states the transcript wording and the dialog as unverified, as `claude-code-integration.md` does, until Emils' check with the real `claude`.
- P11 (low; B, V) The `edge_add` doc comment is split around `#[tauri::command]`: merge it above the attribute.
- P12 (low; B) A pending or failed edge's `ariaLabel` includes its live state (`context edge: <label> (failed)`).

**Defer:**
- (medium, unverified; E) `/add-dir` with a path containing spaces: whether Claude takes the rest of the line or needs quoting. Settle with the real `claude` (Emils' manual check).
- (low; V) `prune` on project removal is untested; a failed edge's accent (`.attention` in `Canvas.tsx`) has no component test (no DOM test environment).

**Reject:**
- (B) Retry after `not confirmed` may answer an open choice dialog: Retry is the operator's explicit action, which the spec asks for; the app itself never presses further keys.
- (B) The confirmation is not matched to the injected path: injections into one session run one at a time and the tail starts at the end of the transcript. Requiring the path in Claude's unverified display format would fail real confirmations.
- (B) Only project removal prunes: false. Edges are removed only by `edge_remove` (which forgets the entry) and project removal (`graph/mod.rs:1473`, `:1702`).
- (B, E) Restart is offered for a historic session: the spec says Restart is always offered for a session-sourced context edge. On a session that isn't running it resumes with the flags, which is the intended effect. An external live session is refused by `run_launch` (`SESSION_RUNNING`).
- (E) The operator types between the draft check and the write: the window is milliseconds.
- (E) Retry racing `mark`'s job removal: negligible, and the next state change corrects it.
- (E) Records up to 2 s older than the injection are accepted: the tail starts at the transcript's end at injection, so only a transcript that appears later is read from its start, and that is a new transcript.
- (B) Spec bookkeeping: the fix would edit this spec. The logs are filled in by this triage.
- (B) Untested end-to-end details (own folder, control-character path, failed stdout): the unit tests cover `add_dir_line`, `classify` and the resolver.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator, foreground-guarded, stub `claude`:**
  - link a live stub session to a project and see `pending` then `failed (not confirmed)`, because the stub writes no transcript;
  - Restart with flags, and check that the stub's argv carries `--resume <id> --add-dir <path>`.
- **Emils, with the real `claude`:** link a live idle session and see `applied`. Note whether a choice dialog appears.
