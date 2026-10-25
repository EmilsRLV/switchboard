---
title: 'Story 8.4: Session-touched files and line comments'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'd7250a9b6696c8660a77d17871dcb3b01653af51'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When reviewing a session's work, the operator cannot tell which changed files the session itself edited and which were already dirty. Feedback on a line also still has to be typed into the terminal by hand, so review does not flow back to the agent.

**Approach:**
- **Touched files.** For a session target, Rust reads the session's transcript for Edit/Write/MultiEdit/NotebookEdit tool calls. The Review tree marks those files.
- **Line comments.** On a diff or file line, the operator writes a comment and sends it with ctrl+Enter. The session receives `Review comment on <file>:<line>: <comment>` through its inbox. When the session is idle, that line itself is typed into it (7.3's injection rules). The pane lists each comment with its delivery state.

**Decisions** (taken by the orchestrator under Emils' standing authorisation while he is away, recorded for his review):
- **Touched files:**
  - **Records read.** The session's own transcript (`<claude_home>/projects/*/<id>.jsonl`, read-only), parsed leniently. It reads assistant `tool_use` blocks named `Edit`, `Write` or `MultiEdit` (`input.file_path`) and `NotebookEdit` (`input.notebook_path`). Sidechain records in the same file count; separate subagent transcript files are not read.
  - **Path keys.** Absolute paths are mapped to the review folder's relative keys with 7.4's canonical `request_keys`. Paths outside the folder are ignored.
  - **Mark.** A changed or Files-tree row the session touched gets a muted `•` mark with the title `edited by this session`.
  - **Freshness.** The list is read with the review list, so Refresh and the poll update it.
  - **Other targets.** Project and branch targets have no touched marks.
- **Comment box:**
  - **Opening it.** Key `c`, or palette "Comment on line", while the Review pane shows a session target and a file. The comment is anchored at the current line (8.3's line rule: the cursor line, or the first visible line).
  - **The box.** A one-line text area under the toolbar reads `Comment on <file>:<line>`. ctrl+Enter sends and Esc cancels. Bare keys never fire while typing.
  - **Other targets.** For a project or branch target the command is disabled with the title `comments go to a session`.
- **Delivery (Rust):**
  - **Text.** `Review comment on <path>:<line>: <comment>`, where `<path>` is relative to the reviewed folder. Newlines become spaces, control characters and U+2028/U+2029 are stripped, and the text is cut to 1,000 characters. An empty comment is refused.
  - **Inbox.** It is pushed to the session's inbox as from `operator`, so `inbox()` returns it.
  - **Injection.** If the session runs in a Switchboard terminal, the comment line itself is injected when the session is next idle, through the 6.3/7.3 slot and the draft rule. The generic "You have N messages" nudge is not used for it. Comments are not counted by the 7.3 nudge loop guard, because the operator sent them. A comment is injected once.
  - **Not running.** The comment waits in the inbox. When the session next runs in a Switchboard terminal and is idle, the comment line is typed once, unless the session has already read it with `inbox()`. (Amended in review round 1: orchestrator decision, see the Spec Change Log.)
- **Comment states.** The pane lists this target's comments (runtime only) with a state: `queued` (in the inbox, waiting for idle or not running), `sent` (typed into the session) or `read` (drained by `inbox()`). They update live.

## Boundaries & Constraints

**Always:**
- **Rust owns the work.** It reads the transcript, builds the line and injects it. The UI sends the target, path, line and text.
- **Read-only access.** Nothing is ever written under `~/.claude`, and transcripts are only read.
- **Shared injection rules.** One plain line, never typed over a draft, waiting for idle.
- **Tests.** No real `claude`. Use temp claude homes and stub sessions.

**Never:**
- Persisting comments.
- Multi-line injection.
- Comments to project or branch targets.
- Reading subagent transcript files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Touched | transcript Edit on `<cwd>/src/a.ts`, Write on `<cwd>/b.md` | tree rows `src/a.ts`, `b.md` marked `•` | outside paths ignored |
| No transcript | session not yet discovered | no marks | — |
| Corrupt lines | malformed JSON lines | skipped | — |
| Comment, idle | session idle; comment "rename this" on `src/a.ts:12` | PTY gets `Review comment on src/a.ts:12: rename this\r`; state `sent` | — |
| Comment, busy | session busy | `queued`, injected at next idle, then `sent` | draft → waits |
| Not running | historic session | `queued`; inbox holds it | — |
| Read | session calls `inbox()` | state `read` | — |
| Multi-line | comment with newlines | sent as one line | empty → refused |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- **Transcript scan, in `claude/transcript.rs` or a new `review/touched.rs`.**
  - Add a lenient `tool_use` scan: `Block` (:344) gains `name` and `input`, or a separate small scanner is used. Follow the existing lenient helpers (:353-377) and the corrupt-line skipping (:257).
  - Find the transcript with `live_edges::find_transcript` (:330) and `state.claude_home`.
  - Map paths with `review::request_keys` (review/mod.rs :548).
- **`ipc::review_list`** (:516): for a session target, add `touched: Vec<String>` to `ChangeList` (git/diff.rs :157). Files mode needs the same keys; add them to the `review_dir` reply or a small command.
- **`inbox/mod.rs`:**
  - Add a public `comment(app, session, text)`:
    1. clean the text (`clean_text` :232, plus `\n`→space);
    2. push it from `operator` (`push` :206);
    3. if the session is running, start a comment injection job.
  - The job reuses `live_edges::look` (:792) for the slot, idle and draft checks, and `write_line`. It is a variant of the nudge job (`start` :460, `run_nudge` :551, `nudge_once` :503) that writes the comment line and is not counted by `NudgeLimit` (:66-82).
  - Track per-comment state (queued / sent / read) and emit an event.
  - `inbox()` draining sets `read`.
- **IPC:** add `review_comment(target, path, line, text)` and `review_comments_get(target)`, and register them in `lib.rs`.

**Frontend (`src/`):**
- `components/ReviewPane.tsx`: the touched mark in `FileButton` (:530), via `TreeRowItem` (:556) and the Files rows; the comment box above `DiffArea` (:604) or `.review-diff-wrap` (:653); the comments list.
- `review/place.ts`: `currentLine()` gives the line.
- ctrl+Enter is handled locally, as in `launchKeyAction` (launch.ts :322-331, LaunchPane.tsx :68). Make sure the global `enter` binding (builtins.ts :270) does not fire inside the box.
- `state/review.ts`: the comments mirror.
- `commands/review.ts` and `builtins.ts`: "Comment on line" with key `c`, gated like `o` (:702) and for session targets only. Update the id lists in `builtins.test.ts`.
- `ipc/index.ts`: types, plus the README Review section and DESIGN.md (the mark, the comment box, the states).

**Tests:**
- **Transcript scan.** Edit, Write, MultiEdit and NotebookEdit; sidechain records; corrupt lines; an outside path; Windows-style absolute paths. Use a temp claude home.
- **IPC** (`lib.rs`, modelled on `peer_messages_land_in_the_inbox…` :3228 with a line-echo stub):
  - a comment to an idle session types exactly the line;
  - a comment to a busy session is queued, then sent;
  - a comment to a session that is not running is queued in the inbox;
  - draining the inbox sets `read`;
  - the comment is not counted by the nudge loop guard.
- **Vitest.** The comment command gating, the box key handling as a pure helper, and the touched mark in the rows.

## Tasks & Acceptance

**Execution:**
- [x] `claude/transcript.rs` (or `review/touched.rs`), `inbox/mod.rs`, `review/mod.rs`, `ipc/mod.rs`, `git/diff.rs`, `lib.rs` (+tests): touched scan, comment delivery and states.
- [x] `ReviewPane.tsx`, `state/review.ts`, `commands/review.ts`, `builtins.ts`, `ipc/index.ts`, CSS (+vitest): mark, comment box, comment list.
- [x] `README.md`, `docs/DESIGN.md`.

**Acceptance Criteria:**
- Given a session whose transcript has Edit/Write/MultiEdit calls on files in its folder, when I open Review on it, then those files are marked in the tree.
- Given a diff line, when I add a comment and press ctrl+Enter, then `Review comment on <file>:<line>: <comment>` reaches the session's inbox and is typed in when it is idle, and the comment shows as sent.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Touched scan** lives in a new `review/touched.rs`: a small `serde_json::Value` scanner per line (lines without
  `"tool_use"` skipped before parsing), assistant records only, sidechain records included. Each transcript's scan is
  cached in memory with its byte offset and resumed when the file only grew (re-read from 0 if it shrank), so the poll
  does not re-parse whole transcripts. Paths (a relative one resolves against the folder) go through
  `review::request_keys`; outside paths and the folder itself are dropped. A session id that is not plain
  `[A-Za-z0-9_-]` never reaches `find_transcript`.
- **Wire.** `ChangeList.touched` (Changes) plus a small `review_touched(target)` command for Files mode (read with the
  tree, on opening and on Refresh). New commands `review_comment(target, path, line, text)` and
  `review_comments_get(target)`; event `review://comments` carries every comment of the run (the UI filters by session
  and merges replies so a state never moves backwards).
- **Comments in `inbox/mod.rs`.** Pushed with `from: "operator"`, `fromNodeId: null` and `arrival = false`, so the
  peer nudge and its loop guard never see them (`nudge_line` skips messages without a node id). A separate per-session
  comment job (own generation map) waits on `live_edges::look`, writes the oldest owed comment line + `\r`, marks it
  `sent`, and holds the slot like the nudge job until busy or the notify wait. `Message` gained a `#[serde(skip)]
  comment` id so draining `inbox()` marks the comment `read`. A comment already `read` before its idle is not typed.
- **Choices beyond the spec text:** the 1,000-character cut applies to the whole delivered line; line 0 is refused.
- **Round 1 fixes (P1–P12).** Every queued comment is typed once its session runs here and is idle (the running check is
  made under the inbox lock, after the comment is queued; `session_started` starts the job otherwise). The job claims
  a comment under the lock before writing (state `sent`, its inbox copy taken out, so `inbox()` never returns it
  again), puts it back on a failed write and retries on the next tick. Inbox eviction skips comment messages while
  any other message is left; the per-session list (100) evicts non-queued comments first; a comment that must go is
  `dropped` (new state, listed, removed from the inbox). `one_line` collapses runs of breaks. `comment_path` is now
  lexical only (no folder access): plain `/` parts, no control/bidi chars, `:`/`\` refused on Windows only, names kept
  as listed; a path whose lead leaves no room for text is refused (`PATH_TOO_LONG`). Touched scan: only absolute
  paths count, the lexical key is added beside the canonical one, the cache is keyed on length + mtime (unchanged:
  no read) and a fingerprint of the head and the bytes before the offset (rewrites rescan), and
  `review::forget_sessions` drops removed sessions' scans. UI: drafts per target in the store (dropped on close), the
  box is `readOnly` while sending and refocused on error, `handleCommentKey` claims Esc/Enter/ctrl+Enter, Files-mode
  marks re-read on the git poll (`touchedSeq`), `touchedFor` helper.
- **Disabled title.** The registry has no "disabled with a title" concept, so the palette command is simply not offered
  for a project/branch (`when` false) and the new toolbar **Comment** button is disabled with the title
  `comments go to a session`.
- **Keys.** The box handles ctrl+Enter / Esc / Enter itself (`commentKeyAction`, `preventDefault` so the window
  dispatcher stays out — Esc does not close the pane, Enter never reaches `selection.activate`); bare keys are already
  left to text fields by the dispatcher. Pasted line breaks become spaces.

- 2026-10-25 GUI pass (orchestrator; a stub session `demo-0fab` on scratch repo `reviewdemo81`):
  - `r` on the session card opened Review with Changes and Files (no vs base or Commits) and a **Comment** button.
  - On `src/auth.ts`, after clicking new line 11, `c` opened the box `Comment on src/auth.ts:11` with the hint `ctrl+Enter sends · Esc cancels`.
  - Typing `rename this` and pressing ctrl+Enter added the row `src/auth.ts:11 rename this` marked `sent`. The idle stub had the line typed in, and the session card showed an unread badge for the inbox copy.
  - Touched marks were not exercised on screen: the app reads the real `~/.claude`, which the GUI pass never writes to. The IPC test covers them with a temp claude home.

- 2026-10-25 GUI re-run after review round 1 (stub session `demo-9dec`): `c` on `src/auth.ts:11`, typing `first try`, then Esc closed only the box, and the Review pane stayed open. `c` again brought the draft back, and ctrl+Enter listed `src/auth.ts:11 first try` as `sent`. No unread badge was left on the card, because a typed comment's inbox copy is consumed.
- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away): cargo test (559), clippy, tsc, vitest (634), the debug build and two GUI passes. **Linux CI is pending.** Emils' checks are still open: touched marks and comment delivery with a real `claude` session.

## Spec Change Log

- 2026-10-25, review round 1. The blind-hunter found that a comment sent to a stopped session was never delivered after a resume: it stayed `queued` with nothing to prompt the agent, and the word `queued` meant two different things. **Orchestrator decision, under Emils' standing authorisation while he is away (for his review):** every queued comment is typed once when its session next runs in a Switchboard terminal and is idle, unless the session has already read it. A comment that is typed counts as read in the inbox, so the agent does not get it twice. KEEP: the inbox copy, the one-line injection, the slot and draft rules, and leaving comments out of the nudge loop guard.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V). Triaged by the orchestrator under Emils' standing authorisation.

**Patch:**
- P1 (high; B, decision above) A comment to a stopped session is never delivered, and `queued` is ambiguous. Every queued comment is typed when its session is next running and idle. Check whether the session is running under the inbox lock, which also removes the race (B). Test sending while stopped, then resuming, then the comment being typed.
- P2 (medium; B) A typed comment also stays unread in the inbox, so `inbox()` returns it again. When the comment is typed, mark its inbox copy consumed and set its state to `sent`. Test it.
- P3 (medium; E) A drain between `next_comment` and `write_line` still types the comment. Mark it `sent` under the lock before writing, and put it back if the write fails. A failed write is retried on the next tick rather than ending the job (E, B). Test that a comment already read is not typed (V).
- P4 (medium; E, B) Evictions:
  - The inbox's 100-message eviction can drop a comment's message.
  - The 100-comment cap can drop a comment that is still owed.

  Do not evict comment messages or owed comments. If one must go, mark it `dropped` and show that in the list. Test the cap, including that another session's comments are left alone (V).
- P5 (low; B) Rust turns each line-break character into a space, while the UI turns a run of them into one space. Collapse runs in Rust too.
- P6 (low; E) `comment_path`:
  - it refuses names that are valid on Linux (`:`, `\`) and names with spaces at either end;
  - it refuses a link row that resolves outside the folder;
  - a very long path leaves no room for the comment itself.

  Check `:`/`\` on Windows only, keep names as listed, check containment lexically (the comment only names a path and nothing is read), and refuse a comment whose path leaves no room for its text.
- P7 (low; B, E) Comment box:
  - focus is lost after a refusal;
  - the draft is lost when the box moves to another line.

  Use `readOnly` while sending and refocus the box after an error. Keep the draft per target in the store; it is dropped when the pane closes. Document in the README's Esc row that Esc closes the box only while focus is in it.
- P8 (low; B, E) The touched-file cache:
  - it goes stale when a transcript is rewritten without shrinking; also key it on the file's modified time and length;
  - it never shrinks; drop entries in `forget_sessions`;
  - files reached through a link get no key; also add the lexical key when it is inside the folder.
- P9 (low; E) In Files mode the touched marks never refresh. Re-read them on the git poll as well.
- P10 (low; B) Document that comments are typed even when `peers.nudge` is off: the setting governs only the peer-message nudge.
- P11 (low; B, V) Fix the `rowLabel` doc comment that the new code displaced.
- P12 (medium; B, V) Tests:
  - the loop-guard test can never fail; set `max: 1`, send comments, then a peer message, and check its nudge is still typed;
  - move the comment box's key handling (preventDefault for Esc and a bare Enter) into a pure function and test it against the global dispatcher;
  - add a pure `touchedFor(target, mode, list)` helper with tests;
  - test that a removed session's comments and job are dropped by `forget_sessions`;
  - test a Windows-style `C:\…` transcript path on every OS (outside the folder on Linux).

**Reject:**
- None.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator** (foreground-guarded; stub `claude` session in a scratch repo, with a fake transcript placed in a temp claude home if the app can point to one, otherwise covered by the IPC test):
  - Review on the session;
  - `c` on a line, then ctrl+Enter;
  - the comment state shows.
