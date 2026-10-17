---
title: 'Story 3.1: Historic sessions from transcripts'
type: 'feature'
created: '2026-10-17'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '01e8ac2b19a3b88f2217417c56a37e2c722bf508'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A project card can expand, but its children are stubs. The operator cannot see the Claude sessions already run in that folder, so they cannot find past work to resume. The transcripts that hold this information are already on disk, under `~/.claude/projects`.

**Approach:**
- **Rust summarises transcripts.** It reads every transcript of the Claude project directories whose `cwd` is a project on the canvas. Each transcript is streamed and tolerated record by record, read-only, and cached by size and mtime. The result is one **session summary** per transcript: id, title, started and last-active times, branch, message count and cwd.
- **The summaries become session children.** `graph::children` turns them into real `session` children, replacing the stubs. They appear in the existing column under an expanded project, most recent first, with pinned sessions on top.
- **The card shows the session.** A session card shows the title and a meta line: `branch · N msgs · 3h`.
- **Long lists are trimmed.** Past ten sessions, a **show all (N)** row reveals the rest, and **show fewer** hides them again.
- **The list stays current.** A 5 s pass re-stats the transcripts and re-parses only those that changed. When the list changes it updates the workspace snapshot (new revision, `workspace://changed`, no file write).

**Decisions (recorded):**
- **Which transcripts:**
  - A project's sessions come from every `~/.claude/projects/<dir>` whose `cwd` (discovery's existing rule) matches the project path, compared with `graph::same_path`.
  - Within a dir, only top-level `*.jsonl` count. Per-session folders (`<dir>/<sessionId>/subagents`, `tool-results`, `memory/`) are not sessions.
  - The session id is the file stem.
- **Title,** in order of precedence:
  - the last `custom-title` record's `customTitle`;
  - else `<dir>/<sessionId>/custom-title.json` → `customTitle`;
  - else the last `ai-title` record's `aiTitle`;
  - else the first prompt: the first non-sidechain, non-meta `user` record whose content is a string or holds a `text` block. Whitespace is collapsed and it is cut at 60 characters with `…`;
  - else `(untitled)`.
- **Times:** `startedAt` is the first record `timestamp`; `lastActive` is the last one, or the file's mtime when no record has a timestamp.
- **Branch and cwd:** `branch` is the latest non-empty `gitBranch`, `null` when none. `cwd` comes from the first `user` record.
- **Message count:** prompts (as defined for the title) plus distinct `assistant` `message.id`s, skipping sidechain records.
- **Tolerance:**
  - Unknown record types are skipped.
  - A line that is not JSON is skipped. This includes a half-written last line from a live session.
  - A transcript that yields no record still lists, with its mtime and `(untitled)`.
  - An unreadable file or dir is skipped, never fatal.
