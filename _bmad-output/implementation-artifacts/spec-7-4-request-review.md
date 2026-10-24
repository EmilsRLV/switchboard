---
title: 'Story 7.4: Request review'
type: 'feature'
created: '2026-10-25'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '87d211c2408a38c455e08f4ea053e3e0bf94bc7e'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A session has no way to say "this is ready, look here". The operator finds out only by watching terminals, so review happens late or at the wrong moment.

**Approach:**
- The `switchboard` MCP server gains `request_review({summary, paths?})`.
- The app flags the session's node, shows a non-blocking review toast and, while unfocused, sends an OS notification.
- Clicking the flag or the toast opens a new **Review** pane on that node. Until Epic 8 builds the diff view, the pane is a file list: the summary and the listed paths.

**Decisions:**
- **`request_review({summary, paths?})`:**
  - **Summary.** Required. Cleaned like peer values (control characters and U+2028/U+2029 stripped) and cut to 500 characters.
  - **Paths:**
    - At most 50.
    - A relative path resolves against the caller's cwd.
    - Each must lie within the caller's cwd, its worktree or project folder, or one of its add-dirs (7.1 record). Any other path refuses the whole call with `outside this session's folders: <paths>`.
    - A path that does not exist is accepted and shown as `missing`.
  - **Returns** `{flagged: true, paths: N}`.
- **No approval (Emils' decision).** `request_review` never asks the operator. It is added to the session's `permissions.allow`, so Claude Code does not prompt either; this overrides the epic context's "every act tool is gated" for this tool.
- **Flag:**
  - The session card shows a plain `review` flag on line 1, beside the 7.3 badge.
  - It stays until the operator opens the review or runs "Clear review flag".
  - A new request from the same session replaces the summary and paths.
  - Runtime only.
- **Toast:**
  - A review toast joins the bottom-right stack (7.2 look): `<name> asks for review: <summary>`, with Open and Dismiss buttons.
  - It does not wait or expire. Dismiss closes the toast and keeps the flag.
- **OS notification.** While Switchboard is not focused, a notification `<name> asks for review` is sent through the 3.3 path, under a new setting `notifications.review` (default on). Clicking it opens the review.
- **Review pane (pre-Epic 8):**
  - A right-side pane titled with the session's name, showing the summary and one row per path, with the path relative to the session's folder and a `missing` mark where it applies.
  - Opening it clears the flag.
  - Epic 8 will replace the list with its diff and file views. 7.4 builds only the list.
- **Palette:** "Open review request" (for the selected flagged session, or the newest request) and "Clear review flag".
- **Reading it back.** `my_node`, `node` and `sessions` include `reviewRequested: true` while flagged.

## Boundaries & Constraints

**Always:**
- **Ownership.** Rust owns the flags and the path checks; the UI renders them.
- **Files are never opened.** Nothing is read, written or opened outside the app; the pane only lists paths.
- **No `~/.claude` writes**, and tests never run the real `claude`.

**Never:**
- Diff views, file contents, or external open (Epic 8).
- Persisting flags.
- Paths outside the session's folders.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Request | `request_review({summary:"token refresh done", paths:["src/auth/refresh.ts"]})` | card shows `review`; toast with Open; `{flagged:true, paths:1}` | — |
| Open from toast or flag | click Open / flag | Review pane on that session: summary + `src/auth/refresh.ts`; flag cleared | — |
| Outside path | `paths:["C:/Windows/win.ini"]` | `isError` `outside this session's folders: …`, no flag | — |
| Missing file | path inside cwd, not on disk | listed with `missing` | — |
| Replace | second request | summary and paths replaced, one toast | — |
| Unfocused | app not focused | OS notification; click opens the review | `notifications.review: false` → none |
| Clear | palette "Clear review flag" | flag gone, pane not opened | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `mcp/mod.rs`:
  - The tool lists `ACT_TOOLS` (:66), `TOOLS` (:72) and `allowed_tools()` (:133) all need the tool added.
  - Also update the `initialize` instructions (:285), `tool_list()` (:298) and the `call_app` dispatch (:417).
  - Path facts come from `session_facts` (:606) and `place_of` (:479). Add-dirs come from `add_dirs` (:657).
