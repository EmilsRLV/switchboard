# Review

The Review pane shows what changed in a folder, side by side with the canvas. Select a project node, a
branch node or a session node and press `r` (**Review changes**). A project reviews its folder, a branch its
worktree (without one, it opens on **vs base**), a session the folder it runs in.

## Modes

The toolbar switches modes, also from the palette:

- **Changes** (**Review: changes**): uncommitted changes, filtered **All**, **Staged** or **Unstaged**
  (**Review: all changes**, **Review: staged changes**, **Review: unstaged changes**).
- **vs base** (**Review: vs base**): what the branch changed since it left its base, picked under **base**.
- **Commits** (**Review: commits**): the branch's commits beyond the base; click one to see its files, and
  **← Commits** (**Review: back to commits**) to go back.
- **Files** (**Review: files**): every file of the folder, read-only.

A session offers Changes and Files only. **Side by side** and **Unified** switch the diff layout
(**Review: unified view** or **Review: side-by-side view**).

## Moving and acting

- `j` and `k` (**Review: next file**, **Review: previous file**) step through the files.
- `o` (**Open in editor**) opens the file at the line you are on, with the `external_editor` setting. Without
  it, a notice says so and the settings pane opens.
- `c` (**Comment on line**), on a session only, opens a box for a comment on that line; ctrl+Enter sends it
  to the session, which gets it at its next idle moment. Each comment shows `queued`, `sent`, `read` or
  `dropped`.
- **Refresh** (**Review: refresh**) reads the changes again; Changes also follows the git status by itself.
- Drag the pane's left edge to resize it.

## Review requests

When Claude asks for a review, its session node shows **review** and a toast appears (see
[Review requests](tool.md#review-requests)). Opening it puts the summary on top and the requested files first.

## What you can see

Each file row shows a letter (M modified, A added, D deleted, R renamed, U untracked, C conflicted) and its
added and removed line counts; on a session, a dot marks the files that session edited. A quiet folder reads
**No changes**; messages such as `not a git repository`, `folder missing` or `no worktree` explain why there
is nothing to show.
