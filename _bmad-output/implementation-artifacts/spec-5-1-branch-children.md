---
title: 'Story 5.1: Branch children'
type: 'feature'
created: '2026-10-19'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5de4d7357f6d09c8976d773788d1e27ff0cd4b70'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A project card shows the checked-out branch and a dirty count, but not the repo's other local branches, how far they are from their upstream, or which ones have a worktree. The "branches" chip on the card does nothing.

**Approach:**
- **The toggle.** The "branches" chip becomes a per-project toggle.
- **The cards.** When it is on, the project's local branches appear as branch cards under its sessions. Each card shows the name, `*` for the checked-out branch, `↑n ↓m` against its upstream, and a worktree chip with the path when a linked worktree has that branch.
- **Rust owns the data.** It reads branches with `git for-each-ref` and worktrees with `git worktree list --porcelain`, and refreshes them within 2 s of a change under the repo's refs.

**Decisions:**
- **Toggle:**
  - `Project.showBranches: bool` is saved in the workspace and defaults to off.
  - The chip is a real button (`project.toggleBranches`, "Show branches" / "Hide branches", in the node menu and the palette), and pressing it with the card collapsed also expands it.
  - Non-git projects have no chip and no command.
- **What a branch card is:**
  - It is a runtime child of kind `branch`, discovered like sessions and never written to the workspace. A `BranchNode` ref is written only when the operator moves one, saving its position, as with sessions.
  - The branch id is `<projectId>:<branch name>`.
  - Branch cards follow the project's session children as a second group, with their own limit of 10 and their own `show all (N)` / `show fewer` row, so sessions and branches never push each other out.
  - Branches are ordered with the checked-out branch first, then by last commit date, newest first, then by name.
- **Card content:**
  - **First line:** the name in the card's title style, ellipsised, then `*` after it for the checked-out branch.
  - **Second line, muted:**
    - `↑n ↓m`, either part left out when it is 0, and the line left out when the branch has no upstream;
    - `upstream gone` when the upstream is configured but missing;
    - then the worktree chip.
  - **Worktree chip:** the worktree folder's last two path segments, with the full path in its tooltip and the accessible label. It is shown only for linked worktrees (not the project's own checkout). A worktree whose folder is missing (prunable) shows `missing`.
  - **Tokens only**, no accent.
- **Reading git** (Rust, `git` CLI, read-only, from the project folder):
  - **Branches:** `git for-each-ref --format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix) refs/heads`.
  - **Worktrees:** `git worktree list --porcelain`. A linked worktree is matched to its branch by `branch refs/heads/<name>`, and its path is canonicalised.
  - **Failures:** a failure of either command keeps the last good list and replaces the project card's path row with a muted `branches unavailable` (amended in review round 1), with the cause in its tooltip; the path moves to the project name's tooltip while the error lasts.
- **Refresh:**
  - **Watcher.** A `notify` watcher on the repo's common git dir (`git rev-parse --git-common-dir`) covers `HEAD`, `packed-refs`, `refs/heads/**` and `worktrees/**`, for projects with branches on. It refreshes that project, debounced to 300 ms, so changes show within 2 s.
  - **Fallback.** The existing git status poll also refreshes branches for those projects every 30 s.
  - **Watch lifecycle.** Turning branches off or removing the project stops its watch.
- **Interaction:**
  - Branch cards can be selected, moved with the arrow keys and dragged like session cards.
  - Enter does nothing new in 5.1. Right-click opens the branch's node menu (amended in review round 1), which holds only "Copy branch name", copying the name to the clipboard.

## Boundaries & Constraints

**Always:**
- **Read-only git.** No ref, worktree or index is touched.
- **Rust owns the lists.** Rust builds the branch and worktree lists and emits them in the workspace snapshot children.
- **No `~/.claude` writes.**
- **Tests.** They use temp git repos created in tests (`git init`, commits, `git branch`, `git worktree add` inside the temp dir only), never the user's repos.
- **CI.** Both runners stay green, with the design lint passing.

