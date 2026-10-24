---
title: 'Story 7.2: Act tools with approval'
type: 'feature'
created: '2026-10-24'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '3bc2281ece238ec4bd9f8848fafb90e6685ebaa4'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A session can read the graph (7.1) but cannot act on it. It cannot start a helper session in another repo, link nodes, or tell the operator what it is waiting on. Letting agents act with no gate would take control away from the operator.

**Approach:**
- **Tools.** The `switchboard` MCP server gains four act tools: `start_session`, `link`, `unlink` and `set_status`.
- **Approval.** Every act tool except `set_status` waits on the operator. An in-app approval toast shows exactly what will run, with Allow / Deny, plus "Always for this edge" when an edge joins the caller and the target.
- **Rust owns the requests.** Pending requests and policies live in a Rust `approvals` module.

**Decisions:**
- **`start_session({project|branch, prompt?, name?, model?, effort?, permissionMode?, addDirs?, cooperateWithMe?})`:**
  - **Target.** `project` is an id or a label; a label shared by two projects is an error. `branch` is `<project id or label>:<branch>` and is resolved as a branch launch (5.3). A branch with no worktree is an error: the tool does not create worktrees.
  - **Launch.** The launch is built through the same path as the launch sheet: the default name `<label>-<4 hex>` when no name is given, `bypassPermissions` refused, and add-dirs normalised.
  - **The toast** shows the target and the exact argv the app will run (`claude --session-id … --name … … --mcp-config …`).
  - **On Allow:**
    - The session starts in the background: its card appears and no terminal is focused.
    - With `cooperateWithMe`, a cooperate edge between the caller and the new session is stored before the new session's system prompt is built, so its prompt names the caller as a peer.
    - It returns `{nodeId, name}`.
  - **On Deny** it returns `isError` with `the operator denied: start a session on <target>`.
- **`link({from, to, kind, label?})`:**
  - Ends are written as `workspace()` lists them (`project:<id>`, `session:<id>`, `branch:<projectId>:<name>`); `self` means the caller.
  - `kind` must match the kind the app derives (6.1), otherwise it is an error.
  - The toast shows `link <from> → <to> (<kind>) "<label>"`.
  - Allow stores the edge with the 6.1–6.4 effects (live `/add-dir`, peer line) and returns the edge id. Refusals use 6.1's texts.
- **`unlink({edgeId})`:** the toast describes the edge. Allow deletes it as Delete does (6.3 and 6.4 cleanup). An unknown edge is an error.
- **`set_status({text})`:**
  - No approval.
  - The text is cleaned like peer values: control characters and U+2028/U+2029 stripped, cut to 120 characters. An empty text clears it.
  - It shows on the session card's second line in place of the meta, until the session's state changes or the next `set_status`.
  - It is runtime only. `my_node`, `node` and `sessions` include it as `statusText`.
