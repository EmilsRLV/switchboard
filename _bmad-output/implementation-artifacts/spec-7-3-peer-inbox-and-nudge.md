---
title: 'Story 7.3: Peer inbox and nudge'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '285f0fe0ed07e174166758709fde3f28fd1b8721'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Linked sessions are told to use native `SendMessage`, which is unverified, and they have no fallback channel. A message sent while the peer is idle can sit unseen. So cooperation between repos still needs the operator to relay.

**Approach:**
- The `switchboard` MCP server gains `send(peer, text)` and `inbox()`, allowed only between sessions joined by a cooperate edge.
- The app keeps each session's unread messages in memory and shows an unread badge on its card.
- When messages land for an idle session, the app nudges it with one injected line, reusing the 6.3/6.4 injection rules.
- The deferred Epic 6 wording now names this fallback.

**Decisions:**
- **No approval.** `send` and `inbox` never toast: the cooperate edge is the permission, and both are added to the session's `permissions.allow`.
- **`send({peer, text})`:**
  - **Finding the peer.** The cooperate peers come from 6.4's rule. `peer` matches a peer's session id, or `session:<id>`, else its name, exact first and then ignoring case.
  - **Refusals:** no match is `not a peer`. Two matching peers give an error naming their node ids. An empty text, or one over 4,000 characters, is refused.
  - **Stored.** The text keeps its line breaks, with other control characters stripped.
  - **Result.** It returns `{delivered: true, to: "<name>", unread: <recipient's count>}`.
  - **Cap.** A recipient holds at most 100 unread messages; the oldest are dropped first.
