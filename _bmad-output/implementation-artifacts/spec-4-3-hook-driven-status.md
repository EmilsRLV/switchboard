---
title: 'Story 4.3: Hook-driven status'
type: 'feature'
created: '2026-10-18'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'bbb4c94ef10f9515c752982ec6e16b80ff578b32'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-2-new-session-launch-sheet.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-3-status-glow-and-notifications.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** live status comes from polling `claude agents --json` every 2 s, which only knows `busy` and `idle`. `waiting` never shows, and `finished` is a guess from a busy→idle edge, so the Story 3.3 glow and toasts are late and sometimes wrong.

**Approach:**
- **Hooks.** Sessions that Switchboard starts get Claude Code hooks in their per-session `--settings` file. These are native `http` hooks that POST each event to a localhost endpoint inside the app. Rust maps each event onto the live state machine, so `waiting` and `finished` show within a second.
- **Last line.** A `finished` card shows the turn's last assistant line, truncated.
- **Polling stays as the baseline.** When hooks go silent and the poll disagrees for two polls, the poll wins and a diagnostics counter goes up.

**Facts (Claude Code hooks reference, read 2026-10-18; the 2.1.302 behaviour is checked in the GUI pass):**
- **`http` hooks.** They take `{ "type": "http", "url", "headers", "timeout" }` and POST the event JSON. A 2xx with an empty body is success and changes nothing. A non-2xx, timeout or connection error is non-blocking by default.
- **`PermissionRequest`.** It fires as soon as a permission dialog is about to show, with `tool_name` and `tool_input`. The `Notification` with `notification_type: "permission_prompt"` fires only after about 6 s without input.
- **`Stop`.** It carries `last_assistant_message`.
- **Common fields.** Every event has `session_id`, `transcript_path`, `cwd` and `hook_event_name`.

**Decisions:**
- **Endpoint:**
  - **Server.** An `axum` 0.8 server bound to `127.0.0.1:0` (an ephemeral port), started once at app start on Tauri's async runtime. A failed bind leaves launches working without hooks: the settings file is `{}` as in 4.2, with a banner `hooks endpoint unavailable: <cause>`.
  - **Route.** `POST /hooks/<event>`. The header `Authorization: Bearer <token>` names the session.
  - **Tokens.** Each is 32 random bytes in hex, created per launch, compared in constant time, and dropped when the session's process exits.
  - **Refusals.** An unknown token gets 401, any other path or method 404, and a body over 1 MiB 413.
  - **Replies.** Every accepted request gets an **empty 200**. The app never returns JSON, so hooks never change Claude's decisions.
  - **Session matching.** An event updates the token's session. A `session_id` in the payload that differs from it is counted in diagnostics but still applied to the token's session.
- **Settings file.** The 4.2 file now holds a `hooks` block of `http` hooks: `timeout` 5, the URL `http://127.0.0.1:<port>/hooks/<Event>`, and the bearer header written literally (the file is per-user, 0600 on Unix).
  - **Events wired:** `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification` (matcher `permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input`), `Elicitation`, `PostToolUse`, `PostToolUseFailure`, `Stop` and `StopFailure`.
  - **Not wired:** the user's own hooks and every other event. Settings layers merge, so their hooks keep working.
  - **Port.** The env adds `SWITCHBOARD_PORT=<port>`.
- **State mapping** (source `Hook`):
  - **Idle:** `SessionStart` turns `starting` into `idle`.
  - **Busy:** `UserPromptSubmit`, `PostToolUse` and `PostToolUseFailure`.
  - **Waiting:** `PermissionRequest`, `Elicitation`, and a `Notification` of the wired types. The `Notification` message is kept as `detail` for the card's title tooltip.
  - **Finished:** `Stop` gives `finished` with `last_line`: the first non-empty line of `last_assistant_message`, trimmed and cut to 200 chars, with `…` appended when cut. `StopFailure` gives `finished` with `last_line = "turn failed"`.
  - **Answering in the terminal** (amended in review round 1). The keypress that answers a prompt is not a hook event, and the tool's `PostToolUse` only arrives after it runs. So while a session is `waiting`, only a **single-key** write to its terminal counts as an answer. Pasted text, and terminal reply sequences (CSI, OSC, DCS, focus and mouse reports), never count.
    - For a permission wait (`PermissionRequest`, or a `permission_prompt` Notification), Enter, a digit or `y`/`n` turns it `busy`, and a lone Esc (a rejection, which ends the turn) turns it `idle`.
    - For an elicitation or `agent_needs_input` wait, only Enter counts, and it turns the session `busy`.
    - Both changes use source `Hook`.
  - **Shared rules.** `attention_since`, the toasts and the glow follow the Story 3.3 rules, whatever the source. Acknowledging works as in 3.3.
  - **Exit.** Process exit stays the 4.2 PTY rule.
