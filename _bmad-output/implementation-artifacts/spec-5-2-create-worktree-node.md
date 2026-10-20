---
title: 'Story 5.2: Create a worktree node'
type: 'feature'
created: '2026-10-20'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '932a31fd7be52c0b4105625d6f4dedc4c01c028d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Branch cards (5.1) show which branches have a worktree, but the operator cannot create one from the canvas. Parallel sessions therefore cannot get their own checkout without a terminal. A worktree inside the repo also shows up as untracked and inflates the project's dirty count.

**Approach:** Add a "New worktree" sheet that slides in from the right, like the launch sheet. It creates a worktree for an existing branch, or for a new branch from a base. It shows the exact `git worktree add` command before running it, and on success the branch card with its worktree chip appears and is selected. Rust owns the command, the path rules and the persisted `BranchNode`. The dirty count ignores linked worktree folders.

**Decisions:**
- **Entry points:**
  - **Project command.** `project.newWorktree`, "New worktree…", is in the project node menu (order 12) and the palette. It is enabled while the status poll says the project is a repo.
  - **Branch command.** `branch.newWorktree`, "New worktree…", is in the branch node menu (order 51). It is offered on a branch card without a worktree chip and opens the sheet with that branch preselected.
  - **No new keybinding.**
- **Sheet:**
  - **Mode toggle:** "New branch" (the default from the project) or "Existing branch".
  - **New branch:** a name field and a base select. The base select lists the local branches and defaults to the checked-out branch, or to the repo's default branch when HEAD is detached.
  - **Existing branch:** a select of the local branches that have no worktree and are not checked out in any worktree.
  - **Command preview:** a read-only mono line with the exact command and resolved path, for example `git worktree add -b auth-refresh B:\r\.worktrees\auth-refresh main`. It updates as the operator types.
  - **Keys:** Enter or ctrl+Enter submits, and Esc closes, as in the launch sheet. The explicit submit is the consent; there is no second confirm.
  - **Errors:** a failure shows the git error or the validation message inline (`pane-error`) and keeps the sheet open.
- **Path rule:**
  - **Default root.** With `worktrees_root` null, the root is `<repo>/.worktrees/`, where `<repo>` is the project folder's `--show-toplevel`.
  - **Custom root.** A set root gives `<root>/<repo folder name>/<branch name>`, so one root can serve many projects. It must be an absolute path; a relative one is an inline error.
  - **The folder.** Under the default root it is `<root>/<branch name>`. A `/` in the name becomes nested folders. Git already forbids `feat` and `feat/x` existing together.
  - **Already exists.** If the target folder already exists, the add is refused with "folder already exists: <path>".
  - **Changing the root.** Changing `worktrees_root` in settings.json affects only worktrees created afterwards. Existing ones are never moved. No settings UI is added.
- **Validation (read-only, before running):**
  - The new branch name passes `git check-ref-format --branch`.
  - The new branch does not already exist.
  - On Windows, the name has no `<>"|` characters.
- **What runs:** `git worktree add [-b <new>] <path> <base|branch>`. It runs from the project folder with the existing git binary, env and a 30 s timeout. It holds the project's branch lock, then refreshes that project's branches.
- **Persisted node:**
  - On success, Rust upserts a `BranchNode { id: <projectId>:<name>, projectId, name, worktreePath: <canonical path> }`, keeping any stored position, and writes `workspace.json`.
  - If the project's branches are off, it turns them on, which also expands the card.
  - The new branch card is then selected.
  - The chip still comes from the live git read, as in 5.1.
- **Dirty count:**
  - `git status` gets one `:(top,exclude,literal)<rel>` pathspec per linked worktree (from `git worktree list`) whose path lies inside the repository's top level, relative to that top level, so a project that is a subfolder of the repo also leaves them out (amended in review round 1). Any worktree counts, not only app-created ones.
  - Stray files beside the worktrees still count.
  - Nothing is written to `.gitignore` or `.git/info/exclude`.