- **`inbox()`** returns `[{from, fromNodeId, text, at}]` in arrival order and clears them, so each message is returned once. The badge clears with it.
- **Badge.** A session card with unread messages shows a plain `N new` badge on line 1. It uses the count-badge look with `--fg-muted`, never the accent.
- **Nudge** (setting `peers.nudge`, default `true`):
  - When a session gets new messages, it gets one nudge once it is idle (idle or finished), not over a draft, and through the per-session injection slot.
  - **Text.** One message gives exactly `You have 1 message from "A". Call switchboard.inbox.` + `\r`. More than one gives `You have N messages from "A". …` (one sender) or `You have N messages from M peers. Call switchboard.inbox.`
  - **Timing.** The line is built when it is written, from the unread messages at that moment. Nothing is written if they were already read.
  - **When the session is busy** the nudge waits for the next idle, with no 60 s give-up. A draft holds it until the next idle with no draft.
  - **Loop guard (Emils' decision, review round 1).** A session gets at most 20 nudges in any hour. After that its messages still arrive and its badge still counts, but no nudge is typed. A one-line notice says `nudges paused for <name>: 20 in the last hour`. Nudges resume once the hour's count falls below 20.
  - **Once per arrival.** There is one nudge per arrival of new messages; a later idle with the same unread messages does not nudge again.
- **Live-link notice (deferred from 6.4).** When a cooperate edge joins two running sessions, each inbox also gets a notice from `switchboard`: `Linked to "<other>" (<purpose>).`. It counts as unread but does not nudge on its own; the 6.4 injected line already tells the session.
- **Wording (deferred from 6.4):**
  - The system prompt's peer instruction becomes `Prefer SendMessage to a peer by its name to coordinate; if that does not reach it, use switchboard send and inbox.`
  - The live-link line becomes `… Use SendMessage or switchboard.inbox to coordinate.`
- **Peer not running (Emils' decision):**
  - A message to a peer that is not running (historic or stopped) is queued in memory, and `send` returns `running: false`.
  - The inbox survives the peer's exit within this app run.
  - If the peer is resumed, it shows the badge and is nudged once idle.
  - Queued messages are lost when the app quits.
- **Runtime only.** Inboxes are dropped when the app quits.

## Boundaries & Constraints

**Always:**
- **Rust owns the inbox and its counts.** The UI renders them.
- **Injection** writes one line, waits for idle, and never writes over a draft (6.3/6.4 rules).
- **Tests and CI.** No `~/.claude` writes, tests never run the real `claude`, and CI stays green on both runners once Actions resumes.

**Never:**
- Messages between sessions that are not peers.
- Persisting inboxes.
- `request_review` (7.4).
- Accent styling for the badge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Send | A↔B linked; A `send("B", "endpoint is POST /auth/refresh, returns {token, expiresAt}")` | B's card shows `1 new`; `{delivered:true}` | — |
| Drain | B calls `inbox()` twice | first returns the message, second `[]`; badge cleared | — |
| Nudge | B idle when the message lands, nudge on | B's PTY gets `You have 1 message from "A". Call switchboard.inbox.\r` | — |
| Busy | B busy; 2 messages from A | after B goes idle: `You have 2 messages from "A". Call switchboard.inbox.` once | — |
| Not a peer | A not linked to C; `send("C", …)` | `isError` "not a peer" | — |
| Ambiguous | two peers named `ui-1` | `isError` naming both node ids | — |
| Nudge off | `peers.nudge: false` | badge only, no injection | — |
| Draft | B idle with a draft | no nudge until a later idle without a draft | — |
| Link notice | link two running sessions | each inbox gets `Linked to "<other>" (<purpose>).` | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `mcp/mod.rs`:
  - `READ_TOOLS` (:60), `ACT_TOOLS` (:63), `TOOLS` (:66) and `allowed_tools()` (:115-117): add `send` and `inbox` to the allowed list. The tests that pin these lists are `mcp/tests.rs` :54, :57, :61, :128-129 and :761, `hooks.rs` :1049-1053 and `lib.rs` :1790.
  - `tool_list()` (:280-374) and the `initialize` instructions (:267).
  - `call_app` (:379-387) routes the new tools, modelled on `act::set_status` (`act.rs` :422-441, `NOT_RUNNING` :26).
- New `inbox/mod.rs` (or `mcp/inbox.rs`):
  - a per-session `Vec<Message{from_id, from_name, text, at}>`, plus the arrival generation used for the nudge;
  - an `inbox://unread` event carrying a `{sessionId: count}` map;
  - a get command for the mirror;
  - store it on `AppState` next to `live_edges` and `approvals` (`settings/mod.rs` :382-385).
- **Peers:** `graph::cooperate_peers` (graph :1948) and `name_peers` (:2024-2080), zipping ids as `mcp::peers` does (mod.rs :602-612). The exact / loose / ambiguous shape follows `mcp::find_project` (:776-791).
- **Nudge** (`claude/live_edges.rs`):
  - Factor the idle wait, draft check and per-session slot out of `Job::wait_for_slot` (:824-867) so they no longer depend on a stored edge. Keep the edge jobs as they are.
  - The nudge waits for the next idle without the 60 s busy timeout.
  - Building blocks: `running_session` :615, `is_idle` :630, `has_draft` :165 and the `injecting` slot :140. Writing is `terms.write` :871.
- **Link notice:** `live_edges::edge_added` (cooperate sides) or `ipc::edge_add` (:406), plus 7.2's `link` act path.
- **Wording:**
  - `PEERS_INSTRUCTION` (`launch.rs` :381), pinned at :1332 and :1340 and by `lib.rs` :3076 and :3081;
  - `peer_line` (`live_edges.rs` :652-658), pinned at :1148-1168 and by `lib.rs` :3103 and :3109.
- **Settings:** `Settings` (`settings/mod.rs` :50-84) gains `peers: { nudge: true }`, with a default test at :679.
- **Exit:** the inbox is kept at session exit, queued for a later resume. Only a pending nudge job is retired, through the cleanup hooks at `ipc/mod.rs` :1851-1865.

**Frontend (`src/`):**
- `ipc/index.ts`: types and the event, mirrored in `App.tsx` into a `state/inbox.ts` store.
- `canvas/ChildNode.tsx` `SessionCard` (:64-103): the `N new` badge on line 1, using the count-badge style (DESIGN.md :281-283).
- `canvas/nodes.ts`: the data field and memo equality (:589), and the aria text (:855-879).
- `docs/DESIGN.md` documents the badge. `README.md` covers the tools, nudge, settings row (:1139) and the wording lines (:638, :652). `docs/research/claude-code-integration.md` :113-115 also covers the wording.

**Tests:** `mcp/tests.rs` `fixture()` (:288-319) has s1/s2 joined by a cooperate edge. The model for an end-to-end nudge test is `lib.rs` `cooperate_edges_name_peers…` (:3003, with short `Timeouts` at :3012) and `line_echo_program` (:2751).

## Tasks & Acceptance

**Execution:**
- [x] `inbox/`, `mcp/mod.rs`, `claude/live_edges.rs`, `claude/launch.rs`, `settings/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests): send, inbox, the nudge, the link notice, the wording and the setting.
- [x] `ipc/index.ts`, `App.tsx`, `state/inbox.ts`, `ChildNode.tsx`, `nodes.ts`, CSS (+vitest): the badge.
- [x] `README.md`, `docs/DESIGN.md`, `docs/research/claude-code-integration.md`: the tools, the nudge, the setting and the badge.

**Acceptance Criteria:**
- Given A and B linked (stub sessions), when A calls `send("B", "endpoint is POST /auth/refresh, returns {token, expiresAt}")`, then B's unread count is 1, and B's first `inbox()` returns the message while the second returns none.
- Given B idle with the nudge on, when the message lands, then B's PTY receives exactly `You have 1 message from "A". Call switchboard.inbox.` + Enter.
- Given A not linked to C, when A calls `send("C", …)`, then it is refused with "not a peer".
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- 2026-10-24 GUI pass (orchestrator; two stub sessions on `alpha` joined by a dragged cooperate edge; curl with each session's token):
  - Linking put `Linked to "<other>" (no stated purpose).` in both inboxes, so each card showed `1 new`.
  - A's `send(peer: <B id>, "endpoint is POST /auth/refresh, returns {token, expiresAt}")` returned `{delivered:true, to:"alpha-0bb0", unread:2}`, and B's card showed `2 new` (muted count-badge look).
  - `send("nobody", …)` returned `isError` `not a peer: nobody`.
  - B's first `inbox()` returned the link notice and the message, in arrival order with `from`/`fromNodeId`/`at`, and its badge cleared. The second call returned `[]`.
  - The stub never goes busy, so a nudge's effect cannot be seen on screen; the lib.rs end-to-end test covers it.
  - The orchestrator deleted the leftover session files.

- 2026-10-24 Closed on local Windows verification (Emils' decision): cargo test (490), clippy, tsc, vitest (564), the debug build and one GUI pass; the GUI re-run was skipped because round 1 changed Rust only. **Linux CI is pending:** GitHub Actions is suspended. Check the run for `6bef4a8` or later on both runners when Actions resumes. Emils' checks with the real `claude` are still open: two linked sessions coordinating through `send`/`inbox` after a nudge, and the 6.4 native `SendMessage` check.

## Spec Change Log

- 2026-10-24, review round 1. The blind-hunter found that two linked agents answering each other with `send` can loop without limit, each nudge starting a new turn. **Emils' decision:** at most 20 nudges per session per hour; past that, messages and badges continue but no nudge is typed, and a notice says so. Also decided by Emils: a viewer for message text is deferred (deferred-work). KEEP: one nudge per arrival, waiting for idle, never over a draft, and the exact one-message text.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V):

**Patch:**
- P1 (medium; B, E) `take_line` marks the arrival nudged before the PTY write. A failed write is therefore never retried. Mark it nudged only after a successful write, or roll it back on failure. Test it.
- P2 (medium; decision above) The loop guard: 20 nudges per session per hour, then the `nudges paused for <name>` notice. Test it with a small limit.
- P3 (low; E) Arrivals while `peers.nudge` is off are not nudged when it is turned back on. When the setting turns on, start the owed nudges for running sessions.
- P4 (low; B, V) The 6.4 test's one-live-end wait was weakened, so it passes on `Failed/NOT_CONFIRMED`. Fix the cause instead: make `wait_until` answer each cursor query only once per terminal, so the console's F3 recall stops. Restore the `docs-3` assertion.
- P5 (low; B) The README security paragraph still says "there are no act tools yet". Say what the token can do now: the act tools, plus `send`, which can make a nudge type into a peer.
- P6 (low; B) Messages dropped at the 100-message cap are not reported. `send` returns `dropped: N` when it pushes some out, and the recipient's inbox gets a notice `N older messages were dropped`.
- P7 (low; B, E) A deleted session's mailbox stays for the whole app run. Remove it, and its nudge job, when the session ref or its project is removed.
- P8 (low; B, E) The 4,000-character limit is checked before cleaning. Check the cleaned text.
- P9 (low; B) Message text keeps bidi overrides and U+2028/U+2029. Strip U+202A–U+202E and U+2066–U+2069, and turn U+2028/U+2029 into `
`.
- P10 (low; B) The `send` and `inbox` annotations are undecided. Mark both not read-only and not destructive, `inbox` clearing only what it returns. Pin them in the tool-list test.
- P11 (low; B) The docs say "not running" without saying that a session in an outside terminal also counts. Say "not running in a Switchboard terminal" in the tool description and the README.
- P12 (low; B) The negative nudge checks depend on 400 ms sleeps. Also check the inbox state (`nudged == arrival`, no job) directly.
- P13 (low; V, B) Tests and names:
  - a labelled 7.2 `link` act gives notices with `(<label>)`;
  - an exact name match wins over a case-insensitive one;
  - rename the two stale tool-list and config test names.

**Defer:**
- (Emils' decision; B) An operator-facing viewer for peer message text.
- (low; V) A render test for the `N new` badge wiring. There is no DOM test environment; the GUI pass showed it.

**Reject:**
- (B) An unconfirmed nudge is treated as delivered: re-nudging on no `busy` would repeat lines into a session that already got one. It is logged, and the badge stays.
- (B, E) Messages from a peer that was unlinked afterwards are still delivered and nudged: they were sent while the two were peers, which the spec allows. `send` is checked at send time.
- (B) A re-added edge gives another link notice: it is a new link, and a notice is correct.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator** (foreground-guarded, stub `claude`, curl with each session's token): link two stub sessions, `send` from one, check the badge on the other, then `inbox()` clears it.
- **Emils** (real `claude`): two linked sessions coordinate through `send`/`inbox` after a nudge. Run the still-pending 6.4 native `SendMessage` check too.
