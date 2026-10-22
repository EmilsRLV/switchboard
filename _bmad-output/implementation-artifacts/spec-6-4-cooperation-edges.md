---
title: 'Story 6.4: Cooperation edges'
type: 'feature'
created: '2026-10-22'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '83cdb0dc8a5a1b616a25d2da9eb726937dc35f86'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A cooperate edge between two sessions is only drawn. Neither session knows the other exists, so the operator still relays messages between two repos by hand.

**Approach:**
- **Starting a session.** When a session starts (resume; a fork, see below), its appended system prompt lists its cooperate peers by name, node path and edge label. It tells the session to prefer `SendMessage` to them.
- **Linking two live sessions.** Each idle session gets one plain injected line naming the new peer, reusing Story 6.3's idle wait, draft rule and per-session slot.

**Decisions:**
- **Peer lookup (Rust).** For a session, its peers are the other ends of every cooperate edge touching it. A peer's **name** is its live name (`--name`), else its transcript title, else its project label (the `source_session` rule). Its **node path** is `<project label>` or `<project label>:<branch>` when its branch is known, then ` / <name>`. Its **purpose** is the edge label, or `no stated purpose`.
- **System prompt.** After the six context lines it adds `Peer sessions (cooperate edges):`, then one line per peer: `- "<name>" (<node path>): <purpose>`. The peers are capped at 5, with `- … and N more` after that. It ends with one instruction line: `Prefer SendMessage to a peer by its name to coordinate.` Every value has control characters stripped, and each value is cut to 120 characters. With no peers the prompt is unchanged.
- **Which launches.** Resume and New use the session's own cooperate edges. A New session has no edges yet, so nothing changes for it. A **fork does not inherit** the original's peers: the peer only knows the original.
- **Live link.** When a cooperate edge is added and an end is a session running in Switchboard, that end is sent `A new peer session "<other name>" is linked to you (<purpose>). Use SendMessage to coordinate.` + `\r`, when idle and not over a draft (6.3 rules, 60 s busy timeout). An end that is not live gets nothing: its prompt carries the peer at its next resume.
- **Notified signal.** The injected line is a user prompt. That side becomes `notified` when the session goes busy within 3 s of the write (the architecture's injection rule), otherwise `failed (not confirmed)`.
- **Edge inspector.** For a cooperate edge it shows one Now line per side: `<name>: notified`, `pending (waiting for idle)`, `pending (you're typing — Retry when done)` or `failed (…)`. Retry is offered for a failed or draft-held side. There is no Restart with flags: the next resume carries the peer anyway.
- **Runtime only.** As in 6.3, the state is kept in memory on `edges://live`, keyed per side.
- **Only `SendMessage` for now (Emils' decision).** The prompt and the injected line mention `SendMessage` only. Epic 7 adds the `switchboard` MCP `send`/`inbox` wording when those tools exist.
- **No inbox notice yet (Emils' decision; resolves epic open decision 3).** A live link gets the injected line and the prompt block. The inbox link notice comes with Story 7.3.
- **Native messaging check.** By hand with the real `claude` (Emils): A sends `SendMessage` to B by name while B is idle. The result is recorded in the Implementation Notes and the README. If it does not deliver, Story 7.3's inbox nudge becomes the primary channel.

## Boundaries & Constraints

**Always:**
- **Rust owns the peer text, the injection and the state.** The UI only renders them.
- **Injection is one plain line**, control characters stripped, never multi-line.
- **No `~/.claude` writes, and the real `claude` never runs in tests.** CI on both runners and the design lint stay green.

**Never:**
- MCP tokens, `send` permissions, an inbox, or a link notice in an inbox (Epic 7).
- Peers inherited by forks. A system prompt for a session not started from Switchboard.
- Persisting live state.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Resume with a peer | historic `api-1` ↔ `ui-2`, label "API shape for auth refresh"; resume `api-1` | prompt has `- "ui-2" (ui / ui-2): API shape for auth refresh` and the SendMessage line | — |
| Both live, idle | link `a` ↔ `b` | each PTY gets its one line naming the other; sides go `notified` on busy | no busy in 3 s → `failed (not confirmed)`, Retry |
| One live | `a` live, `b` historic | only `a` is injected; `b` has the peer at its next resume | — |
| Busy / draft | `a` busy or has a draft | `pending (waiting for idle)` / `pending (you're typing…)` | busy > 60 s → failed |
| No label | edge without a label | purpose `no stated purpose` | — |
| Many peers | 7 cooperate edges | 5 peer lines + `- … and 2 more` | — |
| Control chars | label with `\n` or ESC | stripped in both the prompt and the line | — |
| Fork | fork of `api-1` | fork's prompt has no peer block | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `claude/launch.rs`:
  - `system_prompt` (:345-360) gains `peers: &[Peer{name, path, purpose}]`.
  - Strip control characters with `without_controls` (:255) and cut each value to 120 characters.
  - Update the test at :1114 and keep the six-line case for no peers.
  - `build_args` (:386-425) is unchanged.
- `ipc/mod.rs`:
  - `prepare_launch` (:1579-1604, prompt at :1590) gets the peers for the launching session id. A fork uses its new id, so it has none.
  - Peer names come from the live map (`LiveSession.name`, live.rs:171), then discovered summaries (`title`), then the project label (`session_project` :518). Reuse the `source_session` rule (:1452-1483) without requiring a transcript.
- `graph/mod.rs`: a `cooperate_peers(st, session_id)` helper over `Workspace.edges` (Cooperate) giving the other end and its label. The branch comes from the SessionRef's `branch_id` or `ref_branch` (ipc :1502). Label rules are at :470-501 and :1846.
- `claude/live_edges.rs`:
  - Factor out a generic one-line injection: the idle wait, the draft check, the `injecting` slot and the job generations (:595-704). Keep `/add-dir`'s transcript confirmation for context edges.
  - Cooperate sides get the busy-within-3 s check.
  - The state map gets per-side keys (for example `<edgeId>#<sessionId>`), or `EdgeLive` gains a side, so `session_exited`, `forget_edge` and `prune` handle both sides.
  - `edge_added` (:558) and `retry` accept cooperate edges with a side. The line text is built in Rust with control characters stripped.

**Frontend (`src/`):**
- `state/edgesLive.ts`:
  - `nowText` becomes per side for cooperate edges.
  - Update `isSessionContext` and the Retry rules, and the TYPING literal stays pinned.
- `components/EdgePane.tsx`: Now lines per side, and Retry per side.
- `canvas/edges.ts`: pending and failed classes and the aria text for cooperate edges.
- `commands/edges.ts`: Retry for a side. Update its test at :328-360, which asserts there is no Retry for cooperate edges.
- `ipc/index.ts`: types and wrappers.

**Tests:**
- lib.rs `context_edges_on_a_live_session…` (:2323) uses the stub `line_echo_program` (:2283), and that is the model for a cooperate live test:
  - two stub sessions;
  - each gets its line;
  - busy set within 3 s gives `notified`;
  - no busy gives `failed`;
  - one live end;
  - Retry.
- A resume prompt test like `resume_fork_and_an_idle_stop…` (:1856): the peer block on resume, none on fork.

## Tasks & Acceptance

**Execution:**
- [x] `graph/mod.rs`, `claude/launch.rs`, `ipc/mod.rs` (+tests): peer lookup, the prompt block (cap, cut, stripping), and resume/fork wiring.
- [x] `claude/live_edges.rs`, `ipc/mod.rs`, `lib.rs` (+tests): the generic line injection, cooperate sides, the notified signal, retry, and cleanup.
- [x] `ipc/index.ts`, `state/edgesLive.ts`, `EdgePane.tsx`, `canvas/edges.ts`, `commands/edges.ts` (+vitest): per-side Now lines and Retry.
- [x] `README.md` (:496 "do nothing yet"), `docs/DESIGN.md`, `docs/research/claude-code-integration.md`: document the behaviour and the pending native-messaging check.

**Acceptance Criteria:**
- Given two historic sessions linked by a cooperate edge labelled "API shape for auth refresh", when one is resumed, then its `--append-system-prompt` names the other session, its node path and the label, and says to prefer `SendMessage`.
- Given two live idle sessions (stub PTYs), when I link them, then each PTY receives exactly its one line naming the other, and each side shows `notified` after going busy.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- **Peer lookup.** `graph::cooperate_peers` (other end + label per cooperate edge, stored order) and
  `graph::session_peers` / `name_peers` (name, node path, purpose). The project comes from the session ref,
  else the discovered list, else the live map; a peer with no project at all is `unknown project / <name>`
  and, with no name source, is named by its id. Branch: the session ref's `branchId` without the project
  prefix (the `ref_branch` rule); the transcript's `gitBranch` is not used.
- **Prompt.** `launch::Peer`, `peer_value` (strip controls, trim, cut to 120 characters with the 120th a `…`),
  `system_prompt(.., peers)`. `prepare_launch` looks up the launching id, so a fork (new id) and a New
  session get none.
- **Live.** `live_edges` jobs are now a `Job` with a shared `wait_for_slot` (idle wait, draft rule, slot,
  generations); `run_context` keeps the transcript confirmation, `run_side` checks busy within
  `Timeouts::notify` (3 s). New `EdgeState::Notified`, `EdgeLive.edgeId`, side keys `<edgeId>#<sessionId>`
  (`side_key`). `forget_edge` and `prune` go by `edgeId`; `fail_session` (Restart with flags) touches context
  entries only. The peer line is built after the slot is claimed, so a label set while waiting is used.
  `edge_live_retry` takes an optional `sessionId`, required for a cooperate edge (`NOT_A_SIDE`).
- **UI.** Side helpers (`sideKey`, `cooperateSides`, `cooperateState`) live in `canvas/edges.ts` (pure, no
  import cycle); `sideNowText` in `state/edgesLive.ts`. A side with no live state reads `<name>: peer named at
  the next resume`. The cooperate edge draws muted/attention from its sides (failed wins, then pending).
  Palette **Retry edge** retries every retryable side.
- **Native messaging check:** not done (needs the real `claude`, Emils). README and
  `docs/research/claude-code-integration.md` mark it pending.

- 2026-10-22 GUI pass (orchestrator, scratch project `alpha`, stub `claude` that never goes busy): two background stub sessions on `alpha` showed `idle`. Dragging one's handle onto the other stored a `cooperate` edge (session to session, no label), drawn as the double line, in the accent colour once both sides failed. The inspector showed Kind cooperate, Between/And both sessions, and two lines, `Now: alpha-d4bd: failed (not confirmed)` and `Now: alpha-04f5: failed (not confirmed)`, each with its own Retry. The injected text and the resume prompt block were not seen on screen; the lib.rs integration test covers them.

- 2026-10-22 GUI re-run after the patch round (orchestrator, same setup): the same result. Both sides read `failed (not confirmed)` with their own Retry, and the double line was drawn in the accent colour.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V):

**Patch:**
- P1 (medium; B, E, V) A failed Restart with flags leaves cooperate sides stuck. `cancel_session` retires their jobs and `fail_session` skips them, so a side stays at `pending (waiting for idle)` with no job and no Retry. Mark the session's pending side entries `failed (<restart error>)` so Retry is offered. `cancel_session` must also retire side jobs that have no entry yet (key `side_key(edge, session)`).
- P2 (medium; E) A terminal that is being stopped reads as `Busy` in `running_session`, so a side can be marked `notified` during a Stop or Restart. The notified check must not count a stopping terminal; that side is dropped or `failed`.
- P3 (medium; B, E) Peer values are quoted (`"<name>"`) but only control characters are stripped. A name or label containing `"` breaks out of the quotes in a line that is injected as a user prompt into another session, and U+2028/U+2029 read as line breaks. Strip U+2028/U+2029 as well, and replace `"` in values with `'`. Test both.
- P4 (low; E) Retry while a side's line is already written (pending, sent) can inject the line twice. Rust refuses retry unless the side is `failed` or held by a draft.
- P5 (low; E) A live name or title made only of control characters skips the fallback and names the peer `""`. Test emptiness after cleaning.
- P6 (low; E) When the ref's or discovered project is gone, the name falls back without trying the live map's project. Try each project source in turn.
- P7 (low; B) Docs:
  - README and DESIGN list every Now text, including `sent, waiting for the session to take it`, the draft and `stayed busy` details.
  - `notified` means "went busy within 3 s of the line", which another cause can also trigger.
  - The README's Retry palette sentence is unclear.
- P8 (low; V, B) Tests:
  - a `name_peers` unit test (live name over title, a ref with a branch, untitled → project label, no project → `unknown project`);
  - `prune` keeps the sides of an untouched cooperate edge when an unrelated project is removed;
  - the TS `edgeLiveRetry("c1","s1")` sends `{edgeId, sessionId}`;
  - `peer_line` long values assert exactly 120 characters plus `…`;
  - a test for P1.

**Defer:**
- (medium, unverified; B) Whether the name a peer is told (live `--name`, else transcript title) is the name `SendMessage` reaches for a resumed session (a resume passes no `--name`). Settle with Emils' native-messaging check.
- (low; V) Component render tests for `CooperateEdge`'s accent and the per-side inspector lines (no DOM test environment; the GUI pass covered them).

**Reject:**
- (B) Duplicate cooperate edges between one pair: false. `add_edge` refuses duplicates in either direction (`is_duplicate_edge`, test `add_edge_refuses_invalid_pairs_duplicates…`).
- (B) The project-label fallback is not unique: it applies only to an untitled peer with no live name, and the node path still tells peers apart.
- (B) With hooks down, every side is `not confirmed`: the hooks endpoint is the normal state source; when it is down, sessions show no live state at all.
- (B) The inspector names sides by the canvas card label: it names nodes as the canvas does; the peer text is Rust's.
- (B) Retry-all notices overwrite each other: both sides are refused for the same reason in practice.
- (B) Peers whose session is gone are listed: a cooperate edge's ends are canvas nodes; a vanished transcript is rare and the node path still says `unknown project`.
- (B) Spec bookkeeping: filled in by this triage.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator, foreground-guarded, stub `claude`.** Start two stub sessions and link them. Each stub's terminal echo shows its line, and the inspector shows per-side state (`failed (not confirmed)`, because the stub never goes busy).
- **Emils, real `claude`.** Resume a linked session, then check the peer block (`/context` or ask it), then A `SendMessage` → B while B is idle. Record whether it is delivered.
