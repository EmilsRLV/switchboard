# Branches & worktrees

A **branch node** is one local git branch of a project. A **worktree** is a separate checkout of a branch in
its own folder, so two sessions can work on two branches side by side. Switchboard shows each git command before it
runs it.

## Showing branches

Click the **branches** chip on a git project node, or run **Show branches** / **Hide branches**. The branch
nodes sit under the sessions with their own **show all (N)** row. **Copy branch name** copies the selected
branch's name.

## Making a worktree

**New worktree…** on a project node opens the worktree sheet in **New branch** mode: type a **Name** and pick
a **Base**. On a branch node without a worktree it opens in **Existing branch** mode with that branch picked.
The palette has **New worktree: new branch**, **New worktree: existing branch** and **New worktree: create**.

Under **Runs** the sheet shows the `git worktree add` command it will run. Enter or **Create** runs it; when
Create is blocked, the reason shows beside it. The worktree goes in `.worktrees` inside the repository,
unless the `worktrees_root` setting names another folder.

`n` (**New session…**) on a branch node opens the [launch sheet](sessions.md#the-launch-sheet) for that
branch; a branch without a worktree gets one made first, and the sheet shows that command too.

## Removing a worktree

**Remove worktree…** on a branch node with a worktree opens the remove-worktree sheet. It shows the folder,
how many files are changed or untracked, and the commands under **Runs**. **Also delete branch** is off by
default.

- A clean worktree: **Remove** (**Remove worktree: remove**).
- A worktree with changes: **Force remove…**, then **Discard N changed files and remove** (also **Remove
  worktree: force remove…** and **Remove worktree: discard changes and remove**).
- A session running in the worktree, or a locked worktree, blocks removal until you stop or unlock it.

Enter never removes: only a click, or the palette, does. A branch git refuses to delete because it is not
merged is kept, and the sheet says so.

## What you can see

A branch node shows its name, with a star for the branch checked out in the project's folder. Its second
line shows `↑n ↓m` against its upstream, `upstream gone`, and the worktree's folder, or `missing` when the
folder is gone. When branches cannot be read, the project node's path line reads `branches unavailable`.
