# Epic 5 Context: Branches and worktrees

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make git branches part of the graph. An expanded git project lists its local branches with current, ahead/behind and worktree state. The operator can create a worktree for an existing or new branch from the canvas, start a session in it, and remove it safely. Sessions discovered in a worktree's folder land under that branch, not under the project root. Parallel sessions then get their own checkouts, and the canvas matches what is on disk. Remote branches and fetch/pull/push are out of scope (deferred).

## Stories

- Story 5.1: Branch children
- Story 5.2: Create a worktree node
- Story 5.3: Session on a branch
- Story 5.4: Sessions follow worktrees; remove worktree

## Requirements & Constraints

- **Branch list** (git projects only, shown when the project's "branches" toggle is on): name, `*` for current, `↑n ↓m` against the upstream when one exists, and a worktree chip with the path when `git worktree list --porcelain` reports one. When `.git/refs` or `.git/packed-refs` changes, the list refreshes within 2 s. Non-git folders keep working with sessions only and no branch children.
- **New worktree:** pick an existing branch, or a new one from a base. The command is `git worktree add [-b <new>] <root>/<name> <base>`. The root defaults to `<repo>/.worktrees/`, and the `worktrees_root` setting already exists (`null` means the default). Changing the setting affects only new worktrees; existing ones are not moved. The new worktree's path must not count toward the project's dirty count.
- **Session on a branch:** if the branch has a worktree, the launch sheet opens with cwd set to the worktree path, and the node appears under the branch. If it has none, the sheet offers "Create worktree here (recommended)" or "Let Claude manage it". The second runs `claude --worktree <name>` from the repo root, and the node is matched later by the transcript's `cwd`. App-managed worktrees are the default so that the app owns the node-to-path mapping, but sessions launched with `--worktree` must still be recognised.
- **Remove worktree:** a clean worktree is removed with `git worktree remove` after confirmation, and the node loses its chip. A dirty worktree is refused, the dirty file count is shown, and a "force" option is offered. The requirements also list a "delete branch" option that no story AC covers yet.
- **Confirmation policy** (these commands change the user's repo):
  - `worktree add`: creates a folder and, with `-b`, a branch. The explicit sheet submit is enough; show the exact command/path before running it.
  - `worktree remove`: needs confirmation.
  - `worktree remove --force`: discards uncommitted work. Needs a separate, explicit confirmation that states the file count.
  - Branch delete, if added: `-d` needs confirmation, and `-D` is destructive and needs explicit confirmation.
  - `claude --worktree`: Claude creates the worktree. The operator's choice in the sheet is the consent.
  - Never run any of these without operator action. Agent-initiated starts on branches (Epic 7) go through approval.
- **Unchanged constraints:** nothing is written under `~/.claude`. No network calls, so no fetch: ahead/behind uses the last-known upstream refs. Both the Windows and the Linux CI runners stay green. Rust owns the state: branch nodes the operator creates are persisted in `workspace.json` and broadcast on `workspace://changed`. Discovered branch lists are cached in memory only.

## Technical Decisions

- **Git CLI only** (`src-tauri/src/git/`). Add typed wrappers next to the status poller: `for-each-ref refs/heads` (`%(refname:short)`, `%(HEAD)`, `%(upstream:short)`, `%(upstream:track)`, `%(worktreepath)`), `worktree list --porcelain`, `worktree add`, and `worktree remove [-f]`. Installed git is **2.43.0.windows.1**. Available worktree subcommands: `add [-f] [--detach] [--checkout] [--lock] [--orphan] [-b|-B]`, `list [-v | --porcelain [-z]]`, `lock`, `move`, `prune [-n]`, `remove [-f]`, `repair`, `unlock`. `--porcelain` records include `worktree`, `HEAD`, `branch`, `detached`, `bare`, `locked`, `prunable`. Use `-z` if paths may contain newlines. Use the resolved `git_binary(settings)` and the existing timeout pattern.
- **Data model:** `BranchNode { id, project_id, name, worktree_path, position }` already exists, but nothing creates one yet. The architecture says persisted branches are "only ones the operator placed or created". Story 5.1 lists every local branch, so the derived list is discovery (in memory), and it is merged with persisted nodes by `(project_id, name)`.
- **Already in place for worktree mapping:** `branch_for_cwd` (the deepest `worktreePath` holding the cwd wins), `project_for_cwd` (which falls back to a branch's worktree), and `ChildNode.branch_id`. Story 5.4's discovery rule mostly needs real `worktree_path` values, including worktrees found by `worktree list` that the operator did not create.
- **Fs watch:** the `notify` crate is already a dependency, used by the settings watcher. Watch the repo's *common* git dir (`git rev-parse --git-common-dir`): `refs/heads`, `packed-refs`, `HEAD`, and `worktrees/`. Debounce it, and keep a poll fallback.
- **Launch:** the Story 4.2 launch path gains a cwd override (the worktree path) and an optional `--worktree <name>` flag, with argv run from the repo root. Resume already uses the transcript cwd.
- **Paths:** compare paths with the existing canonical/`same_path` helpers, which handle Windows drive case and separators. Branch names with `/` become nested folders, so sanitise or flatten them. Windows can refuse a remove while a terminal or process has its cwd in the worktree.

## UX & Interaction Patterns

- The project card's "branches" chip stops being inert and toggles branch children. The `↑n ↓m` style already used on the status line can be reused per branch.
- Branch children use the existing 208×40 branch-stub card: the label, plus a muted mono detail (the worktree path or chip). `*` and `↑n ↓m` must fit in that row. The accent stays limited to `waiting`/`finished`. New CSS must pass the design lint's accent allow-list.
- Commands go into the registry with `when` clauses and node menu orders. That covers "New worktree" (project and branch), `n` on a branch node (launch sheet), and "Remove worktree". Everything must be reachable from the palette. Sheets and panes slide in from the right.
- Remove/force is the app's **first confirmation UI**. `project.remove` has no confirm, so there is no existing pattern to reuse. Keep it low-chrome and state exactly what will run.

## Cross-Story Dependencies

- 5.1 (discovery and refresh) underlies 5.2–5.4. 5.2's new node must merge with 5.1's discovered entry, not duplicate it.
- 5.3 needs 5.2 for "Create worktree here" and Epic 4's launch sheet and PTY. 5.4's attach-by-cwd also matches 5.3's `--worktree` sessions.
- Later epics: Epic 6 context edges target branch nodes (`NodeRef` type `branch`). Epic 7 `start_session({branch})` reuses 5.3's launch path. Epic 8's review pane diffs a branch against its base.

## Open decisions

1. **Children layout.** *Resolved by Story 5.1 (spec-5-1-branch-children):* one column per project, the sessions then the branches as two groups, each with its own limit of 10 and its own `show all (N)` row; the branches toggle is saved per project (`Project.showBranches`); branch ids are stable (`<projectId>:<name>`) and the UI keys flow nodes by id, not index. Nesting sessions under branches is Story 5.4's. Original question: Children currently sit in one column per project, with session children first and then branches, SHOW_LIMIT 10, keyed by list index. Decide whether sessions on a branch nest in a sub-column under the branch node or stay in the project column grouped or tagged by branch. Also decide whether the branches toggle is persisted per project. Index keys will shift when branches appear or disappear.
2. **Which branches get persisted.** *Resolved by Story 5.1:* only branches the operator moved (or, from 5.2, created); discovered branches stay in memory, and a stored one whose branch is gone is pruned unless an edge or a session references it. Original question: Choose between persisting all discovered branches, only created or moved ones, or only branches with a worktree.
3. **Keeping `.worktrees/` out of the dirty count.** Options: filter the path in the porcelain parse, pass `:(exclude)` pathspecs, or append to `.git/info/exclude`. The last one writes to the user's repo, and editing `.gitignore` is not the app's call.
4. **Default base for a new branch.** The story example uses `main`. Decide between the repo's default branch and the current HEAD.
5. **Folder layout for a custom `worktrees_root`.** For example `<root>/<repo>/<branch>`, to avoid collisions across projects. Also decide how branch names containing `/` are mapped to folder names.
6. **Where `claude --worktree` puts its worktree.** This has not been verified, and it should be checked read-only without running `claude`. Also decide how a node shows before the transcript arrives.
7. **"Delete branch" (FR-BRANCH-4).** It is in the requirements but in no story AC. Decide whether it is in scope.
8. **Edge cases:** prunable or missing worktree folders, locked worktrees, a detached HEAD in a worktree, and a remove attempted while a live session runs in that worktree. Decide whether to block or warn.