- **Parsing:** streamed line by line (`BufRead`, no whole-file read), on a blocking thread.
- **Cache:** keyed by path and invalidated by `(len, mtime)`. It is memory only; nothing is persisted and nothing is written under `~/.claude`.
- **Order:** pinned (`SessionRef.pinned`) first, then `startedAt` descending; equal times by id. Live sessions sort first in Story 3.2. (Amended 2026-10-17 by Emils from `lastActive` descending: two sessions running at once would otherwise swap slots every pass. The card's age still shows `lastActive`.)
- **Show all:**
  - The ten most recent sessions show by default.
  - A synthetic **more row** (`show all (N)` / `show fewer`) follows them in the column. It is not a `ChildNode` in Rust; the frontend adds it.
  - Clicking it, or pressing Enter while it is selected, toggles the project's UI-only `showAll` flag, which is not persisted. Arrow navigation reaches it like any child.
  - Hidden sessions are not drawn, not navigable and not counted in the column, but they count in the collapsed badge. A dragged hidden session keeps its stored position.
- **Worktrees:** a session whose `cwd` is inside a project branch's `worktreePath` gets that branch as its `branchId`. Branch nodes arrive in Epic 5, so today every session sits under the project root. The matching function exists and is tested now.
- **Child card (208 × 40, unchanged size):**
  - Line 1: the title, `--text-md`, ellipsis.
  - Line 2: the meta, mono `--text-xs` `--fg-muted`: `branch · N msgs · <age>`. The branch is omitted when `null`. Age reads `now`, `5m`, `3h`, `2d`, then `12 Oct` (same year) or `12 Oct 2025`, and is recomputed each minute.
  - Full title and exact times on hover (`title`).
  - DESIGN.md's child-card anatomy is updated to match.
- **Stubs:** `SWITCHBOARD_STUB_CHILDREN` stays for layout and performance tests. Stubs are appended after real sessions, and only when the variable is set.
- **Enter on a session:** does nothing. Resume and fork come in Epic 4.

## Boundaries & Constraints

**Always:**
- Read-only under `~/.claude`: no write, rename, lock or temp file there.
- Discovery never blocks the UI thread or the workspace lock during I/O.
- Sessions are keyed by `sessionId`, so Epic 3.2/4 attach to the same nodes.
- The child list stays type-independent; layout code does not branch on session versus branch.
- Tokens and the design lint stay green. Both CI runners stay green, and test fixtures use temp dirs on both platforms.

**Never:**
- Live status, the `claude agents` poll or the live badge (Story 3.2).
- Resume or fork (Epic 4).
- Persisting summaries.
- Watching `~/.claude` with OS file events (a timer re-stat is enough here).
- Parsing usage or cost records (FR-SESS-10).
- Changing the card sizes or the column geometry.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Expand with history | `B:\projects\ai-novelist` with 6 transcripts | 6 session cards, newest first: title, `branch · N msgs · age` | — |
| Title precedence | custom-title record + ai-title | custom title wins; with neither, first prompt ≤ 60 chars + `…` | no prompt → `(untitled)` |
| Unknown records | transcript with `atis-latch`, `cost-state`, a made-up `foo` type | skipped; counts and title unaffected | — |
| Corrupt line | a non-JSON line, a truncated last line | skipped; the rest parses | — |
| Many sessions | 15 transcripts | 10 cards + `show all (15)`; click → 15 + `show fewer`; badge says 15 while collapsed | — |
| New session appears | a new `.jsonl` written while the app runs | within 5 s the card appears (expanded) or the badge grows | — |
| Unchanged files | 5 s pass, nothing changed | no re-parse (cache hit), no `workspace://changed` | — |
| No Claude dir | project folder Claude never ran in | no children, no chevron | — |
| Two dirs one cwd | two project dirs whose cwd is the project | sessions of both, merged and ordered | — |
| Worktree cwd | session cwd inside a branch's `worktreePath` | `branchId` = that branch (unit-tested; no branch nodes yet) | — |
| Pinned | `SessionRef.pinned` true for an old session | it sorts first | — |
| Dragged session | drag a real session card, relaunch | its position persists via `sessions[]` (Story 2.3 path) | — |
| Big transcript | a 37 MB transcript | parsed on a blocking thread once, then cached; UI stays responsive | — |
| Read-only | any | nothing under `~/.claude` changes (test asserts the fixture dir is byte-identical) | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/claude/discover.rs`:**
  - `list_projects(claude_home) -> Vec<ClaudeProject { dir, cwd, exists, sessions, on_canvas }>`, `scan_project_dir`, `list_transcripts`, `cwd_from_transcript(_head)`, `TRANSCRIPT_SCAN_BYTES`, `PROJECTS_DIR`. The dir → cwd rule is reused; keep it.
  - Add a new `claude/transcript.rs` holding `SessionSummary` and `summarise(path) -> SessionSummary`, with fixture tests.
  - Add a new `claude/sessions.rs` holding the cache (`HashMap<PathBuf, (u64, SystemTime, SessionSummary)>`), `sessions_for(claude_home, project_path, cache) -> Vec<SessionSummary>` and the dir → cwd memo.
- **`src-tauri/src/claude/mod.rs`:** has `claude_home()`; export the new modules.
- **`src-tauri/src/graph/mod.rs`:**
  - `ChildNode { id, projectId, kind, label, detail, position }`. Add `session: Option<SessionMeta { startedAt, lastActive, branch, messages }>` (camelCase, `null` for stubs and branches) and a `branchId` matched by worktree.
  - `children(workspace, stubs)` becomes `children(workspace, discovered, stubs)`, where `discovered: &HashMap<projectId, Vec<SessionSummary>>`. Keep the stubs after real sessions. Keep the session-ref position lookup by `(sessionId, projectId)` and the ordering (pinned, then `lastActive` desc, then id).
  - `WorkspaceState` gains `discovered` (not persisted) and `snapshot()` passes it along. Add `set_discovered(app, map)`: when the map differs, it bumps the revision and emits without writing the file.
  - `move_node`'s session lookup goes through `children()`, so real sessions work unchanged.
  - Update the tests that build `children(&ws, n)`.
- **`src-tauri/src/git/poll.rs`:** the timer pattern to copy: `start(app)` in setup, a `tauri::async_runtime` loop, `spawn_blocking` for I/O, store-then-emit only on change. Add `claude::sessions::start(app)` beside it in `lib.rs` `setup`, with a 5 s interval and the first pass right after setup. Also run a pass after `workspace_add_projects` and `workspace_remove_project`, so new cards fill in at once.
- **`src-tauri/src/settings/mod.rs`:** `AppState { workspace, live, claude_home: OnceLock, refresh_lock, … }`. Add the sessions cache, behind a `Mutex`, held only while not reading files.
- **`src/ipc/index.ts`:** `ChildNode` type; add `SessionMeta`.
- **`src/canvas/nodes.ts`:**
  - Has `toFlowNodes` (children per expanded project, `columnSlot`, `layoutChildren`, `sameNode`/`sameChild` comparators), `nodeRects`, `parseFlowId`/`childFlowId` and `ELEVATED_Z`.
  - Add the visible-children cut (`SHOW_LIMIT = 10`, `showAll` set), the synthetic `more` flow node (id `more:<projectId>`, type `more`, its own `parentId`, slot after the last visible child), `parseFlowId` support for it, and `nodeRects` that include it and exclude hidden children.
  - `sameChild` must compare `session` meta.
  - Add `formatAge(lastActive, now)` (pure, tested).
- **`src/canvas/ChildNode.tsx`:** add the two-line session card and a `MoreNode` component. Register both in `Canvas.tsx` `NODE_TYPES`. `nodes.css` gets the card's second line and the more row (muted, `--text-xs`, no border).
- **`src/state/ui.ts`:** add `showAll: readonly string[]` with `toggleShowAll(projectId)`, reference-stable. **`src/commands/navigation.ts`:** `activateSelection()` toggles show-all on a `more` target; a session target stays a no-op. **`Canvas.tsx`:** `onNodeClick` on a `more` node toggles.
- **`src/commands/nodes.ts` / `builtins.ts`:** `more` nodes are not draggable and have no menu; `rightClickTarget` already ignores non-project kinds.
- **`docs/DESIGN.md`:** child-card anatomy (two lines, meta format) and the more row. **`README.md`:** the sessions paragraph (what shows, where it comes from, read-only, the 5 s refresh, show all).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/transcript.rs` -- `SessionSummary`; streaming `summarise` (title precedence incl. `custom-title.json`, times, branch, cwd, message count, tolerant parsing); fixture tests from real-shaped lines (each record type seen on disk, unknown type, corrupt and truncated lines, list-vs-string content, sidechain, meta) -- the parser
- [x] `src-tauri/src/claude/sessions.rs`, `claude/mod.rs`, `settings/mod.rs` -- cache by `(len, mtime)`; `sessions_for` (all matching dirs, top-level `.jsonl` only); the 5 s pass started in `lib.rs` setup and kicked after add/remove; tests: cache hit skips re-parse, changed file re-parses, read-only (fixture tree byte-identical after a pass), two dirs one cwd -- discovery
- [x] `src-tauri/src/graph/mod.rs` -- `ChildNode.session`, `children(workspace, discovered, stubs)` with ordering, worktree `branchId`, `set_discovered` (revision + emit, no write); tests -- the model
- [x] `src/ipc/index.ts` (+test) -- `SessionMeta`, `ChildNode.session` -- IPC types
- [x] `src/canvas/nodes.ts` (+test), `src/state/ui.ts` (+test) -- show-all cut, `more` node, rects, `formatAge` -- derivation
- [x] `src/canvas/ChildNode.tsx`, `src/canvas/Canvas.tsx`, `src/canvas/nodes.css`, `src/commands/navigation.ts` (+test) -- two-line session card, more row, click/Enter toggle -- UI
- [x] `docs/DESIGN.md`, `README.md` -- child-card anatomy, sessions paragraph -- docs

**Acceptance Criteria:**
- Given a project whose folder has Claude transcripts, when I expand it, then its sessions appear newest first with title, branch, message count and age, and the collapsed badge counts them.
- Given more than ten sessions, when I click `show all (N)`, then every session shows and the row reads `show fewer`; Enter on the selected row does the same.
- Given a session is running and writing its transcript, when 5 s pass, then its age and message count update without the canvas jumping; unchanged transcripts are not re-read.
- Given `cargo test`, `clippy -D warnings`, `npm test` (with the design lint), `tsc --noEmit`, when run, then all pass, including the transcript fixtures and the read-only assertion.

## Implementation Notes

- **Rust.** `claude/transcript.rs` (`SessionSummary`, streaming `summarise` via `BufRead::read_until`, so non-UTF-8 bytes never stop the stream; fields of an unexpected type read as absent instead of losing the line). Times are normalised to `YYYY-MM-DDTHH:MM:SS.mmmZ` (a small RFC 3339 parser/formatter, no new crate), so `lastActive` orders correctly as a string; `startedAt` also falls back to the mtime when no record has a timestamp. `claude/sessions.rs` (`SessionCache` with transcript and dir → cwd memos, `scan` for all projects in one pass, `sessions_for` as the single-project form, `start`/`refresh`). `discover.rs` now exposes `resolve_cwd` and `list_transcripts` (`pub(crate)`) so the dir → cwd rule is shared, not copied. `AppState` gains `sessions: Mutex<SessionCache>` and `sessions_lock` (async, serialises passes). `graph`: `ChildNode.session`/`branchId`, `SessionMeta`, `children(ws, discovered, stubs)`, `branch_for_cwd`/`path_within`, `WorkspaceState.discovered`, `set_discovered`. `ipc`: a pass is spawned after `workspace_add_projects` (when something was added) and after `workspace_remove_project`.
- **Small choices not spelled out above:** a `SessionRef.label` overrides the transcript title; a ref's `branchId` is used when no worktree matches; a session id found in two dirs yields one node (the newest); a whitespace-only first prompt counts as a prompt but is skipped as a title (the next prompt is tried); the meta line says `1 msg` for exactly one message; a date is shown from 7 days of age on; `custom-title.json` is read when the transcript is (re)parsed, so editing only that file shows after the transcript next changes.
- **Frontend.** `CanvasTarget = NodeTarget | { kind: "more", id: projectId }` is the selection type; `nodeRects`/`toFlowNodes` take `showAll`; the cut is over the whole child list (type-independent), so with `SWITCHBOARD_STUB_CHILDREN` above 10 the stubs also sit behind `show all`. The more row occupies one 208 × 40 column slot. The minute clock is one shared interval (`useSyncExternalStore`) that runs only while a session card is mounted.
- **Review patch round:** order by `startedAt` (amended decision); command wrappers, local-command output, interrupt markers and compact summaries are not prompts; `startedAt`/`lastActive` are the min/max timestamp; a grown transcript resumes from the last complete line (`Progress`, `summarise_from`); a failed re-read keeps the cached summary and an unlistable `projects/` keeps the last list; sessions use only a transcript-confirmed `cwd`; the cache stamp includes `custom-title.json`'s mtime; the cut hides list indices ≥ 10 unless `showAll`, except a child with a stored position, which is always drawn (slots stay by list index, so Story 2.3's gap behaviour is unchanged; the `more` row sits at `columnSlot(min(total, 10))`, or after the last while all show, and N is the total child count); Enter acts only on a drawn target; `project.toggleShowAll` ("Show all sessions", menu order 32); `clickNode`; removal forgets the project's `showAll`.
- **Verification run:** `cargo test` (227 pass), `cargo clippy --all-targets -- -D warnings` (clean), `npm test` (289 pass, design lint included), `npx tsc --noEmit` (clean). Not run (per session constraints): `npm run tauri build`, and the manual GUI checks.
- Orchestrator (2026-10-18, review + GUI): three review layers on Opus triaged below (one owner decision: order by `startedAt`); the patch round re-verified (`cargo test` 239, vitest 293, clippy and `tsc` clean, debug build). One patch instruction of mine briefly made the column close up after a drag, contrary to Story 2.3's frozen matrix; corrected in the same round (slots stay by list index). A first GUI attempt aborted before any input because a game held the foreground; rerun after Emils freed the screen. GUI pass (foreground-guarded): `ide` (1 session, this one), `map-maker` (9: no `show all`) and `Novels\AI` (15) expanded; cards show real titles and `branch · N msgs · age`, newest-started first; `AI` shows ten cards and `show all (15)`, a click shows all 15 and `show fewer`; the hover shows the full title and exact times; `~/.claude/projects` (excluding this session's live dir) had 480 files with identical size and mtime before and after the run.
- Orchestrator (2026-10-18, close): committed `bf33b58`, pushed; CI run 39069219947 green on ubuntu-24.04 and windows-latest at the first attempt. Deferred: two `deferred-work.md` entries (IPC-path test of the post-add sessions pass; meaning of `.session-aliases`).

