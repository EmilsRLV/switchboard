# Projects

A **project node** is one folder on the canvas. Its session nodes and, with branches on, its branch nodes
hang under it as a column. Removing a project node never touches the folder itself.

## Adding a folder

- `ctrl+o` (**Add project folder…**) opens the folder picker; the folder lands in the middle of the view.
- Drop folders from the file manager onto the canvas.
- **Import from Claude…** in the command palette opens the import pane: every folder Claude Code has run in
  that still exists, newest first, with its session count. Tick folders with Space or a click, then press
  `enter` or **Add selected** (also **Import: add selected**). Folders already on the canvas show `on canvas`.

Adding a folder that is already there adds nothing; the existing project node flashes instead.

## Working with a project node

Select a project node and press `enter`, or click its chevron, to expand or collapse it. Right-click it for
its menu, or use the same titles in the command palette:

- **New session…** (`n`) opens the [launch sheet](sessions.md#the-launch-sheet); **Plain terminal…** opens
  a [plain terminal](terminals.md) in the folder.
- **Review changes** (`r`) opens the [Review pane](review.md) on the folder's changes.
- **Link to…** (`e`) and **Select edge…** work with [edges](edges.md).
- **Show branches** / **Hide branches** and **New worktree…**: see [Branches & worktrees](branches.md).
- **Open in external editor**, **Open in file manager**, **Reveal Claude project dir**.
- **Re-layout children** tidies the column; **Show all sessions** lifts the ten-row limit.
- **Remove from canvas** takes the project node, its column and its edges off the canvas, with no undo. It
  also ends that project's terminals and the sessions running in them; its other live sessions move to the
  Elsewhere tray.

## What you can see

- The top line: the folder name, `N live` when sessions are running, and, while collapsed, how many children
  it holds.
- The second line: the path, shortened; hover for all of it.
- The third line: the git state, such as `main · 3 changed`, with `↑1 ↓2` against its upstream, or
  `not a git repo`, `folder missing`, `git unavailable` or `git error`.
- A glow in the attention colour while one of its sessions is `finished` or `waiting`.

The Elsewhere tray (`elsewhere N`) lists live sessions in folders not on the canvas; **Add folder** adds one.