- **Poll reconciliation, for hooked sessions only:**
  - **The guess goes.** The 3.3 busy→idle `finished` guess no longer applies to a session with a token.
  - **Agreeing pairs.** A poll result agrees with the hook state when the pair is one of: `busy`/busy, `waiting`/busy, `waiting`/idle (unanswered for a while), `finished`/idle, `idle`/idle, or `starting`/anything.
  - **Override.** When the poll disagrees with the hook state for **two consecutive polls with no hook event in between**, the poll's state is applied through the normal 3.3 fold (source `Poll`) and `poll_overrides` increments.
  - **Unhooked sessions.** Sessions started elsewhere behave exactly as before.
- **Diagnostics.** A new Settings pane section "Diagnostics" shows:
  - the hooks endpoint (`127.0.0.1:<port>`, or the bind error);
  - hook events received;
  - refused requests;
  - session-id mismatches;
  - poll overrides.

  It is read through a new `diagnostics_get` command and refreshes while the pane is open (every 2 s).
- **Card** (amended in review round 1). The card is a fixed 40 px tall, so a `finished` card shows `finished · <last_line>` on its second line in place of branch · count · age, until it is acknowledged. The line is muted and single-line with an ellipsis, uses tokens only, and adds no accent beyond the existing finished treatment. The full line is in the tooltip and the accessible label. The `waiting` card's `title` and accessible label hold `detail`.

## Boundaries & Constraints

**Always:**
- **Localhost only.** The endpoint binds 127.0.0.1 only and makes no network calls.
- **Tokens.** Each session gets its own token, and it dies with the session.
- **Neutral replies.** Hook replies are always empty, so hooks never approve, deny or block anything.
- **No `~/.claude` writes.** Nothing is ever written under `~/.claude`, and the user's own hooks and settings stay untouched.
- **Tests.** They drive the endpoint with raw HTTP on an ephemeral port and the state machine with pure functions, never with the real `claude`.
- **CI.** Both runners stay green, with the design lint passing.

