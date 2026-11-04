# Projects

A **project node** is one folder on the canvas. Its session nodes and, with branches on, its branch nodes
hang under it as a column. Removing one never touches the folder.

## Adding a folder

- `ctrl+o` (**Add project folder…**) opens the folder picker; the folder lands in the view's centre.
- Drop folders from the file manager.
- **Import from Claude…** in the command palette opens the import pane: every folder Claude Code has run in
  that still exists, newest first, with its session count. Tick folders with Space or a click, then press
  `enter` or **Add selected** (also **Import: add selected**). Folders already on the canvas show `on canvas`.

Adding a folder already there adds nothing; its project node flashes instead.

## Working with a project node

Select a project node and press `enter`, or click its chevron, to expand or collapse it. Hovered or selected, it
shows a **toolbar** of what it can run. Right-click it for its menu, or use the palette:

- **New session…** (`n`) opens the [launch sheet](sessions.md#the-launch-sheet); **Plain terminal…** opens
  a [plain terminal](terminals.md) in the folder.
- **Review changes** (`r`) opens the [Review pane](review.md) on its changes.
- **Link to…** (`e`) and **Select edge…** work with [edges](edges.md).
- **Show branches** / **Hide branches** and **New worktree…**: see [Branches & worktrees](branches.md).
- **Open in external editor**, **Open in file manager**, **Reveal Claude project dir**.
- **Re-layout children** tidies the column; **Show all sessions** lifts the ten-row limit.
- **Remove from canvas** takes the node, its column and its edges off, with no undo. It
  also ends its terminals and the sessions in them; its other live sessions move to the
  Elsewhere tray.

## What you can see

```figure node-anatomy
A project node: on top, the chevron with the child count (while collapsed), the folder name and N live;
then the path; then the git line and the branches chip. The handle is on the right edge.
```

- `N live` counts running sessions; hover the shortened path for all of it.
- The git line: `main · 3 changed`, `↑1 ↓2` against the upstream, or `not a git repo`, `folder missing`,
  `git unavailable` or `git error`.
- A glow in the attention colour while one of its sessions is `finished` or `waiting`.

The Elsewhere tray (`elsewhere N`) lists live sessions in folders not on the canvas; **Add folder** adds one.