## Spec Change Log

- 2026-10-17 (EC10 / BH2, human decision): the frozen order decision was amended by Emils from `lastActive` descending to `startedAt` descending, so running sessions keep their slots. KEEP: pinned first; ties by id; the card age shows `lastActive`.

## Review Triage Log

Pass 1 (2026-10-17, on Opus) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- EC4 / BH7 slash-command (`<command-name>`, 37 on this machine), command-output (`<local-command-…>`, 21), compact-summary (`isCompactSummary`, 5) and interrupt (`[Request interrupted…`, 2) user records are not `isMeta`, so they become titles and count as prompts (verified by counting real transcripts, read-only) — **medium**: patch — skip them for title and count.
- EC5 record timestamps are out of order in practice (4,178 cases over 43 transcripts), so first/last record is not start/last activity — **medium**: patch — `startedAt` = min, `lastActive` = max.
- EC2 / BH1 a live session's transcript is re-read from byte 0 every 5 s (a 37 MB file included) — **medium**: patch — resume from the cached byte offset and partial state when the file only grew; full parse when it shrank or the mtime went back.
- EC10 / BH2 ordering by `lastActive` swaps two running sessions' slots every pass — **medium**, intent: resolved by Emils (order by `startedAt`; frozen decision amended).
- BH8 a transient open failure drops a session for a pass; a failed `projects/` listing wipes every project's children — **low**: patch — keep the cached summary when the stamp reads but the parse fails; keep the previous result when the listing fails.
- BH10 a dir whose transcripts yield no `cwd` is matched by its lossy decoded name — **low**: patch — sessions use only a cwd confirmed from a transcript.
- EC1 / BH11 editing only `custom-title.json` leaves the title stale — **low**: patch — the file's mtime joins the cache stamp.
- BH4 a dragged session (stored position) disappears behind the ten-card cut — **low**: patch — children with a stored position are always drawn and do not use a slot.
- EC7 / EC8 / BH3 a selection on a node no longer drawn (hidden past ten, `more` row gone) stays; Enter on a stale `more` toggles an invisible flag — **low**: patch — `activateSelection` acts only on a target in the current `nodeRects`.
- BH5 the epic context lists "Show all" as a registered command in palette and menu — **low**: patch — `project.toggleShowAll` (menu order 32, `when` the selected project is expanded with more than ten children).
- VG1 / BH12 no test exercises the click on a `more` row — **low** (pre-verified): patch — extract the click handling into a tested command.
- VG3 / VG4 / VG5 / VG6 / BH12' missing tests: removing a project prunes edges of its discovered sessions; the newest copy wins a two-dir duplicate; a selected `more` row clears on removal (and `showAll` drops the id); a whitespace-only first prompt; a `branchId`-only change emits; the tautological hidden-child test — **low** (pre-verified): patch.
- BH13 a raw newline inside a test's string literal; over-long doc lines in `ui.ts` and `nodes.ts` — **low**: patch.
- VG2 sessions after `workspace_add_projects` are not covered by a test through the IPC path — **low** (pre-verified, filed defer): defer.
- BH6 `.session-aliases` is not read (the epic context lists it) — **maybe-false**, unverified medium: defer — its content on this machine is a single id-like line per dir, not a list of linked dirs; settle what it means before using it.
- EC3 a huge newline-less line is buffered whole — **low**: rejected — bounded by the transcript size; streaming already avoids reading the file whole.
- EC6 resolving a cwd re-reads older transcripts while the newest has no `cwd` yet — **low**: rejected — 64 KB per pass for one dir, only during a brand-new session's first moments.
- EC9 two canvas projects with the same path — **false**: `add_projects` dedupes by `same_path`.
- BH9 every pass stats transcripts of dirs not on the canvas, twice — **low**: rejected — one `metadata()` per file at today's scale; revisit with many dirs.
- BH14 `ui.ts` imports a type from `canvas/nodes` — **low**: rejected — a type-only import; no runtime cycle.
- BH15 the spec's status overstates verification — **false**: the GUI pass runs before commit; the review log is this entry.