- **The "edge" for Always (Emils' decision).** The pair is the caller session and the request's target:
  - for `start_session`, the project node, or the branch node for a branch target;
  - for `link`, the end that is not the caller;
  - for `unlink`, the deleted edge's end that is not the caller.

  "Always for this edge" is offered only when a stored edge (either kind, either direction) joins that pair.
- **Policy storage (Emils' decision):**
  - "Always" sets an optional `agentAllowed: true` on that stored `Edge` in `workspace.json`.
  - It survives restarts, and it goes when the edge is deleted.
  - The edge inspector shows `Agent actions: always allowed` with Revoke.
  - Older workspace files load unchanged.
- **Per-workspace allow all (Emils' decision):**
  - A persisted workspace setting `agentActions: ask | allowAll`, toggled from the palette with "Agent actions: allow all" / "Agent actions: ask".
  - While it is `allowAll`, the Settings pane says so and act tools run without a toast.
  - Each act run without a toast, whether through allow all or an edge's Always, shows a one-line notice (`<caller> started <name> on ui`).
- **Toasts:**
  - Pending requests stack at the bottom right, oldest first.
  - Each toast shows the caller's name, the action, and the argv or description in mono, with buttons Allow, Deny and, when offered, Always for this edge.
  - The toast uses the attention accent.
  - Palette commands "Allow agent request" and "Deny agent request" act on the oldest one.
  - While Switchboard is not the focused window, a new request also sends an OS notification (`<caller> wants to <action>`). It uses the Story 3.3 path and follows the `notifications.waiting` setting; clicking it brings the app to the front (Emils' decision, review round 1).
  - A request nobody answers within 120 s is denied (`the operator did not answer`).
  - A request whose caller exits is dropped.
- **Connections.** A pending call keeps its HTTP request open. The `/mcp` route must not be cut by the 10 s idle timeout while the reply is pending.

## Boundaries & Constraints

**Always:**
- Rust decides, launches and stores. The UI only shows requests and sends the operator's answer.
- The argv shown is exactly the argv run.
- The act tools are **not** added to the session's `permissions.allow`. Claude Code may also ask its own permission before calling them.
- No `~/.claude` writes, and tests never run the real `claude` (stubs only). Both CI runners stay green once Actions resumes.

**Never:**
- `--dangerously-skip-permissions` or `bypassPermissions`.
- Creating a worktree from an agent request.
- `request_review`, `send`/`inbox` (7.3, 7.4).
- Read tools prompting.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Start, allowed | A calls `start_session({project:"ui", prompt:"…", cooperateWithMe:true})`, policy ask | toast with argv; Allow → session starts in background, cooperate edge A↔new, new prompt names A; returns `{nodeId,name}` | — |
| Start, denied | same, Deny | `isError` "the operator denied: start a session on ui" | — |
| No answer | toast ignored 120 s | `isError` "the operator did not answer" | toast removed |
| Always | A ↔ ui joined by an edge, operator picks Always | runs; the next act call A→ui runs without a toast; edge inspector shows the policy with Revoke | Revoke → next call asks again |
| No edge | A → `api`, no edge between | toast has Allow/Deny only | — |
| set_status | `set_status("waiting on ui's endpoint")` | card line 2 shows it until state change / next call | — |
| Bad link | `link` kind mismatch or 6.1 refusal | `isError` with the reason, no toast | — |
| Branch without worktree | `start_session({branch:"ui:old"})` | `isError` "branch has no worktree", no toast | — |
| Caller exits | pending request, A exits | toast dropped | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `mcp/mod.rs`:
  - `TOOLS` (:51) and `tool_list` (:233-270): add the act tools with `readOnlyHint: false` and accurate schemas. Update the "Read-only." `initialize` instructions (:220).
  - `allowed_tools()` (:77) stays read-only.
  - The `Tools` callback (:73, built at hooks.rs:726) needs the `AppHandle` for launches, edges and emits. Calls already run in `spawn_blocking` (:140), so a blocking wait on the operator's answer is fine.
- `claude/hooks.rs`: the `Limited`/`Conn` idle timer (:609-660, `READ_TIMEOUT` :438) can fire while a reply is pending. Stop it applying once a `/mcp` request has been read. Test with a tool that sleeps longer than 10 s, modelled on `a_silent_connection_is_closed_after_the_read_timeout` (:1089).
- New `approvals/mod.rs`: holds the pending requests (id, caller, tool, description or argv, offered Always, deadline), a channel per request, the 120 s auto-deny, drop on caller exit, and an `approvals://pending` event. Commands `approvals_get` and `approval_answer(id, allow|deny|always)`.
- **Launch reuse** (`ipc/mod.rs`): `session_launch` (:1180-1234), `new_launch` (:1299), `prepare_launch` (:1584), `start_claimed` (:1373), `run_launch` (:1651).
  - The session id comes from `launcher.propose`, and `claim` refuses a stale one.
  - The argv for the toast is `prepare_launch`'s args plus `with_mcp_config` (launch.rs:252, `mcp_path` :740).
  - Branch targets go through `launch::resolve_branch` (launch.rs:196).
  - For `cooperateWithMe`, register the new session's `SessionRef` and the cooperate edge before `prepare_launch`, so `graph::session_peers` (ipc:1597) sees it.
- **Edges:** `graph::add_edge` (:1598), `set_edge_label` (:1674), `edge_kind` (:1505) and `remove_edge` (:1697). Mirror the IPC side effects in `edge_add` (ipc:406, `live_edges::edge_added`) and `edge_remove` (ipc:423, `forget_edge`).
  - `Edge` (graph:172) gains the optional `agent_allowed` field (serialised as `agentAllowed`), and `Workspace` (graph:50-64) gains `agent_actions`. Their serde defaults keep older files loading.
- **Status text:** `LiveSession` (claude/live.rs:166-186) gains runtime `status_text`, cleared on every state change. The state writes are at :442-457, 477, 566, 577, 593, 603, 653, 672, 698 and 803, and `carried()` at :882 is the model. Add `statusText` to the 7.1 tool outputs.

**Frontend (`src/`):**
- `ipc/index.ts`: types, wrappers and the `approvals://pending` event; mirrored in `App.tsx` (:67-123).
- A new `components/ApprovalToasts.tsx` and a `state/approvals.ts` store.
- `canvas/ChildNode.tsx` (`SessionCard` :62-98): line 2 shows `statusText` in place of the meta. `canvas/nodes.ts` (:429-436).
- `components/EdgePane.tsx`: the policy row and Revoke, between the Now lines and Label (:94-129).
- `commands/builtins.ts`: Allow/Deny agent request, and Revoke for the selected edge.
- `docs/DESIGN.md`: the approval toast pattern, and its accent added to the lint allow-list (:446).

**Tests:**
- `mcp/tests.rs`: `fixture()` (:274) and `server()` (:136).
- lib.rs `a_launched_session_reaches_the_mcp_endpoint…` (:1739), with the stub program for launches.
- Answer approvals by calling `approval_answer` directly in tests.

## Tasks & Acceptance

**Execution:**
- [x] `approvals/mod.rs`, `mcp/mod.rs`, `claude/hooks.rs`, `ipc/mod.rs`, `graph/mod.rs`, `claude/live.rs`, `lib.rs` (+tests): the act tools, approval flow, policy, status text and idle-timer fix.
- [x] `ipc/index.ts`, `App.tsx`, `state/approvals.ts`, `ApprovalToasts.tsx`, `ChildNode.tsx`, `nodes.ts`, `EdgePane.tsx`, `builtins.ts`, CSS (+vitest): toasts, card status, policy row and palette rows.
- [x] `README.md`, `docs/DESIGN.md`, `docs/research/claude-code-integration.md`: the act tools, approvals and policy.

**Acceptance Criteria:**
- Given session A (stub) with policy ask, when A calls `start_session({project:"ui", prompt:"…", cooperateWithMe:true})` and the operator allows, then a session starts with the exact argv shown, a cooperate edge A↔new exists, and the call returns the new node id. If the operator denies, the call returns a readable error.
- Given `set_status("waiting on ui's endpoint")`, when called, then the card shows the text until the next state change or `set_status`, with no toast.
- Given Always chosen on an A–ui edge, when A calls again, then no toast appears, and the edge inspector shows the policy with Revoke. After Revoke, the next call asks again.
- Given a pending call that the operator answers after 15 s, when the answer comes, then the HTTP reply still arrives.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Session id.** An agent start takes a fresh v4 id (as Fork does) instead of `launcher.propose`/`claim`: a
  proposal is per project, so proposing for `ui` would have made an operator's open launch sheet on `ui` stale.
  The double-start guard is unchanged (`run_launch` refuses an id the live map or a terminal already has).
- **Exact argv.** `ipc::plan_agent_launch` builds the argv for the toast (with `cooperateWithMe`, the caller is
  added to the system prompt's peers before the edge exists); `ipc::start_agent_launch` stores the ref and the
  cooperate edge, builds the argv again from stored state and starts only if it is identical
  (`LAUNCH_CHANGED` otherwise, with the edge and ref taken back).
- **Not remembered.** An agent's model / effort / permission mode are not written to the project's
  `launchDefaults` (they are the agent's choices, not the operator's). The project's context-edge folders are
  prefilled as the sheet does, then the agent's `addDirs`.
- **No peer line on start.** The cooperate edge `start_session` stores is not passed to
  `live_edges::edge_added`: the caller gets the new node in the tool's reply and the new session has the caller
  in its prompt, so no line is injected into either. `link` does run every 6.1–6.4 effect.
- **Card line.** The state word stays first; the status text replaces branch, count and age (and a finished
  card's last line), as the Story 4.3 last line does.
- **Idle timer.** `hooks::Hold` (shared through axum `ConnectInfo`) suspends a connection's 10 s idle timer while
  one of its `/mcp` replies is pending, and wakes the connection when the reply is done so the timer restarts
  from then. Without it the 15 s test reply never arrives (checked by disabling the hold).
- **Review round 1.** A `/mcp` call carries an id (thread-local while its tool runs); dropping the handler
  before the reply cancels that call's request (`approvals::cancel_call`), or refuses its later `ask`. The exit
  hook now drops a caller's requests after `process_exited`, and `ask` refuses a non-live caller under its lock.
  Always is stored only after the act succeeded (`policyError` in the result otherwise). A request's toast also
  goes out as an OS toast via `notify::on_approval` (body `Allow or deny it in Switchboard`).
- **Events.** Besides `approvals://pending`: `approvals://notice` (the one-line notice of an act without a toast)
  and `approvals://started` (the started session's `TermInfo`, so the terminal store knows it without focusing).

- 2026-10-24 GUI pass (orchestrator, scratch projects `alpha`/`beta`, stub `claude` that exits after 90 s; MCP calls made with curl using the session's token):
  - `set_status("waiting on beta's endpoint")` returned `statusText` with no toast, and the card read `idle · waiting on beta's end…`.
  - `start_session({project:"beta", prompt, cooperateWithMe:true})` showed the bottom-right toast `alpha-88bf wants to start a session on beta`, with the full argv in mono (`… --session-id … --name beta-1e9e --settings … --mcp-config …`), Allow / Deny / Always for this edge, and `denied in 118 s`.
  - The stub caller exited while its toast was waiting. The toast was dropped and the call returned `the caller exited` (matrix row "Caller exits").
  - A caller with no edge to `beta` got a toast with Allow / Deny only (matrix row "No edge").
  - With a context edge from the caller to `beta`, Always for this edge:
    - started `beta-28f3`, returning `{name, nodeId}`, with a cooperate double line from the caller;
    - the next `start_session` ran with no toast and the notice `alpha-475d started beta-0710 on beta`;
    - the edge inspector showed `Agent actions: always allowed` with Revoke.
  - After palette "Revoke agent policy", the next request showed the toast again. Deny returned `the operator denied: start a session on beta`.
  - The orchestrator deleted the six session files left after the forced kill.

- 2026-10-24 GUI re-run after the patch round (orchestrator, same setup, all within the stub's 90 s life):
  - `set_status` put `waiting on beta` on the card.
  - The toast showed Allow / Deny / Always for this edge. Always started `beta-8212` with the cooperate double line.
  - The second `start_session` ran with no toast and the notice `alpha-471e started beta-3cda on beta`.
  - The inspector showed `Agent actions: always allowed` with Revoke.
  - After palette "Revoke agent policy" the next request showed the toast again, and Deny returned `the operator denied: start a session on beta`.
  - Switchboard stayed focused throughout, so no OS notification was sent.

## Spec Change Log

- 2026-10-24, review round 1 (blind-hunter: a toast is invisible from another window, and the 120 s auto-deny makes "nobody saw it" the likely outcome). **Emils' decision:** a pending request also sends an OS notification while Switchboard is not focused, using the 3.3 path and the `notifications.waiting` setting. KEEP: the in-app toast stack, its buttons, the 120 s deny and the drop on caller exit.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V):

**Patch:**
- P1 (high; B, E) An Allow after the MCP client gave up (it timed out or disconnected) still runs the act. Cancel the pending request when the `/mcp` handler is dropped (a guard that cancels on Drop), so a late answer finds nothing and the toast goes. Fix the research doc's "the late answer is dropped". Test a disconnect while a request is pending.
- P2 (medium; B, E) "Always" on an `unlink` whose only joining edge is the one being deleted is offered and then lost. Leave the deleted edge out when deciding to offer Always.
- P3 (medium; E, B) Always is stored before the act runs. A failed act (`LAUNCH_CHANGED`, a duplicate or vanished edge) leaves a standing policy, and a failed Always write is only logged. Store `agentAllowed` only after the act succeeds, and say in the result when the policy could not be stored.
- P4 (medium; B) Nothing caps requests. Each pending request holds one of the 64 connections and a blocking thread for up to 120 s. Allow at most 3 pending requests per caller; a fourth is refused with `too many pending requests`.
- P5 (medium; decision above) An OS notification for a new request while Switchboard is not focused.
- P6 (low; E) The caller can exit between planning and `ask`, leaving an orphan toast. `ask` refuses under its lock when the caller is no longer live.
- P7 (low; E) `cooperateWithMe` from a caller that is not yet an edge end fails only after Allow. Check before asking.
- P8 (low; E) The palette's Allow/Deny agent request act on `pending[0]` even when an answer for it is already in flight. Pick the oldest request without one.
- P9 (low; B) The `link` toast shows the label cut by `peer_value` (120), but the stored label is cut at 200. Show the label exactly as it will be stored. Store the label with the edge in one step; otherwise return the label failure rather than reporting success.
- P10 (low; B) A failed approvals load is recorded but never shown. Show it the way other mirror failures are shown.
- P11 (low; B) The toast's `aria-live` re-announces the per-second countdown. Make the countdown `aria-hidden`, with only new requests announced.
- P12 (low; B) The "Always for this edge" button gets a title stating its scope: `Every agent action from <caller> on <target> runs without asking until revoked`.
- P13 (low; B) `TOOLS` repeats `READ_TOOLS` and `ACT_TOOLS` by hand. Build it from them, or test that it equals them.
- P14 (low; B) A `start_session` prompt is not length-checked. Refuse a prompt over 8,000 characters before asking.
- P15 (medium; V, B) Tests:
  - a status text kept across a poll with the same state and cleared on a state change;
  - the `LAUNCH_CHANGED` path undoes the edge and the session ref;
  - a successful branch `start_session` with `model` and `addDirs`, which runs in the worktree with those flags and offers Always for an edge to the branch node;
  - Always on an `unlink` lands on the surviving edge;
  - the TS wire names and arguments of `approvalAnswer`, `edgeSetAgentAllowed`, `workspaceSetAgentActions` and `approvalsGet`;
  - a silent `start_session` under `allowAll`.

**Reject:**
- (B, E) `set_status` returns 120 characters plus `…`, and turns `"` into `'`: the same cleaning as Story 6.4's peer values (`peer_value`), which that story accepted. The docs' "cut to 120 characters" follows the 6.4 wording.
- (B) Always covers every act on the pair, not just one tool: that is the frozen decision and the I/O row "Always". P12 states the scope on the button.
- (B) No spawn depth or count limit under allow all or Always: the operator opted in; P4 caps the pending requests.
- (B) An ambient marker or a confirm step for allow all: the frozen decision is a Settings line plus a notice per act.
- (B) The idle-timer tests are slow (15 s and 25 s): acceptable, and making `READ_TIMEOUT` configurable adds surface for tests only.
- (B) `set_status` racing a session exit: a millisecond window, and the session has gone anyway.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator, foreground-guarded, stub `claude`, curl with the session token:**
  - `start_session`: the toast appears with the argv; Allow gives a new card and the cooperate edge; Deny returns an error.
  - `set_status`: the card shows the text.
  - Always and Revoke in the edge inspector.
- **Emils, real `claude`:**
  - ask a session to start a helper on another project and approve it;
  - note whether Claude Code also asks its own permission;
  - check that a long wait at the toast doesn't time out the tool call.