**Never:**
- Creating, deleting or checking out branches or worktrees (Stories 5.2–5.4).
- Sessions regrouped under branches (Story 5.4).
- Remote branches.
- Fetching.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Toggle on | `ide` branches on | branch cards under sessions: `master *` first | — |
| Upstream | branch 2 ahead, 1 behind | `↑2 ↓1` | — |
| No upstream | local-only branch | no second-line counts | — |
| Gone | upstream deleted | `upstream gone` | — |
| Worktree | `git worktree add ../wt feat` | `feat` shows chip `…/wt` with full path in tooltip | folder deleted → `missing` |
| New branch on disk | `git branch x` in a terminal | `x` appears within 2 s | watcher error → 30 s poll still refreshes |
| Detached HEAD | HEAD detached | no `*`; project card already says detached | — |
| Many branches | 25 branches | 10 shown + `show all (25)` | — |
| Non-git | plain folder | no chip, no command | — |
| git fails | for-each-ref errors | last list kept, `branches unavailable` | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/git/branches.rs` (new):**
  - Pure `parse_for_each_ref(text)` and `parse_worktrees(porcelain)`.
  - `branches_of(git, path) -> Result<BranchList>` (branches with HEAD flag, upstream, ahead, behind, gone and date; worktrees by branch; prunable).
  - `common_dir(git, path)`.
  - Tests with fixtures and with temp repos.
- **`src-tauri/src/git/watch.rs` (new):** a per-project `notify` watcher with a 300 ms debounce, started and stopped as branches are toggled or projects added and removed.
- **`src-tauri/src/git/poll.rs`:** the 30 s branch fallback, and the per-project branch state in the live/status state.
- **`src-tauri/src/graph/mod.rs`:**
  - `Project.show_branches` (serde default false), and `set_show_branches`.
  - `children` adds branch children after sessions when it is on.
  - `ChildNode` gets the branch fields: `head`, `ahead`, `behind`, `upstreamGone`, `worktree { path, missing }`.
  - Tests.
- **`src-tauri/src/ipc/mod.rs`:** `project_set_show_branches`, plus the branch list in snapshots and the project card's `branchesError`.
- **Frontend:**
  - `src/canvas/ProjectNode.tsx`: the real toggle.
  - `src/canvas/ChildNode.tsx` and `nodes.ts`: the branch card, the second group with its own limit and `more` row (`visibleChildren` per group), and keys stable by branch id.
  - `src/commands/builtins.ts` and `nodes.ts`: `project.toggleBranches` and `branch.copyName`.
  - `src/ipc/index.ts` and `nodes.css`, plus tests.
- **Docs:** `README.md` gets a "Branches" section. `docs/DESIGN.md` gets the branch card.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/git/branches.rs`, `watch.rs`, `poll.rs` (+tests with temp repos) -- read branches/worktrees, watch, fallback -- git
- [x] `src-tauri/src/graph/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests) -- toggle, branch children, snapshot -- model
- [x] `src/canvas/ProjectNode.tsx`, `ChildNode.tsx`, `nodes.ts`, `nodes.css`, `src/commands/*`, `src/ipc/index.ts` (+tests) -- toggle, branch card, second group, commands -- UI
- [x] `README.md`, `docs/DESIGN.md` -- docs

**Acceptance Criteria:**
- Given a git project expanded with branches on, when the list renders, then each branch shows its name, `*` for current, `↑n ↓m` against an upstream when it has one, and a worktree chip with the path when `git worktree list --porcelain` has it.
- Given branches change on disk, when `.git/refs` or `.git/packed-refs` changes, then the list refreshes within 2 s.
- Given `cargo test`, `clippy -D warnings`, `npm test`, `tsc --noEmit`, when run, then all pass on both platforms.

## Implementation Notes

- **Branch facts on `ChildNode` are nested**, as `branch: BranchMeta | null` (`head`, `upstream`, `ahead`, `behind`, `upstreamGone`, `worktree { path, missing }`), mirroring `session: SessionMeta | null`, rather than flat fields on every child. `upstream` is extra: it feeds the tooltip and tells "no upstream" from "in sync".
- **`branchErrors` lives on the snapshot** (`WorkspaceSnapshot.branchErrors`, project id → cause), not on `Project`, because it is memory-only state. Branch lists and errors are kept in `WorkspaceState` (`branches`, `branch_errors`) and stored through `graph::set_branches`. That function emits `workspace://changed` only on a change and never writes the file. Reads that race a toggle-off are ignored. "Not a repository" yields no list and no error.
- **`branches unavailable` takes the path row** instead of adding a fourth line. The project card is fixed at 240 × 80 and the column starts at y = 92, so an extra line would overlap the first child. The full path then moves to the label's hover. DESIGN.md and the README say so.
- **Stored `BranchNode`s show only while their branch is listed and branches are on.** They are matched by `(projectId, name)`. A move upserts `{ id: <projectId>:<name>, projectId, name, position }` with no `worktreePath`. Re-layout clears branch positions and also drops branch refs that have no `worktreePath`, mirroring the bare session-ref prune. `remove_project` treats discovered branch child ids as branch ids when pruning edges.
- **`children(...)` keeps its 4-argument signature** (no branches) for existing callers and tests. `children_with_branches(..., listed)` is the full derivation that `WorkspaceState::children` uses.
- **Watch (`git/watch.rs`).** It watches the common dir non-recursively (`HEAD`, `packed-refs`), `refs/heads` recursively, and `worktrees/` recursively. `worktrees/` is armed by the debounce thread once it appears, since the first `worktree add` creates it. Events are filtered to those paths. A watch error counts as a change. `watch::sync` starts and stops watches to match `showBranches`. It is called by `project_set_show_branches`, `workspace_remove_project` and the 30 s pass, which also re-arms a watch that failed to start.
- **Refresh lock.** `AppState::branches_lock` serialises every branch refresh (watcher, 30 s pass, toggle), so at most one runs at a time, for any project.
- **The 30 s pass** rides the git status poll loop (`BRANCH_FALLBACK`), checked after each status pass, so its granularity is `poll.git_ms` (5 s by default).
- **Toggle on also expands** the card, in Rust (`graph::set_show_branches`), so the palette and the menu behave like the chip.
- **Frontend groups.** `projectColumn` lays out the session group, then the branch group. Each has its own `showAll` key: the project id for sessions (unchanged), `branches:<projectId>` for branches. A `more` row id is that key (`more:branches:<id>` as the flow id). `Show all sessions` and `ctrl+j`'s reveal cut only the session group.
- **Commands.** `project.toggleBranches` is enabled only while the status poll reports the selected project as a repo. Its title follows its state through a new optional `Command.dynamicTitle`, which `listCommands` resolves. It sits at menu order 33. `branch.copyName` writes with `navigator.clipboard.writeText`; a missing or refusing clipboard shows a notice. A right-click on a branch now opens the node menu, which holds only that entry. Turning branches off clears the branch group's show-all and any selected branch card of that project.
- **Worktree chip text** is the last two path segments, prefixed `…/` when the path has more (`…/.worktrees/feat`).
- **Tests.**
  - Rust: parsers, sort, worktree join (main, self and prunable skipped or marked), a real temp repo (upstream set without any fetch via `update-ref` and config, `gone`, a linked worktree, a deleted worktree folder, detached HEAD, run from inside the linked worktree), common dir, failing git, the real watcher (a new branch within 2 s, one refresh per burst, `worktrees/` armed late, stopped on drop), and the IPC toggle end to end (list, watch start, `git branch fresh` seen within 3 s, off stops the watch). Every temp repo sets `user.name` and `user.email` locally and uses `GIT_CONFIG_GLOBAL=/dev/null`.
  - Vitest: the two-group layout with 25 branches, the second-line parts, the chip text, the labels, the error flag, identity reuse, and the commands.
- **Not run:** `npm run tauri build -- --debug --no-bundle` and the manual screenshot checks. GUI work was out of scope for this session.

Review round 1 patches (P1–P13):

- **P1 Branch names.** The listing uses `%(refname:lstrip=2)`. A real-repo test adds a tag named `feat`: the branch keeps the name `feat` and its worktree chip.
- **P2 Watch coverage.**
  - **What is watched.** The common dir and `refs` are watched non-recursively, so the creation of a missing target is seen. `refs/heads`, `refs/remotes`, `worktrees` and `reftable` are watched recursively, each armed by the debounce thread as soon as it exists, so a missing `refs/heads` gets the same late arming as `worktrees/`. Relevant events are `HEAD`, `packed-refs`, `refs/heads/**`, `refs/remotes/**`, `worktrees/**` and `reftable/**`. The README says so.
  - **Restart.** `sync` re-reads every wanted project's common dir and replaces a watch whose dir changed. A failed rev-parse keeps a running watch.
- **P3 Fallback pass.** It is a separate async task, not inside the status loop: every 30 s it runs `sync` on a blocking thread, then `refresh_branches`. `refresh_branches` reads projects in parallel, at most 4 at once. Each read takes its project's own lock (`AppState::branch_locks`, a `BranchLocks` map of tokio mutexes, forgotten on project removal) and stores its outcome on its own, so one slow repo never delays another.
- **P4 Cleanup.**
  - **Prune on read.** A successful read (only `Ok(Some)`, never a failure) prunes the project's `BranchNode`s whose name is not listed, unless an edge end of type `branch` or a session ref's `branchId` names the ref's id or its `<projectId>:<name>` child id. The file is then written.
  - **Re-layout** keeps referenced refs.
  - **Project removal** drops branch edges whose id starts with `<projectId>:`, even while branches are off.
  - **`branch_for_cwd`** returns `<projectId>:<name>`.
- **P5 Errors.**
  - **Wording.** `branch_error` reads like the status poll: `git unavailable`, `git exited with code N`, git's first stderr line, or `timed out after …`.
  - **Gone folder.** `read_branches` turns "not a repository" into `Err("not a git repository")` and a missing folder into `Err("folder missing")`. Both show `branches unavailable` and keep the last list. `set_branches` still accepts `Ok(None)` (drop the list, no error), but no caller sends it now.
- **P6 Toggle reachability.** `branchesChipShown(project, isRepo)` (repo, or `showBranches` on) decides both the chip and the `when` of `project.toggleBranches`.
- **P7 Race-free sync.** The common dirs are read with no lock held. The decisions, removals and inserts then happen in one critical section of the watch map, against the workspace as it is at that moment. Removed watches, and `Watches::clear`, are dropped after the lock is released.
- **P8 Own checkout.** `branches_of` also runs `git rev-parse --show-toplevel` and attaches a chip to every non-bare worktree except the one at that top level.
  - **Subfolder project.** It does not chip its own branch.
  - **Linked-worktree project.** It chips the main checkout's branch with the main path.
  - **Locked worktrees** keep their chip.
  - **Tests** cover each of these, plus the bare-record skip.
- **P9 Show-all keys.** The ui store keeps one list of project ids per group (`showAll` for sessions, `showAllBranches` for branches), and `toggleShowAll(projectId, group = "sessions")`. A `more` target is `{ kind: "more", id: projectId, group?: "branches" }`; no group means sessions. Its flow id is `more:<id>` or `more-branches:<id>`, and the group is part of its identity in `sameTarget` and node rects. A project id that looks like a prefix (`branches:p`) cannot collide.
- **P10 Chip.** The `aria-label` is gone: the name is the button text "branches", and `aria-pressed` carries the state. The `title` still says Show or Hide branches. When on, the text and border are `--fg`; hover only lifts the border to `--fg-muted`. DESIGN.md is updated to match.
- **P11 Dead code.** `layoutChildren` is removed and its test now drives `projectColumn`. The unreachable clear-selection path in `toggleBranches` is removed: the command always runs on a selected project, so no branch card can be selected then.
- **P12 Tests.**
  - **Show all sessions.** With 5 sessions and 10 branches it is not offered. With 11 sessions and 12 branches it toggles only the session list.
  - **`removeProject`** clears a selected branch-group `more` row and both show-alls.
  - **The IPC test** removes the project and checks its watch stops.
  - **Watcher.** A direct `packed-refs` write is seen, `refs/remotes` is armed late and its changes are seen, and a locked worktree is covered in `branches.rs`.
  - **Timing.** The watcher timing bound is the shared `watch::tests::SEEN_WITHIN` (3 s; the product target is 2 s), used by both `watch.rs` and the IPC test.
  - **Also added:** `branch_error` wording, gone or non-repo reads, per-project locks, pruning, prefix edge removal, and the toggle staying offered when the folder is not a repo while branches are on.
- **P13.** `epic-5-context.md` open decisions 1 and 2 are marked resolved by this spec.

- 2026-10-19 GUI pass (orchestrator): the project was a scratch demo repo in the session scratchpad, with `main`, `tracked` (faked upstream, ahead 2 / behind 1), `feat` (linked worktree) and `local-only` (upstream gone). "Show branches" from the palette gave `main *`, `tracked ↑2 ↓1`, `feat` with the worktree chip `…/scratchpad/gitdemo51-wt-…` (ellipsised by the card width), and `local-only upstream gone`. `git branch fresh` run in the demo repo showed a `fresh` card within 1.8 s. No real repo was touched.

- 2026-10-19 GUI re-run after the patch round (orchestrator, scratch demo repo): the same cards as the first pass, the chip shown pressed, and `fresh` appeared within 1.8 s of `git branch fresh`.

## Spec Change Log

- 2026-10-19 (review round 1, Emils' decisions): (1) when reading branches fails, `branches unavailable` replaces the project card's path row (the card is a fixed height) instead of adding a line, and the path moves to the name's tooltip; (2) the self-contradictory Interaction wording is fixed: right-click on a branch opens its one-item menu ("Copy branch name"), and Enter does nothing new. Frozen Decisions amended.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 Branch names: use `%(refname:lstrip=2)` instead of `refname:short`, so a branch that shares its name with a tag keeps its own name, id, copy text and worktree match. Test with a colliding tag.
- P2 Watch coverage:
  - Also watch `refs/remotes/**`, so a fetch updates `↑n ↓m` and `upstream gone` within 2 s.
  - Watch `reftable/` when it exists.
  - Arm `refs/heads` late when it is missing at start, as `worktrees/` already is.
  - Restart a watch whose common dir changed.
  - The README states what is watched.
- P3 The fallback pass runs off the status loop, on its own thread. It reads projects in parallel with a limit of 4 and locks per project, never per pass, so a watcher refresh never queues behind a slow repo.
- P4 Cleanup:
  - After a successful read, a `BranchNode` ref whose branch is no longer listed is pruned, unless an edge or a session's `branchId` references it.
  - Re-layout keeps referenced refs.
  - Removing a project also removes edges to its branch cards (ids `<projectId>:…`).
  - `branch_for_cwd` returns ids in the `<projectId>:<name>` form.
- P5 Errors:
  - `branch_error` uses git's first stderr line, and non-zero exits read like the status poll's.
  - A folder that is no longer a repo while branches are on gives `branches unavailable` with the cause `not a git repository`, not a silent empty group.
- P6 The toggle stays reachable: the chip and `project.toggleBranches` are offered whenever `showBranches` is on, even when the status is not `repo`, so branches can always be turned off.
- P7 Watch sync is race-free: the check and the insert happen in one critical section, and dropped watches are stopped after the lock is released.
- P8 Linked worktree projects: the project's own checkout is identified by `git rev-parse --show-toplevel`, so a subfolder project never chips its own branch. When the project is itself a linked worktree, the main checkout's branch gets a chip with the main checkout path. Tests.
- P9 The show-all keys for the branch group use a form that cannot collide with a project id (a structured key, not a string prefix).
- P10 The toggle's accessible name is the fixed "branches", and `aria-pressed` alone carries the state. The on state is visibly distinct from hover: the border is `--fg`.
- P11 Dead code: remove `layoutChildren` if nothing uses it, and remove the unreachable clear-selection path in `toggleBranches`, or make it reachable and test it.
- P12 Tests:
  - "Show all sessions" with branches present (5 sessions and 10 branches: not offered; 11 sessions and branches: toggles the session key only).
  - `removeProject` clearing the branch group's show-all and `more` selection.
  - Removing a project stopping its watch.
  - A `packed-refs`-only change (deleting a packed branch).
  - A locked worktree.
  - The watcher timing tolerance in `watch.rs` unified with the IPC test (3 s, documented).
- P13 `epic-5-context.md`: mark open decisions 1 (layout, toggle saved per project, keys) and 2 (which branches are saved) as resolved by this spec.

**Defer:**
- D1 A test of the poll loop's fallback scheduling. It needs the loop body pulled into a testable tick function, and the status loop itself is untested today.
- D2 Render tests for the project chip and the branch card (no component test environment yet).

**Dismiss:**
- "Tasks ticked while the GUI check was not run": the orchestrator's GUI pass ran (Implementation Notes).

## Design Notes

- **Common git dir.** For a project that is itself a linked worktree, `.git` is a file. `git rev-parse --git-common-dir`, resolved against the project folder, gives the shared dir with `refs` and `packed-refs`, so the watcher and the worktree list work the same for both kinds of checkout.
- **Watcher storms.** A rebase touches many refs. The 300 ms debounce collapses them into one refresh, and at most one refresh per project runs at a time.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):** orchestrator, foreground-guarded:
- In a scratch temp repo planted as a project (branches `main`, `feat` with a worktree, `local-only`), turn branches on and screenshot.
- Run `git branch fresh` in that temp repo from the script, and screenshot within 2 s.
- No real repo is touched.
