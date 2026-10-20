---
title: 'Story 5.4: Sessions follow worktrees; remove worktree'
type: 'feature'
created: '2026-10-20'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '708b70a05962a78944a70a4d2a570f6388bd6e01'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Sessions that ran in a worktree are lost after a restart. The transcript scan matches only the project folder, and the cwd→branch mapping knows only worktree paths the app stored. A live session in a worktree the app never stored (for example Claude's own `.claude/worktrees/<name>`) lands in the Elsewhere tray. Worktrees also cannot be removed from the canvas.

**Approach:** Rust keeps each repo project's linked worktree list in memory. That is the list the 5 s status poll already reads for the dirty count. Discovery, live sessions and branch mapping then accept any known worktree of the project. A "Remove worktree…" command on a branch card opens the app's first confirmation sheet, which runs `git worktree remove` safely.

**Decisions:**
- **Known worktree paths of a project:**
  - **Which paths:** the stored `BranchNode.worktreePath`s, plus every non-bare, non-missing linked worktree that `git worktree list` reports for the repo, whatever the branches toggle is. They are kept in memory by the status poll, with no extra git call.
  - **Transcripts:** a transcript dir whose cwd equals the project path *or* one of these paths is discovered under that project.
  - **Which branch:** the session's branch is the worktree holding its cwd, deepest first, by branch name, giving `<projectId>:<name>`.
  - **Live rows:** live rows map to a project and branch by the same rule, so they no longer land in the Elsewhere tray.
  - **Display:** sessions show under their branch card as in Story 5.3, or in the session group while branches are off.
- **Remove worktree (command):** `branch.removeWorktree`, "Remove worktree…", in the branch node menu (order 53) and the palette. It is offered on a branch card with a worktree chip, including a `missing` one. It has no key.
- **The sheet:** a pane on the right with:
  - the title `Remove worktree`;
  - the branch and full path;
  - the exact command Rust will run, for example `git worktree remove <path>`;
  - a checkbox `Also delete branch <name>` (off by default). When ticked, `git branch -d <name>` runs after a successful remove, and the preview shows both commands. A refusal (unmerged, or checked out elsewhere) shows its git message in the sheet. The worktree stays removed. There is never a `-D`. With the box off, a line says the branch is kept.
- **What the sheet checks first (read-only):**
  - **Clean.** One **Remove** button; the click is the confirmation. Enter does not remove.
  - **Dirty.** The dirty count comes from `git status` run inside the worktree, with modified and untracked files both counted. The sheet says `N changed files (modified or untracked)`, and **Remove** is replaced by **Force remove…**. Pressing that reveals a second, explicit button, `Discard N changed files and remove`, with the command shown as `git worktree remove --force <path>`. Only that second click runs it.
  - **Locked.** The sheet says `locked` and refuses (unlock it in git first). There is no force.
  - **Live session.** If a live session or an app terminal has its cwd inside the worktree, the sheet refuses with `a session is running in this worktree: <name>`. Stop it first.
  - **Missing folder.** The command is `git worktree remove <path>`, which clears only that stale record, and **Remove** runs it (amended in review round 1).
- **Running it:**
  - It runs under the project's branch lock, from the project folder, with a 30 s timeout.
  - On success, the branches and status are re-read, so the chip goes. The branch card stays, because the branch still exists.
  - On failure, git's first stderr line shows in the sheet (on Windows, for example, a process holding a file).
- **After removal (sessions keep their place):**
  - Rust stores the worktree's path on its `BranchNode` before removing, even if it was only known from `git worktree list`. The path is kept as history: the chip goes, because it comes from git, but the past sessions stay discovered and listed under the branch card. Resume then falls back to the project folder (Story 4.4 `resume_cwd`).
  - A stored `BranchNode` with a `worktreePath` is never pruned, even when its branch is deleted. Its sessions then show in the session group.
  - Launches (Story 5.3) still resolve from git's live list, so a removed path is never used as a cwd.

## Boundaries & Constraints

**Always:**
- **Git writes only on an explicit click,** and in tests only in temp repos the tests create.
- **No `~/.claude` writes.** Tests use a temp `claude_home`.
- **Rust owns the checks and the command text.**
- **CI and lint.** Both CI runners stay green, and the design lint passes. Tokens only; the accent appears only through `.pane-error`.

**Never:**
- Unlocking or moving worktrees.
- Fetch.
- Remote branches.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Discovered in worktree | transcript cwd = `<repo>/.worktrees/feat` | session under `feat` after restart | — |
| Claude's worktree | live session in `<repo>/.claude/worktrees/x` | under `worktree-x`, not Elsewhere | — |
| Branches off | same transcript | in the project's session group | — |
| Clean remove | `feat` clean | `git worktree remove <path>` runs; chip gone; card stays | git error → sheet |
| Dirty | 2 modified + 1 untracked | `3 changed files`; Remove refused; Force → second confirm → `--force` | — |
| Locked | locked worktree | refused `locked` | — |
| Live | session running in it | refused, names the session | — |
| Missing | chip `missing` | `git worktree remove <path>` clears only that record; chip gone | other stale records untouched |
| After remove | `feat` had 2 sessions, worktree removed | both still under `feat` after restart; chip gone | — |
| Delete branch | box ticked, `feat` merged | remove then `git branch -d feat`; card gone, sessions in the session group | unmerged → git's refusal shown, worktree stays removed |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/git/poll.rs`:** `status_of` (:296) already runs `worktrees_inside`. Keep the full parsed worktree list (`branches.rs` `parse_worktrees` :117, absolute paths and branch names) per project in memory: a new `LiveState`/`WorkspaceState` field, never persisted.
- **`src-tauri/src/claude/sessions.rs`:** `scan` (:73) takes several paths per project and matches with `same_path` against any of them (:83). `refresh` (:212) builds them. `sessions_for` and import stay project-only.
- **`src-tauri/src/graph/mod.rs`:**
  - `project_for_cwd` (:510) and `branch_for_cwd` (:536) also use the in-memory worktree list. Their callers are `children_with_branches` (:398/:441) and `claude/live.rs` (:377/:475).
  - Add a mutator that records a worktree path before removal (reuse `upsert_created_branch`).
  - `set_branches` prune (:890) skips nodes with a `worktreePath`.
- **`src-tauri/src/git/worktree.rs`:** add `remove_check` (status inside the worktree via `git/status.rs` `repo_status`, with its nested worktrees excluded as `poll::status_of` does; locked/prunable from the porcelain list) and `remove(force)`. Mirror `add_with_timeout` (:323) and `Plan.command_line` (:86).
- **`src-tauri/src/ipc/mod.rs`:**
  - `worktree_remove_preview` and `worktree_remove(projectId, branch, force)`, with `branch_locks` as `worktree_add` (:247) does.
  - The live check uses `read_sessions_live()` rows (`is_live`, `path_within` cwd) and `TermManager::list()` `TermInfo.cwd` (pty/mod.rs:1268).
  - Afterwards: `refresh_branches` and `refresh_ids`.
- **Frontend:**
  - A new pane `"removeWorktree"` (`src/state/ui.ts:29`, `App.tsx`, `panes.ts`), store and component modelled on `src/state/worktree.ts` and `WorktreePane.tsx`.
  - `builtins.ts` `branch.removeWorktree` (order 53, `selectedBranch()`, `navigation.ts:235`).
  - `src/ipc/index.ts` types.
- **Tests:** temp repos (`branches.rs` test helpers), and a temp `claude_home` with planted transcript dirs (the Story 3.1 pattern).

## Tasks & Acceptance

**Execution:**
- [x] `git/poll.rs`, `claude/sessions.rs`, `graph/mod.rs`, `claude/live.rs` (+tests) -- known worktrees: discovery, mapping, live rows
- [x] `git/worktree.rs`, `ipc/mod.rs`, `lib.rs` (+tests on temp repos: clean, dirty count, force, locked, live refusal, missing/prune) -- remove
- [x] `src/state/*`, `src/components/RemoveWorktreePane.tsx`, `src/commands/*`, `App.tsx`, `ipc/index.ts`, CSS (+vitest) -- confirm sheet and command
- [x] `README.md`, `docs/DESIGN.md` -- docs

**Acceptance Criteria:**
- Given a transcript whose `cwd` is a known worktree path, when discovered, then it is listed under that branch node.
- Given "Remove worktree" on a clean worktree, when confirmed, then `git worktree remove` runs and the node loses its chip; on a dirty worktree the action is refused with the dirty file count and a "force" option.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- 2026-10-20 GUI pass (orchestrator, scratch demo repo `gitdemo54`: clean worktree `feat`, worktree `dirt` with 2 modified + 1 untracked; stub `claude`): palette "Remove worktree" on `feat` opened the sheet (branch, full path, `No changed files.`, `Also delete branch feat` unticked with "The branch is kept.", the exact `git worktree remove <path>`, one Remove); Remove removed it (git no longer lists it), `feat` lost its chip and kept its card, `branches[]` kept its path. On `dirt` the sheet said `3 changed files (modified or untracked)` with **Force remove…**; that revealed `Discard 3 changed files and remove`; ticking the box added `git branch -d dirt` to the preview and switched it to `--force`; the click removed the worktree and the branch, the card went, `branches[]` kept `dirt`'s path as history. Discovery and the live-session refusal not driven in the GUI (Rust tests cover them).

- 2026-10-20 GUI re-run after the patch round (orchestrator, fresh `gitdemo54`, stub `claude`; a first attempt aborted on the foreground guard before any input, then Emils freed the screen): the clean remove of `feat` as before. On `dirt` (3 changed files) a double-click on **Force remove…** removed nothing: the button disabled itself and `Discard 3 changed files and remove` appeared in its own row below, disabled during the arm delay; after it the button enabled and one click ran `git worktree remove --force`. With the box unticked the branch `dirt` was kept, its card stayed without a chip, and both history paths remain in `branches[]`. Nothing left running.

## Spec Change Log

- 2026-10-20 (review round 1, Emils' decision): a missing-folder worktree is cleared with `git worktree remove <path>`, not `git worktree prune --expire now`. Triggering finding: prune clears every stale record in the repo, not just the selected one, and the other branches lose the only record of their path. Verified in a scratch repo (git 2.43): `remove` on a missing folder exits 0 and leaves the other prunable record in place. Frozen Decisions and matrix amended. KEEP: everything else.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 (high; B) A double-click on **Force remove…** can land the second click on `Discard N changed files and remove`, because the button node is reused in the same place, so files are discarded without a real second confirmation. The Discard button is a separate element below, not focused, and stays disabled for a short arm delay (about 600 ms).
- P2 (medium; B, E) Force discards whatever is dirty at click time: the call sends the confirmed count, and Rust refuses if it changed (the sheet then re-checks).
- P3 (medium; B, E) After a refusal the sheet keeps its stale check: re-run the preview after any refusal.
- P4 (medium; B, E, V) The missing-folder case prunes every stale record: `git worktree remove <path>` instead (Spec Change Log).
- P5 (medium; B) A failed remove still stores a permanent history path: record the path only after the remove succeeded.
- P6 (medium; B, E) Two projects on one repo: discovery takes the first project, the live mapping the last. Use one rule for both (the first project in workspace order whose folder or known worktree holds the cwd, deepest match first). Test.
- P7 (medium; B, E) A transient non-timeout listing failure empties the known list (sessions flicker to Elsewhere). Keep the last list on any failure except not-a-repo or folder gone.
- P8 (medium; E) For a project that is itself a linked worktree, the main checkout counts as a known worktree, so any cwd under the main repo maps to it. Exclude the main worktree (the first porcelain record). `remove_check` refuses the main checkout (`the main checkout cannot be removed`).
- P9 (low; B) The `locked <reason>` text is dropped: show the reason in the sheet.
- P10 (low; B, E) The running check covers only the folder an app terminal started in: README and DESIGN say so.
- P11 (medium; V×4) Tests:
  - the production live path (`apply_and_emit`) with a git-listed worktree;
  - the 5 s `refresh` storing the known worktrees;
  - a stored and listed tie on the same path (git's list wins);
  - an app terminal in the worktree refusing the remove.

**Defer:**
- D1 (B, E) History keeps one path per branch: a later worktree for the same branch at a *different* path overwrites the older history path, and its sessions lose their placement. It needs a list of past paths (schema change). Rare with the default root (same path).
- D2 (V) A test that a status-listing timeout keeps the last list needs the error-to-update mapping pulled into a helper.
- D3 (V, B) Component tests for the sheet's safeguards (Enter swallowed, focus on Close, no button reuse): there is no DOM test setup yet (as 5.1 D2).

**Reject:**
- (false; B) Branch sent by card label: a branch card's label is always the git name.
- (low; B) Discovery runs before the first status poll fills the list, so sessions in unstored worktrees appear up to one poll (5 s) later at startup: brief and self-correcting.
- (low; B) A failed status read gives a refusal with no Retry: Close and reopen re-checks.
- (low; E) A 30 s timeout during remove may leave a half-deleted worktree: rare, and git's error shows.

## Design Notes

- **Verified in a scratch repo (git 2.43):**
  - `remove` refuses both modified and untracked files ("contains modified or untracked files, use --force").
  - A locked worktree needs `-f -f`; a single `-f` still refuses.
  - The branch always survives the removal.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:** orchestrator, foreground-guarded, scratch demo repo, stub `claude`:
- Remove a clean worktree, and screenshot the sheet and the card without its chip.
- On a dirty worktree, check the count, Force, then the second confirm.