- The no-approval pattern is `mcp/act.rs` `set_status` (:422-441).
- New `review/mod.rs` (runtime flags), modelled on `inbox/mod.rs`:
  - a Mutex store;
  - the `review://requests` event, carrying the full map, with an emit like `inbox` :193;
  - `forget_sessions` cleanup, as at :446;
  - a get command, plus `review_open(sessionId)` and `review_clear(sessionId)`.
- Path helpers in `graph/mod.rs`: `path_within` (:674) and `same_path` (:2270).
- `notify.rs`: a review variant of `on_approval` (:162) whose `extra` says "open review". `handle_action` (:199) routes it.
- `settings/mod.rs` adds `notifications.review`, defaulting to true.

**Frontend (`src/`):**
- The new `review` pane:
  - add it to the `Pane` union (`state/ui.ts` :34);
  - render it in `App.tsx` (:220-226);
  - reset it in `leave` (`commands/panes.ts` :37-43);
  - give it a store such as `state/review.ts`, following the `state/worktree.ts` / `commands/worktree.ts` pattern;
  - the component is `components/ReviewPane.tsx`.
- `components/ReviewToasts.tsx` sits alongside `ApprovalToasts.tsx` and reuses the `.approvals` stack and the `.approval-toast` look.
- `canvas/ChildNode.tsx` (:74-85): the `review` flag goes beside `session-unread`, and clicking it opens the review. The data comes from `Canvas.tsx` (:254).
- `App.tsx` handles the mirror, as at :158-161, and the notification click path (`commands/attention.ts`).
- `commands/builtins.ts`: `review.open` and `review.clear`. Update the id list in `builtins.test.ts` (:83).
- `docs/DESIGN.md` documents the flag, the toast variant and the pane. `README.md` covers the tool, settings row and palette.

## Tasks & Acceptance

**Execution:**
- [x] `review/`, `mcp/mod.rs`, `notify.rs`, `settings/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests): the tool, path checks, flags, notification and commands.
- [x] `ipc/index.ts`, `state/review.ts`, `ReviewPane.tsx`, `ReviewToasts.tsx`, `ChildNode.tsx`, `nodes.ts`, `App.tsx`, `ui.ts`, `panes.ts`, `builtins.ts`, CSS (+vitest): the flag, toast, pane and palette.
- [x] `README.md`, `docs/DESIGN.md`: document all of the above.

**Acceptance Criteria:**
- Given a session (stub), when it calls `request_review({summary:"token refresh done", paths:["src/auth/refresh.ts"]})`, then its node is flagged and a review toast appears. Opening either one shows the Review pane with the summary and that path, and clears the flag.
- Given a path outside the session's folders, when it is requested, then the call is refused and nothing is flagged.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- Interpretations: the allowed folders are the cwd, the linked worktree (when the cwd is in one), the project folder and the add-dirs (both `my_node` sources). `..` is resolved lexically and cannot climb past the root; containment is then judged on the real location (deepest existing ancestor and the roots canonicalised, links followed); a drive-relative path (`C:foo`) counts as outside. Paths are cleaned like the summary. `review_open` / `review_clear` carry the `seq` the UI showed; a stale one changes nothing. A path listed twice is listed once. The summary keeps `"` (only control characters, U+2028/U+2029 and bidi controls are stripped) and is cut like `set_status` (500 characters, then `…`).
- Rust keeps each session's last request after the flag is lowered (the pane reads it; "Open review request" can reopen the newest). `missing` is re-checked (an existence check only) on every open. Requests go with the session's ref or project (`forget_sessions`), like the inbox.
- The toast is UI-side dismissal keyed by the request's `seq`, so a replacement request shows its toast again. Review toasts render inside the approvals stack (one `.approvals` container) with the `.approval-toast` look, accent border included.
- `reviewRequested: true` is added only while flagged (absent otherwise). The OS notification body is the summary (cut to 200); its `extra` carries `review: true`, and `notify://reveal` gains `review` (serde default `false`).