**Never:**
- Hook-driven approvals or denials.
- `PreToolUse` file tracking.
- Hooks for sessions started outside Switchboard.
- Resume, fork or stop (Story 4.4).
- MCP.
- Following a `/clear` to a new session id.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Permission | session busy; `PermissionRequest` POST | `waiting` within 1 s, glow + toast per 3.3 | — |
| Answer | permission `waiting`; Enter / `1` typed in its terminal | `busy` at once; Esc → `idle` | pasted text / terminal replies ignored |
| Turn ends | `Stop` with "Done.\nDetails…" | `finished`, card shows `Done.` | — |
| Long last line | 500-char first line | cut to 200 + `…` | — |
| Turn fails | `StopFailure` | `finished`, `turn failed` | — |
| Hooks silent | hook state `idle`, poll `busy` twice | `busy` (source poll), overrides +1 | — |
| One disagreeing poll | then a hook arrives | hook state kept, no override | — |
| Bad token | POST with unknown bearer | 401, refused +1, no state change | — |
| Big body | 2 MiB POST | 413 | — |
| Bind fails | port unavailable | launches work, `{}` settings, banner, diagnostics show the error | — |
| Session exits | PTY exit | token dropped; a later POST with it → 401 | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/Cargo.toml`:** add `axum = "0.8"`, and tokio features `net` (plus `rt`/`macros` if needed). Random bytes come from `uuid` v4 ×2 or `getrandom`, whichever is already in the tree.
- **`src-tauri/src/claude/hooks.rs` (new):**
  - Token registry, router and handler.
  - A pure `map_event(event, payload) -> Option<HookSignal>`.
  - `settings_json(port, token) -> serde_json::Value`.
  - `Diagnostics` counters.
  - `last_line` trimming.
  - Tests over raw `TcpStream` HTTP.
- **`src-tauri/src/claude/launch.rs`:** write the hooks settings when the endpoint is up (otherwise `{}`), register the token, add `SWITCHBOARD_PORT`, and drop the token on exit.
- **`src-tauri/src/claude/live.rs`:**
  - `StateSource::Hook`, and `LiveSession.last_line` / `detail`.
  - `apply_hook(id, signal, now) -> Vec<Transition>`, `terminal_input(id, data)`, and a `hooked` set with per-session "polls disagreeing since last hook" counters.
  - Reconciliation inside `apply_at`, and the `poll_overrides` counter.
  - Unit tests for each mapping and agreement pair.
- **`src-tauri/src/pty/mod.rs` / `ipc/mod.rs`:** `term_write` for a `session:` terminal also calls `live.terminal_input`. Add the `diagnostics_get` command.
- **`src-tauri/src/notify.rs`:** hook transitions feed the same `decide` path as poll transitions.
- **`src-tauri/src/lib.rs`:** start the endpoint in `setup`, store the port and the error in `AppState`, and add the banner.
- **Frontend:**
  - `src/ipc/index.ts`: `lastLine`, `detail`, `source: "hook"`, `diagnosticsGet`.
  - `src/canvas/ChildNode.tsx` and `nodes.ts` (`sessionCardMeta`): the finished last line and the waiting title.
  - `src/components/SettingsPane.tsx`: the Diagnostics section.
  - `shell.css` styles, plus tests.
- **Docs:** `README.md` gets a "Status" section covering hooks vs polling and diagnostics. `docs/research/claude-code-integration.md` gets the hook facts above and the GUI-verified 2.1.302 behaviour.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/hooks.rs`, `Cargo.toml` (+tests) -- endpoint, tokens, mapping, settings JSON, diagnostics -- the hooks channel
- [x] `src-tauri/src/claude/live.rs` (+tests) -- hook source, apply_hook, terminal-input answer rule, reconciliation and override counter -- the state machine
- [x] `src-tauri/src/claude/launch.rs`, `pty/mod.rs`, `ipc/mod.rs`, `notify.rs`, `lib.rs` (+tests, including a fixture launch whose settings file holds the hooks block, and a POST that turns the session waiting and emits) -- wiring
- [x] `src/ipc/index.ts`, `src/canvas/ChildNode.tsx`, `src/canvas/nodes.ts`, `src/components/SettingsPane.tsx`, `src/components/shell.css` (+tests) -- card last line, waiting title, diagnostics
- [x] `README.md`, `docs/research/claude-code-integration.md` -- docs

**Acceptance Criteria:**
- Given an app-launched session, when Claude asks for permission, then the endpoint receives the hook and the node is `waiting` within 1 s; answering in the terminal returns it to `busy`.
- Given the turn ends, when `Stop` fires, then the node is `finished` and shows the last assistant line truncated.
- Given no hook for two polls while the poll disagrees, when reconciled, then the poll wins and the diagnostics counter increments (visible in Settings → Diagnostics).
- Given `cargo test`, `clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- 2026-10-18 (dev). Decisions taken while building, where the spec left room:
  - **Crates.** `axum = "=0.8.9"` (`default-features = false`, features `http1`, `tokio`); tokio gains `net`. Resolved offline from the local registry cache. Tokens are two v4 UUIDs' bytes in hex (64 chars, `uuid` already in the tree), so no `getrandom` dependency.
  - **Endpoint.** `hooks::start` binds `127.0.0.1:0` with std (synchronously, in `setup`, before `settings::initialise`, so a failed bind's banner is in the first settings snapshot) and serves on Tauri's async runtime. A bind or serve failure sets `Endpoint::Failed` and `SettingsState::hooks_banner` (`hooks.endpoint`, `hooks endpoint unavailable: <cause>`); launches then write `{}` and no `SWITCHBOARD_PORT`. `start_on(app, io::Result<TcpListener>)` is the testable seam.
  - **Refusals.** 404 for any path other than `/hooks/<wired event>` and any method other than POST (an unwired event name is "another path"); 401 for a missing or unknown bearer; 413 over 1 MiB. Every refusal counts as "refused". A body is read (an over-long declared one is drained up to 16 MiB) before every reply, so the client sees the status instead of a reset connection. An accepted request with unparsable JSON is still an empty 200 and changes nothing.
  - **Mapping details.** `PermissionRequest`'s `detail` is `permission: <tool_name>`; `Elicitation`'s is its `message`; a `Notification`'s is its `message` (all trimmed, cut to 300 chars). A `Stop` without a usable `last_assistant_message` is `finished` with no last line. A second `Waiting` while waiting only updates `detail` (the 6 s `Notification` after a `PermissionRequest` sends no second toast); `Waiting` → `Finished` is a new transition. `SessionStart` changes only `starting`.
  - **Live map.** `LiveSession` gains `last_line` / `detail` (snake_case on the wire, like the other live fields; the TS type mirrors them as `last_line` / `detail`, and `ChildNodeData` carries them as `lastLine` / `detail`). `LiveMap.hooked: HashMap<id, u8>` (set at launch when a token is issued, cleared on exit, forget and relaunch) holds the disagreeing-poll count; `poll_overrides: u64`. A hooked session still in `starting` is folded normally by its first poll row (the 4.2 rule) without counting. Besides the listed agreeing pairs, a poll state equal to the held one agrees (`other`/same `other`). An override applies the poll through `fold_state` with the busy→idle guess off.
  - **Terminal answer rule.** `live::answers_prompt` skips CSI and SS3 sequences (arrow keys, focus and mouse reports carry digits) and treats a lone Esc, Esc+key, `
