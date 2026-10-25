---
title: 'Story 8.2: Branch and commit diffs'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'c1957c8d44f149a0266a8ca039a53fe51c82dc24'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Review pane (8.1) shows only uncommitted changes. Most of a worktree's work is already committed, so the operator cannot see what a branch changed as a whole, or what one commit did.

**Approach:** On a branch node, and on a project node for its checked-out branch, the Review pane gains two more modes beside "Changes":
- **vs base:** the branch against the merge-base with a selectable base branch.
- **Commits:** the branch's commits; selecting one shows its diff.

Rust reads both from git, and the tree, merge view and limits from 8.1 are reused.

**Decisions** (taken by the orchestrator under Emils' standing authorisation while he was away; recorded for his review):
- **Mode toggle.** It reads Changes / vs base / Commits.
- **Where the modes apply:**
  - **Branch node:** all three modes. Changes needs the branch's worktree (8.1 rules); vs base and Commits work for any local branch, worktree or not, reading the repository at the project folder.
  - **Project node:** all three, with vs base and Commits applying to its checked-out branch.
  - **Session node:** Changes only.
- **Base:**
  - The default is the repository's default branch, using the existing `default_branch` rule: the `origin/HEAD` name, then `main`, then `master`.
  - A dropdown offers every other local branch.
  - When the branch *is* the base, or the range is empty, the pane says `No commits on <branch> beyond <base>`.
- **vs base:**
  - The list comes from `git diff --numstat -M` and `--name-status -M` between `merge-base(base, branch)` and `branch`; that is, what the branch changed since it forked.
  - Each file's old side is `<mergebase>:<old path>` and its new side is `<branch>:<path>`.
  - Statuses are added / deleted / modified / renamed. Counts, caps (5,000 rows, 2 MB / 50,000 lines a side), binary / submodule / not UTF-8, and CRLF handling all follow 8.1.
- **Commits:**
  - `git log <base>..<branch>`, newest first, capped at 200 with `N older commits not shown`.
  - Each row shows the short hash, subject, author and relative time.
  - Selecting a commit shows its changed files, diffed against its first parent; a root commit is diffed against the empty tree.
  - Within a commit the same tree and merge view are used, with a "back to commits" control.
- **Freshness.** vs base and Commits are read when the mode opens and on Refresh. They do not poll.
- **Rust owns the data.** The UI sends only the target, the mode, the base name and a commit hash from a list Rust gave it. Rust checks that the base is a local branch and that the hash belongs to the listed range.

## Boundaries & Constraints

**Always:**
- **Read-only.** git is run through the CLI (no git library) with the 8.1 env conventions, and nothing is written to any repository.
- **Tests and CI.** No `~/.claude` writes, tests never run the real `claude`, and tests use temp repos only.

**Never:**
- Files mode or external open (8.3), and comments (8.4).
- Remote branches as the base, fetching, checking out, or any write.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| vs base | `feat` forked from `main`, 2 commits, `main` moved on | files changed on `feat` since the fork only; diff merge-base vs `feat` | — |
| Base change | pick `develop` | list re-read against `develop` | unknown base → error line |
| Commits | `feat` with 3 commits | 3 rows newest first; select → its files and diff | — |
| Root commit | branch whose first commit is the root | diff vs empty tree | — |
| Merge commit | merge in range | diffed against first parent | — |
| No worktree | branch without worktree | Changes says `no worktree`; vs base and Commits work | — |
| Same as base | project on `main`, base `main` | `No commits on main beyond main` | — |
| Many commits | 250 commits | 200 rows + `50 older commits not shown` | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- `git/diff.rs` — 8.1's helpers are `show()` (:642), `content_of()` (:672), `cap_rows` (:447), `parse_numstat_z` (:283), `empty_tree()` (:542), `Repo` (:474), `describe()` (:485) and `literal()` (:741).
  - Add a numstat-driven range lister plus `--name-status -z -M` parsing, because 8.1's lister is driven by `status`.
  - Add `range_list(git, repo, a, b)` and `range_file(git, repo, a, b, path)`.
  - Add `merge_base` and `log` parsed with `%x00` fields, capped at 200 plus `more`.
- `git/worktree.rs` `default_branch` (:123) and origin HEAD (:224) supply the default base. Do **not** use `options_from` (:134), which puts the checked-out branch first.
- `git/branches.rs`: the local branch list (cached in `state.read_workspace().branches`) is used to validate the base.
- `review/mod.rs` — `ReviewTarget` (:395) and `target_folder` (:426).
  - Add a resolver that returns the project folder and the branch name for vs base and Commits. It does not require a worktree, unlike `branch_folder` (:416, `CHECKED_OUT`/`NO_WORKTREE`).
  - For a project target, the branch is the checked-out branch.
- `ipc/mod.rs` — near `review_list` and `review_file` (:509, :532), add:
  - `review_base_info(target)` returning the default base, the choices and the branch;
  - `review_range_list(target, base)` and `review_range_file(target, base, path)`;
  - `review_commits(target, base)`;
  - `review_commit_list(target, base, sha)` and `review_commit_file(...)`.

  The implementer may merge these into fewer commands. Register them in `lib.rs`.

**Frontend (`src/`):**
- `state/review.ts`: add `mode`, `base`, `commit` and `commitList` to the store, and reset them in `openTarget` (:94-99).
- `components/ReviewPane.tsx`:
  - the mode toggle before the filter toggle (:190-203), with the filter shown only in Changes mode;
  - the base `<select>`;
  - a commits list in the tree column, with a back control;
  - reuse `DiffArea` (:364).
- `commands/review.ts` and `builtins.ts` (~:631-690): palette rows "Review: changes / vs base / commits". Update the id lists in `builtins.test.ts` (:98-106, :229-237, :281). Skip the own poll outside Changes mode.
- Update `ipc/index.ts` types, and the README Review section.

**Tests:**
- Temp repos with `branches::tests::{git_ok, real_git, temp_repo}` (branches.rs :507-537). Cover:
  - a branch forked and its base moved on;
  - a root commit and a merge commit;
  - a rename in range;
  - more than 200 commits (a cheap loop);
  - a base that is not a local branch;
  - a hash not in the range.
- Pure parsers. Vitest for the mode state and the commits list model.

## Tasks & Acceptance

**Execution:**
- [x] `git/diff.rs` (or a new `git/range.rs`), `review/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests): merge-base, range list/file, log, commit list/file, validation.
- [x] `state/review.ts`, `ReviewPane.tsx`, `review/model.ts`, `commands/review.ts`, `builtins.ts`, `ipc/index.ts` (+vitest): modes, base select, commits list.
- [x] `README.md` and `docs/DESIGN.md` (if the toolbar changes).

**Acceptance Criteria:**
- Given a branch node whose branch forked from `main`, when I choose "vs base", then the pane lists exactly the files the branch changed since the merge-base, and the base can be changed.
- Given "Commits", when I select a commit, then its files and diff against its first parent are shown.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Rust** lives in a new `git/range.rs` (8.1's `name`, `describe`, `run_ok`, `empty_tree`, `show`, `literal` in `diff.rs` became `pub(crate)`). `review::range_target` resolves a project or branch target to the project folder plus the branch (`None` = checked-out branch, from `git symbolic-ref`; detached HEAD is refused); a session is refused with `NO_RANGE`.
- **Fewer commands** (allowed by the Code Map): `review_range_list(target, base?, commit?)` covers vs base (no commit) and a commit's files; `review_range_file(target, base?, commit?, path)`; `review_commits(target, base?)`. There is no separate `review_base_info`: every reply carries `branch`, `base`, `defaultBase` and `bases` (all local branches) flattened in, plus `ahead` (`rev-list --count base..branch`) for the `No commits on <branch> beyond <base>` line.
- **Base validation** reads the local branch list fresh with `git for-each-ref refs/heads` on each call rather than the cached `read_workspace().branches` (that cache only exists while a project's branches are on, and may be stale). Refs are always passed as `refs/heads/<name>`.
- **`--raw -z -M` instead of `--name-status -z -M`**: the raw records carry the same status letter plus both modes, which is how a submodule (`160000`) is detected; counts come from `--numstat -z -M`. Rows are keyed by the raw records.
- **Scope**: vs base and commit file lists keep only the project folder's files (paths relative to it, as in 8.1). The raw diff runs on the whole repository for rename pairing; numstat runs on `.` plus the sources of renames into the folder. `git log` and the commit-hash check are *not* path-limited (a pathspec would turn on history simplification and could drop merge commits).
- **Commit check**: only a full 40/64-hex hash among `rev-list --parents --max-count=200 base..branch` is accepted; its first parent (or the empty tree for a root) is the old side. vs base with unrelated histories says `no common ancestor with <base>`.
- **UI**: store gains `mode`, `base`, `commit`, `commitList` (reset by `openTarget` on a new target); `setMode` ignores modes the target lacks. Palette: `review.modeChanges/modeBase/modeCommits` ("Review: changes / vs base / commits"). The status-poll refresh and the own poll are skipped outside Changes; Refresh still re-reads. The commit list is not a palette-steppable list (`j`/`k` step files only); "back to commits" is a button only.
- **GUI checks:** run by the orchestrator; see the GUI pass entries below.
- **Review fixes (round 1):**
  - `merge_base` and `checked_out` no longer call `unwrap_err`.
  - **Default base:** the `default_branch` result is used only when it is a local branch other than the compared one; else the first other local branch; else there is no base (`no base branch: pick one`). So the frozen matrix's "project on main → main beyond main" now happens only when `main` is picked explicitly.
  - **Errors with choices:** failures after the branch is known come back in the reply's `error`, with the bases; the pane keeps the last-known base choices.
  - **Pinned reads:** the tip and the base are `rev-parse`d once per read.
  - **Subfolder projects:** the list's raw diff covers the whole repository, so a rename into a subfolder project pairs up (a rename out is a deletion). An empty subfolder range shows `No changes in this folder`.
  - **Cost:** `file` diffs only the requested path, plus a rename lookup for an added file; `ahead` is skipped in commit mode.
  - **Names:** non-UTF-8 branch names are skipped, and rows dedup on the top-relative path.
  - **UI:**
    - A branch without a worktree opens in vs base.
    - Filter commands run in Changes only, and a mode command is not offered for the mode already showing.
    - `setCommitList` drops a commit that is no longer listed, and `not a commit of this list` is hidden while the commit list reloads.
    - Commit rows lay out as hash · subject · author and age.

- 2026-10-25 GUI pass (orchestrator; scratch repo `reviewdemo82`: `main` with a root commit, `feat` with 3 commits including a rename and a worktree, then `main` moved on):
  - `r` on the `feat` branch node opened `demo:feat` with Changes / vs base / Commits.
  - **vs base** (base `main (default)`) listed exactly `b.txt renamed from a.txt +0 -0`, `lib.rs +1 -0` and `README.md +1 -0`, without `main`'s later change.
  - **Commits** listed 3 commits newest first (author `t`, `now`). Selecting `add two` showed `lib.rs` diffed against its parent, with `← Commits` and the `b62dc97 add two` header.
  - **Defect:** in the commit rows the short hash and the subject were drawn over each other, so the text overlapped.

- 2026-10-25 GUI re-run after review round 1 (same repo): Commits rows now read `0c158bd rename a to b · t · 14m` with hash, subject and age in separate columns, no overlap. vs base was unchanged (3 files, base `main (default)`).
- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away): cargo test (536), clippy, tsc, vitest (606), the debug build and two GUI passes. **Linux CI is pending:** GitHub Actions is suspended.

## Spec Change Log

- 2026-10-25, review round 1 (blind-hunter and edge-case-hunter: the default base could be the branch itself, or a branch with no local copy). **Orchestrator decision, under Emils' standing authorisation while he is away (for his review):** the default base is the `default_branch` result only when that is a local branch other than the one compared; otherwise the first other local branch; otherwise none, with `no base branch: pick one`. The frozen row "Same as base" still holds when that base is picked explicitly. KEEP: the default rule order `origin/HEAD` → `main` → `master`, and the explicit choice of any local branch.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V). Triaged by the orchestrator under Emils' standing authorisation while he is away; no change to frozen text.

**Patch:**
- P1 (medium; B) `merge_base` reaches `success().unwrap_err()` when git exits 0 with empty output. That panics, and the release build aborts on panic. Return a plain `Err`, and audit `checked_out` for the same pattern.
- P2 (medium; B, E) The default base:
  - is not checked to be a local branch;
  - falls back to the branch itself, which shows `No commits on X beyond X`;
  - otherwise falls back to the alphabetically first branch.

  Use the rule's result only if it is a local branch other than this one. Otherwise take the first other local branch. Otherwise show `no base branch: pick one` with an empty range. Document this, and test it with `origin/HEAD`.
- P3 (low; GUI pass, B, V) The commit rows still overlap; `.review-sha{width:auto}` alone is probably not enough. Lay each row out as hash (no shrink, gap), then subject (ellipsis), then author and time. Confirm in a GUI re-run.
- P4 (medium; B, E, V) The base dropdown shrinks to one option, or disables, while a new base loads or after a failed read (for example `no common ancestor`), so the operator cannot recover. Keep the last known base choices outside the keyed list, and return the choices with an error.
- P5 (low; B, V) In a project inside a subfolder of the repository, commits that touch nothing in the folder open an empty tree with no explanation. Show `no changes in this folder`. Add a real-git test with the project folder at `repo/web/`, covering vs base, a commit list and `file`.
- P6 (low; B) A branch without a worktree opens in Changes and shows `no worktree`. Open it in vs base.
- P7 (medium; B) Every file click re-runs the whole range diff, and `ahead` runs even in commit mode. `file` diffs only the requested path, plus a rename's source. Skip `ahead` when a commit is selected.
- P8 (low; B) Refresh after the branch is rewritten briefly shows `not a commit of this list`. Drop the stale commit before the list re-read, or hide that error while the commit list reloads.
- P9 (low; E) The branch tip can move between the git calls of one read. Resolve the tip once per read and pass the sha to every call.
- P10 (low; E, B) Palette details:
  - the filter commands should run only in Changes;
  - a mode command should not be offered for the mode already showing.
- P11 (low; E) A branch name that is not UTF-8 passes the lossy check; skip such names. Deduplicate the range rows on the top-relative path, not on the lossy relative one.
- P12 (low; B) Test hygiene:
  - the fast-import test builds its own git environment; use the shared one;
  - the `commitAge` tests depend on the local timezone; make them independent of it.
- P13 (low; B, V) Tests:
  - the base-select mapping as a pure helper (the default sends `null`, and the `(default)` label);
  - dropping a commit that is no longer listed (store or helper);
  - a rename from outside the project folder into it;
  - a merge commit whose first parent is outside the range.

**Defer:**
- (V) The ReviewPane wiring for the range modes, which needs a DOM test environment. Already tracked in deferred-work (8.1, 7.4).

**Reject:**
- (B) The spec's notes contradict themselves ("Not done: GUI checks" next to a recorded pass). That is bookkeeping, and the orchestrator corrected it in the notes.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator** (foreground-guarded, scratch repo with `main` plus a branch `feat` that has commits and a worktree):
  - vs base on `feat`;
  - change the base;
  - Commits, select one;
  - back to the commit list.