## Boundaries & Constraints

**Always:**
- **Git writes only on submit.** The only write is `git worktree add`, run only on the operator's explicit submit.
- **Tests write only to temp repos.** They create those repos themselves and never touch existing repositories.
- **No `~/.claude` writes.**
- **Rust owns the state.** It owns the state and the path resolution, and the UI only previews what Rust will run: the preview comes from a Rust command, not recomputed in TS.
- **CI and lint.** Both CI runners stay green, and the design lint passes (tokens only, no accent).

**Never:**
- Worktree remove or branch delete (5.4).
- Sessions on branches (5.3).
- `claude --worktree`.
- Moving existing worktrees.
- Remote branches as a base.
- Fetch.
- A settings UI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| New from main | new `auth-refresh`, base `main` | `git worktree add -b auth-refresh <repo>/.worktrees/auth-refresh main` runs; card `auth-refresh` with chip `…/.worktrees/auth-refresh` selected | — |
| Existing | branch `feat`, no worktree | `git worktree add <root>/feat feat` | — |
| Slash name | `feat/x` | folder `.worktrees/feat/x` | — |
| Dirty count | clean repo + 2 worktrees in `.worktrees/` | dirty 0 | stray `.worktrees/a.txt` → dirty 1 |
| Custom root | `worktrees_root` set, then changed | new ones under the new root; old stay | relative root → inline error |
| Name taken | `main` as new | inline "branch already exists" | nothing runs |
| Bad name | `a..b` | inline git check-ref-format error | nothing runs |
| Folder exists | target dir present | inline "folder already exists" | nothing runs |
| git fails | add exits non-zero | inline first stderr line, sheet stays | — |
| Branches off | toggle off before create | toggle on + card selected | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/git/worktree.rs` (new):**
  - `plan_add(git, project, settings, request) -> Plan {argv, path}`: pure path and argv resolution, plus read-only checks (`check-ref-format`, `show-ref --verify`, existence).
  - `add(git, plan)` uses `crate::process::run`.
  - Reuse `branches.rs:185` `git()` (make it `pub(crate)`), `canonical_or_raw` (:178), and `poll::branch_error` (:159) for wording.
- **Default branch, offline:** `refs/remotes/origin/HEAD` when set, else `main`, else `master`, else the first listed branch.
- **`src-tauri/src/git/status.rs:109`:** `repo_status_with_timeout` takes the excludes; `poll.rs` `status_of`/`poll_all` (:286/:225) pass the linked worktrees inside the project. Reuse the worktree list from `branches.rs` `parse_worktrees`, or run `worktree list --porcelain` there.
- **`src-tauri/src/graph/mod.rs`:** a new `upsert_created_branch(project_id, name, worktree_path)`, modelled on the `move_node` Branch arm (:1014). Use `set_show_branches` for the turn-on and `persist_and_emit` (:1038). Prune in `set_branches` (:890) is unchanged.
- **`src-tauri/src/ipc/mod.rs`:**
  - `worktree_preview(projectId, request)` returns the argv text and path, or a validation error.
  - `worktree_add(projectId, request)` locks `branch_locks.of(id)` (poll.rs:123), runs, upserts, then `refresh_branches`, and returns the snapshot plus the branch id. Use the `blocking` helper (:512).
  - Register both in `lib.rs:23`.
- **`src-tauri/src/settings/mod.rs:57`:** `worktrees_root` already exists. Read it via `state.read().settings`.
- **Frontend:**
  - `src/state/worktree.ts` (new): a store modelled on `src/state/launch.ts`, with a token guard.
  - `src/components/WorktreePane.tsx` (new): modelled on `LaunchPane.tsx` (focus, keys via `commands/launch.ts:201`-style helpers, `pane-error`).
  - `Pane` union `src/state/ui.ts:29` gains `"worktree"`, rendered in `src/App.tsx:138`, and `panes.ts` `leave()` resets it.
  - `src/commands/worktree.ts` (new) holds open, preview and submit.
  - `builtins.ts` adds the two commands (`canToggleBranches`, `nodes.ts:93`, for the repo check; `selectedBranch`, `navigation.ts:235`).
  - The `src/ipc/index.ts` types.
- **Tests:** in Rust, `branches.rs` test helpers `real_git`, `git_ok` and `temp_repo` (:407-425).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/git/worktree.rs`, `branches.rs` (+tests on temp repos) -- plan, validation and add -- git write path
- [x] `src-tauri/src/git/status.rs`, `poll.rs` (+tests) -- worktree excludes in the dirty count -- AC dirty count
- [x] `src-tauri/src/graph/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests incl. IPC end to end on a temp repo) -- upsert, branches on, refresh, preview -- model
- [x] `src/state/worktree.ts`, `src/components/WorktreePane.tsx`, `src/commands/worktree.ts`, `builtins.ts`, `ui.ts`, `panes.ts`, `App.tsx`, `ipc/index.ts`, CSS (+vitest) -- sheet, commands -- UI
- [x] `README.md`, `docs/DESIGN.md` -- worktrees section, sheet -- docs

**Acceptance Criteria:**
- Given a git project, when I run "New worktree" and create `auth-refresh` from `main`, then `git worktree add -b auth-refresh <root>/.worktrees/auth-refresh main` runs, a selected branch card with the worktree chip appears, and the project's dirty count is unchanged.
- Given `worktrees_root` is changed, when a worktree is created, then it goes under the new root and existing worktrees are not moved.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- **Options ride on the preview.** `worktree_preview` returns `{ branches, available, defaultBase, command, path, error }`: the sheet's selects come from the same Rust read as the plan, so no third command was added. `Err` only for an unknown project, a non-repo folder or a git that cannot run; a refusal is `error` with `command: null`; a blank new-branch name gives neither.
- **Pathspec is `:(top,exclude,literal)<rel to top>`** (see the Spec Change Log) rather than bare `:(exclude)`; `literal` so a worktree folder with glob characters matches only itself (verified on git 2.43: same result as `:(exclude)` for plain names; a stray file still shows `? .worktrees/`). Worktree folders that no longer exist are not excluded (they cannot show as untracked).
- **`status_of` lists worktrees each poll** (`git worktree list --porcelain`, one extra spawn per project per tick); a failing listing falls back to no excludes.
- **`branch.newWorktree` is also hidden on the checked-out (`*`) branch**: it has no chip but git refuses a second checkout of it.
- **`worktree_add` always calls `set_show_branches(true)`**, so a project with branches on but a collapsed card is expanded too (a no-op when on and expanded); the watch sync runs only when branches were off. After the add it also re-polls that project's status so the dirty count is right at once.
- **Base validation:** the base must be one of the local branches (`base is not a local branch: …`); names starting with `-` are refused before `check-ref-format`.
- **Selection past the limit:** when the new card is beyond the branch group's 10, the group's show-all is turned on so the selected card is drawn.

- 2026-10-20 GUI pass (orchestrator, scratch demo repo `gitdemo52` in the session scratchpad, branches off, card collapsed): palette "New worktree" opened the sheet with base `main`; typing `auth-refresh` previewed `git worktree add -b auth-refresh <repo>\.worktreesuth-refresh main`; Enter created it; branches turned on, the card expanded and `auth-refresh` was selected with chip `…/.worktrees/auth-refresh`; `workspace.json` holds the branch with its `worktreePath`; the card read `main · 0 changed` while raw `git status` shows `?? .worktrees/`; typing `main` showed `branch already exists: main` inline and nothing ran. No real repo touched.

- 2026-10-20 GUI re-run after the patch round (orchestrator, fresh scratch demo repo): same result as the first pass: preview, Create, branches on, `auth-refresh` selected with its chip, `main · 0 changed` while raw `git status` shows `?? .worktrees/`, and `branch already exists: main` inline with nothing run.

## Spec Change Log

- 2026-10-20 (review round 1, Emils' decision): the dirty-count exclusion covers every linked worktree inside the repository's **top level** (pathspecs `:(top,exclude,literal)<rel to top>`), not only those inside the project folder. Triggering finding: a project that is a subfolder of its repo gets its new worktree at `<top>/.worktrees/` and the count rose by 1 (`? ../.worktrees/`), breaking the AC. Verified in a scratch repo: top-relative excludes hide it from a subfolder project and a stray file still counts. Frozen Decisions amended. KEEP: everything else in the implementation.

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 (medium; B, E, V) Subfolder project: the dirty count counts the new worktree. Exclude every linked worktree under the top level, top-relative (Spec Change Log). Test with a subfolder project.
- P2 (medium; B, E×3) Submit not tied to the shown preview: Enter right after an edit runs the newer form while the older command is shown; after a failed preview a stale command stays with Create enabled; the fields stay editable while Create runs. Create is blocked until the latest preview has been applied (`appliedSeq`), a preview failure clears the shown command, and fields are disabled while creating.
- P3 (low; E) Switching to Existing branch before the preview lists free branches leaves `form.branch` empty while the select shows one; applying a preview picks the first free branch then.
- P4 (low; E) Existing mode with no free branch shows `pick a branch` as an alert; the preview returns options only, like a blank new name.
- P5 (low; B, E) A failure after `git worktree add` succeeded (project removed meanwhile) is reported as a refusal; once the worktree exists the reply is a success, the later failure only logged.
- P6 (low; B, E, V) README example block has a corrupted line (`\a` read as BEL) and a doubled blank line; `repo_status_with_timeout` doc says `:(exclude)`.
- P7 (low; V) No test for the add on a project with branches on and the card collapsed (expands); the relayout assertion only counts refs: also check `worktreePath` kept and position reset.

**Defer:**
- D1 (B) A stored `worktreePath` whose worktree was removed outside the app is never cleared: Story 5.4 (remove worktree, sessions follow worktrees).

**Reject:**
- (false; B) `branch.newWorktree` reads the name from the card label: a branch card's label is always the git name (`graph/mod.rs` `label: info.name.clone()`).
- (low; B, E) Windows reserved names (`con`, trailing dot): unlikely; git's own error then shows inline as the spec states.
- (low; B) Preview not shell-quoted for copy-paste: it is the command text, not a promised paste-safe line.
- (low; B) ~5 git spawns per keystroke, and one extra spawn per status poll with a silent fallback: acceptable cost, recorded in Implementation Notes; a debounce or cache adds complexity.
- (low; B) Sheet not re-focused when re-targeted while open; no DOM key tests: rare, and no component test environment (as 5.1 D2).
- (low; E) A 30 s timeout leaving a half-made worktree, and a branch read failing so the selected card is not drawn: rare; fixes add cleanup paths.
- (low; E) `~` not expanded in `worktrees_root`: refused with a clear message; the spec requires absolute.
- (E) Two same-named projects sharing a custom root collide: the chosen layout `<root>/<repo folder>/<branch>`; refused with `folder already exists`.
- (B) Spec GUI note corrupted: fixed by the orchestrator (not code).

## Design Notes

- **Verified in a scratch repo (git 2.43):**
  - A nested worktree shows as `?? .worktrees/` under `--untracked-files=normal`.
  - With one `:(exclude).worktrees/<name>` per worktree, nothing shows.
  - A stray file under `.worktrees/` still shows `?? .worktrees/`.
  - Hence per-worktree excludes, not excluding the whole root.
- **Preview from Rust.** The preview and the run go through the same `plan_add`, so the previewed text is exactly what runs.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:** orchestrator, foreground-guarded, on a scratch demo repo only:
- Create `auth-refresh` from `main` via the palette, and screenshot the preview, the card and its chip.
- Check that the dirty count stays at 0.
