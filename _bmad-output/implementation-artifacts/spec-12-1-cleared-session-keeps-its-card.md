---
title: 'Story 12.1: A cleared session keeps its card'
type: 'feature'
created: '2026-11-23'
status: 'done'
baseline_commit: '6c12c0db3de214c3fb9b18382102115194dbded0'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `/clear` gives a Claude session a new id. Switchboard then lists the new transcript as a second card, and the old card stops changing state, so every clear adds a card.

**Approach:** The card keeps its original id as its permanent **node id**. Each id the session moves to after `/clear` is added to a persisted chain, `clearedInto`, on its `sessions[]` entry. Wherever Claude's real id appears (the poll, discovery, the MCP listing, resume and fork), Rust maps the id back to the node id. All runtime state that is already keyed by the node id stays as it is: tokens, terminal, live state, inbox, review, approvals, the UI stores and edges.

**Decisions (2026-11-23):** Picking a transcript in **Earlier transcripts…** forks it: a new card, `forkedFrom` = A, through the existing fork path with that transcript id as the source. It works while A is running, and A is untouched. The operator kept the full spec rather than splitting the command out.

## Boundaries & Constraints

**Always:** Detect a clear from a `SessionStart` whose body has `source: "clear"` and a `session_id` that is not already in the chain. For sessions without a hooks token, detect it from the poll instead: a new row with the same `pid` and `cwd` as a node that has dropped out of the poll. Write the chain to `workspace.json` once per clear, then emit. A transcript in the chain is never a card of its own. The **current id** is the last entry of `clearedInto`, or the node id when the chain is empty. Resume and Fork use the current id for `--resume`, keep the terminal id `session:<node id>`, and set `forkedFrom` to the node id. `clearedInto` is serde-default and skipped when empty, so older files load and are written unchanged. The read-only guard applies.

**Never:** Rename the node id or migrate any id-keyed map, in Rust or in TS. Re-key on a `SessionStart` whose `source` is `startup`, `resume` or `compact`, or on one with no `source`. Merge cards that were split by clears before this build. Write under `~/.claude`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error handling |
|---|---|---|---|
| Hooked clear | Node A is live; `SessionStart{session_id:B, source:"clear"}` arrives on A's token | `clearedInto=[B]`; card A keeps its state, terminal and edges; no B card | Write failure: banner, chain kept in memory |
| Second clear | Chain `[B]`; `SessionStart` with C and `source:"clear"` | `[B,C]`; tooltip says `cleared 2 times` | — |
| Repeat event | `SessionStart` with B again (already in the chain) | No change | — |
| Unhooked clear | Last poll had A (pid 7, cwd X); this poll has B (pid 7, cwd X) and no A | `clearedInto=[B]`; A's live state continues | — |
| Pid reused | A exited in an earlier poll, B later appears with the same pid | Not a clear; B gets its own card | — |
| No pid | The row has no `pid` | Not a clear | — |
| Restart | Workspace has A with `[B,C]`; discovery finds A, B and C | One card, A, showing C's summary (last active, messages) | — |
| Resume | Card A, chain `[B]`, Resume | `claude --resume B` in terminal `session:A` | B's transcript missing: refuse with `transcript not found` |

</frozen-after-approval>

## Code Map