- 2026-10-25 GUI pass (orchestrator; stub session on `alpha`; curl with its token; a scratch `notes.txt` in alpha, removed afterwards):
  - `request_review({summary:"token refresh done", paths:["src/auth/refresh.ts","notes.txt"]})` returned `{flagged:true, paths:2}`.
  - The card showed a muted `review` flag, and the bottom-right toast read `alpha-50a7 asks for review: token refresh done` with Open and Dismiss.
  - A request with `C:/Windows/win.ini` returned `isError` `outside this session's folders: C:/Windows/win.ini`.
  - Open from the toast showed the Review pane: title `alpha-50a7`, SUMMARY, and PATHS with `src/auth/refresh.ts` marked `missing` and `notes.txt`. The flag cleared.
  - A second request (`second pass: tests added`, `notes.txt`) flagged the card again. Clicking the flag opened the pane with the replaced summary and paths.

- 2026-10-25 GUI re-run after the patch round (orchestrator, same setup), with the same results:
  - the flag and the toast appeared;
  - the outside path was refused;
  - opening from the toast showed the pane, now with `Requested 12:19 AM` under the summary, and `src/auth/refresh.ts` marked `missing`;
  - after Esc, a second request raised the flag and a new toast;
  - clicking the flag opened the replaced request, and both the flag and the toast cleared.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V):

**Patch:**
- P1 (medium; B) Containment is checked on the text only, so a symlink or junction inside the cwd that points outside passes, and `missing` then reveals whether the outside file exists. Canonicalise existing paths and the allowed folders before checking, and refuse a path that resolves outside. Epic 8 will open these paths.
- P2 (low; B, E) A request with no paths fails when the session's cwd is unknown. Resolve the folders only when there are paths.
- P3 (low; B, E) `open` stats up to 50 paths while it holds the review lock, and every change emits while the store lock is held. Check existence and emit after the lock is released. Reword the README, the module doc and the code comments to say "existence is checked; contents are never read".
- P4 (low; B) `review_open` and `review_clear` take only `sessionId`, so they can lower a replacement request the operator never saw. Pass the `seq` the UI showed, and ignore the call when it no longer matches.
- P5 (low; B, E) A new request for the session whose Review pane is open raises its flag and toast again while the operator is already looking at it. When the open pane's session gets a new `seq`, mark it opened.
- P6 (low; B) "Open review request" prefers the selected session only while it is flagged. Prefer the selected session whenever it has a request, and fall back to the newest one.
- P7 (low; E) Paths are not cleaned. Strip control characters, bidi overrides and U+2028/U+2029 from each path, as the summary is cleaned.
- P8 (low; E) Enter on the focused card flag also fires the global Enter command. Stop the propagation on the button's keydown.
- P9 (low; B) Screen readers do not announce a replacement toast, because toasts are keyed by session. Key them by session and `seq`, and label the stack "Agent requests and reviews".
- P10 (low; B) The UI state in `state/review.ts`:
  - prune `dismissed` when a request goes;
  - show when review was requested (`at`) in the pane.
- P11 (low; B) Docs and leftovers:
  - the README says the summary is "500 characters plus …" and that the OS notification body is cut to 200;
  - the README documents `review_clear` on a session with no request;
  - repair the `NotificationSettings` doc comment;
  - rewrap the `panes.ts` header;
  - fix the stale `listed[9..]` loop and comment, and the config test name, in `mcp/tests.rs`.
- P12 (medium; V) Tests:
  - a `toFlowNodes` case where `review` reaches the session's data and only that card's node changes (the 7.3 `unread` shape);
  - move the stack's "render when approvals or reviews are pending" condition into a pure helper and test it;
  - a symlink test for P1 where the platform allows it (skip it when it cannot be made).

**Defer:**
- (low; B, V) Component tests for `ReviewPane`, `ReviewToasts` and the card flag, and a test of the focused-window rule in `on_review`. There is no DOM test environment and the mock app has no window. The GUI pass covered them.

**Reject:**
- (B) Sessions shown under Elsewhere get no card flag: only app-launched sessions hold a token, and those have cards on the canvas. Removing the session's ref or project clears the request.
- (E) A ref or project removed between the folder check and the insert leaves an orphan request: a millisecond window, and it is runtime only.
- (B) The name is a snapshot taken at request time: a request names the session as it was when it asked.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator** (foreground-guarded, stub `claude`, curl with the token): request a review, then check the flag and the toast. Open from the toast to see the pane, and confirm the flag is cleared. Request again and open from the flag. Check that an outside path is refused.
- **Emils** (real `claude`): ask a session to request review when it is done, and check that the flag, toast, notification and pane all appear.