## Design Notes

- **Record shapes seen on disk** (Claude Code 2.1.30x, field names only):
  - `user`/`assistant`: `type`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `isSidechain`, `isMeta`, `message { id?, content: string | block[] }`;
  - `ai-title`: `{ type, sessionId, aiTitle }`, many per session, take the last;
  - `custom-title`: `{ type, sessionId, customTitle }`;
  - `last-prompt`: `{ lastPrompt }`, not used.
  - Also seen: `attachment`, `system`, `mode`, `permission-mode`, `atis-latch`, `queue-operation`, `file-history-*`, `api-request*`, `pr-link`, `cost-state`. All are skipped.
- **Cost:** a 37 MB transcript is streamed once, and a 5 s pass otherwise costs one `metadata()` per file. The dir → cwd memo is keyed by the dir's newest transcript `(len, mtime)`.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): plant `B:\projects\ide` (one transcript) and `B:\projects\map-maker` (nine). Expand both, then screenshot the session cards.
  - Check the titles, the meta line and the order.
  - Confirm that `show all` is absent, since nine is at most ten.
- Then plant `C:\Users\emils\Documents\Novels\AI` (fifteen) and screenshot both states: `show all (15)`, then after a click.
- Confirm that the `~/.claude/projects` tree's mtimes are unchanged by the run.