- `src-tauri/src/claude/hooks.rs` -- `receive` :642 handles a POST by looking up the session for the token, then `check_session_id` :358 and `map_event` :153. `source` is not parsed anywhere yet. The clear is detected here and `graph::record_clear` is called. `Inner.aliases` stays as it is.
- `src-tauri/src/claude/live.rs` -- `LiveRow` :62 (pid, cwd); `LiveSession` :166 already has `pid` and `cwd`; poll merge `apply_in` :371 (exit marking :471–493). Map row ids through the alias table before merging, and put pid matching at the start of `apply_in`. `live.rs:1069` is the toast title lookup.
- `src-tauri/src/graph/mod.rs` -- `SessionRef` :183 and `is_bare` :690. `set_forked_from` :1247 is the pattern for upserting a ref, writing it, rolling back on failure and emitting. The mutation flow ends in `persist_and_emit` :2319. `children_with_worktrees` :458 builds the `real` list at :484: hide chained ids there, and fill the card's `SessionMeta` from the current id's summary. Also hide them in `peer_facts` :1993/:2006 and `edge_session_ids` :1624.
- `src-tauri/src/ipc/mod.rs` -- `resume_session` :2010 and `fork_session` :2040: the `--resume` argument becomes the current id. `source_session` lookups are at :863 and :1956.
- `src-tauri/src/mcp/mod.rs` :605, :922 -- the `sessions` tool leaves chained ids out.
- `src-tauri/src/claude/transcript.rs` :26 -- `SessionSummary.title` and `started_at` provide the text for the pick-list rows.
- `src/ipc/index.ts` :166 `SessionRef` gains `clearedInto?: string[]`; :488 `ChildNode` gains `clearedCount` and `earlier: {id,title,startedAt}[]`.
- `src/canvas/nodes.ts` -- `sessionCardTitle` :937 and `childAriaLabel` :908 gain the line `cleared N times`, placed after forkedFrom.
- `src/commands/builtins.ts` -- add `session.earlier` modelled on `edge.select` :817 / `startSelectEdge` (`src/commands/edges.ts` :196). `openPick` items are `{id,title}`, so a row's title reads `<time> — <title>`.
- Do not change: `src/state/{ui,terminals,live,inbox,review,edgesLive}.ts`, `src/terminal/registry.ts`, `pty/mod.rs`, `Launcher`. They stay keyed by the node id.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/graph/mod.rs` -- Add `cleared_into` to `SessionRef` and update `is_bare`. Add `record_clear(node, new_id)` (it upserts the ref and returns false when the id is already present), `current_id(node)`, and `alias_table()` mapping each chained id to its node id. Hide chained ids in children, peers and edge pins, and fill the card's meta from the current id. Write tests for each.
- [x] `src-tauri/src/claude/hooks.rs` -- Parse `source`. On a clear, call `record_clear` before `check_session_id`. Test that `clear` re-keys while `startup`, `compact`, `resume` and a missing `source` do not.
- [x] `src-tauri/src/claude/live.rs` -- Map row ids through `alias_table`. Add pure `detect_clears(prev, rows)` for unhooked sessions, called from `apply_in`. Write tests for the pid and cwd rows in the matrix.
- [x] `src-tauri/src/ipc/mod.rs`, `src-tauri/src/mcp/mod.rs` -- Resume and Fork of a card use `current_id`; `fork_session` also accepts an earlier id in a card's chain (or the node id itself when the chain is not empty), resumes that transcript, and records `forkedFrom` as the node id. The MCP `sessions` tool hides chained ids. Extend `resume_fork_and_an_idle_stop_run_their_recipes` (lib.rs :2810) with a chained case.
- [x] `src/ipc/index.ts`, `src/canvas/nodes.ts`, `src/commands/builtins.ts`, `src/commands/sessions.ts` -- Add the types, the tooltip and aria line, and `session.earlier` (node menu and palette, shown when `earlier.length > 0`) where picking a row forks that transcript (`sessionFork(projectId, id, null, null)`). Add vitest tests for the title line and the command's `when`.
- [x] `docs/help/sessions.md`, `README.md` (Sessions, Diagnostics), `ROADMAP.md`, `CHANGELOG.md` -- Say that a cleared session keeps its card. Drop the Next item and the Known limitation. Add a line under Unreleased › Sessions.

**Acceptance Criteria:**
- Given a cleared session with a selected card, an open terminal tab and a cooperate edge, when the clear lands, then the selection, the tab, the edge and its live state are unchanged and the card's state follows the session's new turns.
- Given a workspace.json from 0.2.0, when it loads and is saved without a clear, then the file bytes are unchanged.

## Implementation Notes

- Added `ChildNode.currentId` (not in the Code Map): the node id also names the card's first transcript, so the card's Fork sends the current id and Earlier transcripts… can fork the first one.
- New TS fields are optional to avoid rewriting hand-built `ChildNode` fixtures; Rust always sends them.
- New error `transcript not found` only for a cleared card whose current transcript is not discovered; uncleared cards keep `NO_TRANSCRIPT`.
- Review patches: poll detection skips hooked sessions; hook-side `record_clear` runs on `spawn_blocking`; titles are own-first everywhere; wiring tests for `start_on`, `apply_and_emit` and the MCP listing.
- Matrix "write failure" error handling goes through the existing `persist_and_emit` banner path and has no new test.
- Not run: the manual check (a real `/clear` in the app, then a restart).

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | blind, edge | Current id undiscovered after `/clear` (no prompt yet): Resume/Fork refuse `transcript not found`; card meta falls back to an older chained transcript that also shows in Earlier | low | Refusal is the frozen matrix's Resume row; the meta/Earlier overlap needs a chain of 2+ with the newest never prompted | rejected (matches intent; rare, fix adds branches) |
| 2 | blind, edge claim | `fork_session(node id)` forks the first transcript while `resume(node id)` uses the current one | low | Only caller is the UI, which sends `currentId` (sessions.ts); MCP has no fork tool; observable behaviour matches the frozen rule | rejected (no caller diverges today; fix adds IPC surface) |
| 3 | blind, edge | Toast and MCP titles use the current transcript; card and peers use the node's own | low | live.rs notify_transitions / mcp facts look up current first; graph children and peer_facts own first | patch |
| 4 | blind | `Launch.source_node` fallbacks disagree | low | Both fallbacks unreachable: Resume and Fork always set `source_node` (ipc/mod.rs) | rejected |
| 5 | blind, edge | `record_clear` does lock + file write on the async hook handler | medium | hooks.rs receive calls on_clear inline; start_on closure calls graph::record_clear | patch |
| 6 | blind | Unhooked clears while Switchboard is closed are never noticed; README implies full detection | low | detect_clears needs the old id live in the previous poll | patch (README sentence) |
| 7 | blind | Two new rows matching one dropped session resolved by poll order | low | Needs two new sessions in one process at once | rejected |
| 8 | blind, edge | `record_clear_in` does not refuse a `new_id` that is another card's id, or a chained `node` | low | Hook node is always the token's launch id; poll nodes are already alias-mapped; new id with its own ref needs the poll to list it and the operator to pin/drag it first | rejected |
| 9 | blind | `session.earlier` shares `menuOrder: 9` | low | builtins.ts:536 and :546 both 9 | patch |
| 10 | blind, edge | Earlier row reads `<time> — ` or `(untitled)` | low | earlierRowTitle prints title as-is; transcript::UNTITLED is "(untitled)" | patch |
| 11 | blind, edge | TS fork guard keyed by transcript id in forkEarlier, card id in forkSelectedSession | low | sessions.ts; Rust begin_fork keys the node | patch |
| 12 | blind, edge claim | Test named byte-for-byte compares only `sessions` values | low | graph tests | patch (rename) |
| 13 | verification-gap, blind | No test wires `start_on` → `record_clear` | high | pre-verified: no lib.rs test sends `source:"clear"` | patch |
| 14 | verification-gap, blind | No test wires `apply_and_emit` → `record_clear` | high | pre-verified: live.rs tests read `map.clears` only | patch |
| 15 | verification-gap | MCP listing/facts over a chain untested | medium | pre-verified: no `cleared_into` in mcp tests | patch |
| 16 | verification-gap | Toast title for a cleared session untested | low | pre-verified; folded into #3's change | rejected (low; covered by #3/#14 wiring) |
| 17 | blind | Help line "Resume reopens … with the same id" now wrong | low | docs/help/sessions.md | patch |
| 18 | edge, edge claim | Poll detection also runs for hooked sessions, so an in-process `/resume` could be chained | medium | detect_clears has no hooked check; spec Never forbids re-keying on `resume` | patch (skip hooked) |
| 19 | edge | Unhooked in-process `/resume` (same pid, cwd) indistinguishable from a clear | maybe-false (medium if true) | Depends on whether `claude agents --json` reports the resumed id for the same pid; not checked | defer |
| 20 | edge | One poll lists both the stale node row and its chained row; last overwrites | maybe-false (low) | Needs `claude agents` to list both ids for one process | rejected |
| 21 | edge | Hooked clear on a session whose project left the canvas is dropped | low | Launched sessions belong to a canvas project; needs the project removed mid-session | rejected |

## Design Notes

Story 12.1 in the epic says "re-key old → new". This spec keeps the old id as the node id and maps new ids to it, which the operator sees the same way. Re-keying would mean migrating roughly 25 id-keyed maps across Rust (`LiveMap`, `Launcher`, `live_edges`, `inbox`, `approvals`, `review`, the PTY exit closure) and the UI (selection, terminals, xterm registry, drag overrides). Mapping happens in four places only: hooks, the poll, discovery and resume.

## Verification

**Commands:**
- `cd src-tauri && cargo test` -- expected: passes, new tests included
- `npm test` -- expected: passes
- `npx tsc --noEmit` -- expected: no errors

**Manual checks:**
- Start a session from Switchboard, type `/clear`, then a prompt. The card stays put and goes busy then finished. After restarting the app there is still one card. Earlier transcripts… lists the pre-clear transcript, and picking it forks it into a new card.