`, `
`, a digit or `y`/`n` (any case) as an answer. `term_write` calls `live::terminal_input_and_emit` only for `session:` terminals, after the write, with a read-lock fast path.
  - **Emission.** `live::hook_and_emit` changes and emits under the map's write lock; labelling and the toast decision (`notify::on_transitions`, shared with the poll via the new `notify_transitions`) run after it, as in `apply_and_emit`.
  - **Card.** The card stays 208 × 40, so a `finished` card with a last line shows it after the state word *in place of* branch · count · age (`.session-last-line`, muted, ellipsis, in `nodes.css`); the full line, and a waiting card's `detail` (first), are in the `title` (`sessionCardTitle`). Diagnostics styles are in `shell.css`; the rows come from the pure `src/components/diagnostics.ts`.
- **Verified here (Windows):** `cargo test` 341 passed (including the raw-`TcpStream` endpoint test with 401/404/413 and the empty 200, the pure mapping, settings-JSON and state-machine tests, the fixture launch whose settings file holds the hooks block, a `PermissionRequest` POST that turns the session `waiting`, emits and toasts through the recorder, a `1` typed through `term_write` turning it `busy`, a `Stop` with its last line, `SWITCHBOARD_PORT` in the child's env, and a 401 for the token after exit; and the failed-bind banner/diagnostics), `cargo clippy --all-targets -- -D warnings` clean, `npm test` 404 passed (design lint included), `npx tsc --noEmit` clean. No test process was left (process list compared before and after two runs). **Not run here:** Linux (the `/bin/sh` fixture line gained `port=%s` and was reviewed by reading), `npm run tauri build`, and the manual GUI pass with a real `claude` 2.1.302 (left to the orchestrator; the 2.1.302 hook behaviour in `docs/research` is marked unverified until then).

- 2026-10-18 GUI pass (orchestrator, real claude 2.1.302, Emils' consent): the settings file wired the nine events. With permission mode `manual`, an `echo` prompt ran without asking (a read-only command), and `Stop` gave `finished` with "I ran `echo swit…". A Write-tool prompt outside the project raised Claude's own permission dialog, and the card turned `waiting` at once while the dialog still showed, so an empty 200 to `PermissionRequest` neither approves nor denies. Enter turned it `busy` immediately; `Stop` gave `finished` with "I created `C:/Us…"; `/exit` deleted the settings file. Settings → Diagnostics shows the endpoint `127.0.0.1:<port>` and the four counters. The aborted earlier session `ide-59cd` showed as one historic node once its transcript appeared (4.2's no-duplicate criterion, verified live).

- 2026-10-18, review patch round 1 (P1–P12; dev). These change or add to the notes above:
  - **P1 hooked on first event.** `launch_session` only issues the token; `LiveMap::apply_hook` marks the session hooked on its first accepted event. `hooks::fail` (bind or serve failure) calls `Hooks::drop_all` and `LiveMap::clear_hooked`, so every session falls back to the 3.3 rules. `set_hooked` is gone.
  - **P2 answer rule.** `live::answer_key` accepts only an exact single key: `\r` / `\n` / `\r\n`, a lone Esc, one digit or `y`/`n`. Anything longer (pastes, CSI/SS3/OSC/DCS replies, bracketed paste, Esc+key) is `None`. `HookSignal::Waiting` carries a `WaitKind`: `Permission` for `PermissionRequest` and a `permission_prompt` Notification; `Input` for `Elicitation` and the other wired notification types. `LiveMap.waits` holds the kind per waiting session (not on the wire). On a permission wait Enter, a digit or `y`/`n` gives `busy` and Esc gives `idle`; on an input wait only Enter gives `busy`. With no kind recorded, `Permission` is assumed.
  - **P3.** `HookSignal::Busy` is split into `Prompted` (`UserPromptSubmit`, always busy) and `ToolDone` (`PostToolUse*`, busy unless `waiting`). `ToolDone` on a waiting session still counts as a hook event (it resets the disagreement count).
  - **P4 reply first.** `hooks::router` starts a `hooks-apply` worker thread fed by an `mpsc` channel. The handler queues the signal and replies; the thread applies in arrival order and ends when the router is dropped. This replaces the Design Notes' "while the lock is held, before the reply". Tests now wait (bounded) for the state instead of reading it right after the POST.
  - **P5 hardening.**
    - The 404 and 401 checks run on the head before any body read.
    - Bodies are streamed with `HttpBody::poll_frame`: up to 1 MiB is kept; anything over (declared or chunked) is 413 and is discarded unbuffered up to 16 MiB, so the client reads the reply instead of a reset. A declared length over 16 MiB gets 413 at once.
    - Every refusal carries `Connection: close`. A body read slower than 10 s is a 408 refusal.
    - A custom `axum::serve::Listener` (`Limited`) holds a semaphore permit per connection (64) and wraps each socket so it fails after 10 s without input. This covers both header and body reads, since axum 0.8 exposes no hyper header timeout.
    - Tests cover chunked over-limit, a declared over-cap length (head only), an unauthenticated 2 MiB body (401), exactly 1 MiB accepted, a reply that does not wait for a blocked apply, and a half-sent head closed after ~10 s.
  - **P6.** `(finished | waiting, other)` agrees. An override increments `poll_overrides` only when the folded state differs from the held one; either way the source becomes `Poll`.
    - Consequence: no poll state (busy, idle or another status) can override a `waiting` session any more; only hooks, a terminal answer, acknowledgement or the process exit end it. Pinned by `no_poll_state_ever_overrides_a_waiting_session`, which stands in for P11's "override starting from waiting".
  - **P7.** `LiveMap.answered` records the time of the last terminal answer. A `Waiting` signal flagged `notification` within `LATE_NOTIFICATION_MS` (10 s) of it is ignored unless the session is already waiting. A `PermissionRequest` is never ignored.
  - **P8.** `Hooks::check_session_id`: a `SessionStart` whose `session_id` differs from the token's session records it as an alias and is not counted. Later events carrying an alias are not mismatches. Aliases go with the token.
  - **P9.** `diagnosticsError` shows "last read failed: …" (role `alert`) above the last counters; before any success it shows the bare error.
  - **P10.** New `childAriaLabel` gives `Session <label>, waiting: <detail>, last line: <line>, needs you` as applicable. The `sessionCardTitle` doc now says the line is already cut to 200.
  - **P11 tests.** Covered as follows:
    - `a_failed_launch_with_the_endpoint_up_leaves_no_token`: a planted settings file and a missing program, checking token count and hooked marks.
    - `a_detail_is_cut_to_300_characters`.
    - The lib end-to-end test now posts a permission `Notification` (ignored as a late notice after the terminal answer) and `StopFailure` (`turn failed`), besides `SessionStart`, `PermissionRequest`, `Stop` and `UserPromptSubmit`; it also checks that a pasted line does not answer.
    - The failed-bind test registers a token and a hooked mark first and checks that both are cleared.
  - **P12 docs.** The README Status section is rewritten for the amended rules and gains "Limits worth knowing": the token is readable by the session's own processes, the Windows file has only the `%TEMP%` ACL, and a blocking user `Stop` hook can still produce `finished` and a toast. The research doc records the GUI-verified 2.1.302 behaviour.
- **Round 1 verified here (Windows):** `cargo test` 352 passed, `cargo clippy --all-targets -- -D warnings` clean, `npm test` 406 passed, `npx tsc --noEmit` clean, and the process list showed nothing left behind. Linux was not run here.

## Spec Change Log

- 2026-10-18 (review round 1, Emils' decisions): (1) **Card** — a finished card shows the last line in place of branch · count · age (the card is a fixed 40 px), instead of as an extra line. (2) **Answer rule** — only single-key writes count; pasted text and terminal reply sequences never do; on a permission wait, Enter, a digit or `y`/`n` gives `busy` and Esc gives `idle`; on an elicitation or `agent_needs_input` wait, only Enter counts. The frozen Decisions and the matrix were amended.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 Hooked on first event: a session counts as hooked (busy→idle guess off, reconciliation on) only after its first accepted hook event, not at launch. When the endpoint later fails, every hooked mark is cleared and the tokens are dropped, so the poll's 3.3 rules come back.
- P2 The answer rule as amended (Spec Change Log): single-key writes only; CSI, OSC, DCS and bracketed paste ignored; Esc gives `idle` on a permission wait; only Enter counts on elicitation and `agent_needs_input` waits. Tests for each.
- P3 `PostToolUse` / `PostToolUseFailure` don't clear `Waiting` (parallel tools and subagents). Only `UserPromptSubmit`, a terminal answer, `Stop`/`StopFailure`, a later Waiting signal or an override leave it. Test.
- P4 Reply first: the handler sends the empty 200 before applying. The apply step (live lock, emit, notify, title lookup) runs off the request path (`spawn_blocking` or a channel). Fix the stale Design Notes wording in Implementation Notes.
- P5 Request hardening:
  - The path and bearer token are checked from the headers before any body is read.
  - Header and body reads time out after 10 s.
  - At most 64 concurrent connections.
  - A too-large body, declared or chunked, gets 413 with `Connection: close` and is not buffered.
  - Tests for chunked over-limit, over-cap and unauthenticated big bodies.
- P6 Overrides that change nothing: (`finished`|`waiting`, `other`) counts as agreeing, and `poll_overrides` only increments when the applied state differs from the held state. Its source becomes `Poll`. Test.
- P7 Late Notification: a `Notification` Waiting signal within 10 s after the session left `waiting` through a terminal answer is ignored. Test.
- P8 Session-id mismatches: ids announced by a `SessionStart` on the same token (for example after `/clear`) are remembered, and events carrying them are not counted as mismatches. Following the new id stays out of scope.
- P9 Diagnostics error: a read failure shows even after earlier successes ("last read failed: …" next to the stale counters).
- P10 Accessible label: the card's `aria-label` includes the waiting `detail` and the finished last line. Fix the `sessionCardTitle` doc comment (the line is already cut to 200).
- P11 Tests:
  - With the endpoint up, a failed launch (settings write or spawn) leaves no token and no hooked mark.
  - The 300-char `detail` cut.
  - End-to-end HTTP `Notification` and `StopFailure` posts.
  - An override starting from `waiting`.
- P12 Docs: the README notes that the bearer token is readable by the session's own processes, that the Windows file is protected only by the per-user `%TEMP%` ACL, and that a user `Stop` hook which blocks the stop may still produce a `finished` card and toast. The research doc records the GUI-verified 2.1.302 behaviour (see Implementation Notes).

**Defer:**
- D1 Suppress the false `finished` when the user's own `Stop` hook blocks the stop. Switchboard's hook fires in parallel and cannot see the decision.

**Dismiss:**
- "Assumptions unverified": verified in the GUI pass (Implementation Notes). Linux is gated by CI.

## Design Notes

- **Hook timing.** Hooks reach Rust on the axum task. `apply_hook` takes the live write lock, updates, collects transitions, emits `sessions://live` and runs notify `decide` while the lock is held, as 4.2 does for first output. So a hook event shows within one IPC hop, well under 1 s.
- **Counting disagreements.** Each hooked session has `disagree: u8`, reset to 0 by every hook event and by every agreeing poll, and incremented by a disagreeing poll. At 2 the poll's state is applied, `poll_overrides` increments, and the count resets.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator, foreground-guarded, with Emils' consent, because this spends a few tokens on a real `claude`:
  - Launch with permission mode `manual` and the prompt `Run the shell command: echo switchboard-hooks`.
  - Screenshot the `waiting` card. Confirm Claude's own permission dialog still shows, so an empty 200 doesn't deny.
  - Press `1`/Enter to allow, then screenshot `busy`. Screenshot `finished` with the last line.
  - Read Settings → Diagnostics (events > 0, overrides 0).
  - `/exit`.
