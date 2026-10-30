# Sessions & launch sheet

A **session node** is one Claude Code session in a project's folder: the ones Switchboard starts, and the
ones it finds that Claude ran before or runs elsewhere. Sessions started here run in a terminal pane.

## The launch sheet

Select a project node or a branch node and press `n` (**New session…**) to open the launch sheet:

- **Name**, prefilled and selected, so typing replaces it.
- **Model**, **Effort** and **Permission mode**; `default` leaves the choice to Claude. The sheet
  remembers the last choices per project.
- On a git project, **Let Claude make a worktree** with its **Worktree name**.
- **Add-dirs**: extra folders the session may read. Rows marked `via edge → …` come from
  [context edges](edges.md); **Add folder…** (also **New session: add folder…**) picks another.
- **First prompt (optional)** and **Start in background**.

Enter in a field, or **Start** (also **New session: start**), starts the session; ctrl+Enter starts from the
prompt box too. When Start is blocked, the reason shows beside it. Once started, the session node appears
selected and the terminal pane opens on it, unless it started in the background.

## Commands on a session node

Right-click a session node, or use the command palette:

- **Resume** reopens a session that is not running, with the same id.
- **Fork** starts a copy of the conversation as a new session node, joined to the original by a thin line.
- **Show terminal** opens the terminal pane on it; **Stop** ends a session running here (a second **Stop**
  ends it at once). Sessions started outside Switchboard are never stopped.
- **Review changes** (`r`) opens the [Review pane](review.md) on its folder.

## What you can see

The first line is the session's title, then `N new` for unread peer messages and **review** when Claude asks
for a review. The second line starts with its state:

- `starting`, `busy` (with a pulsing dot), `idle`, `stopping`, `exited`;
- `finished` (it went from busy to idle) or `waiting` (Claude needs an answer): these take the attention
  colour and make the project node glow. Selecting the session marks it seen.

Then come the branch, the message count and the age. `ctrl+j` (**Go to session that needs you**) selects the
session that has waited longest. Live sessions in folders not on the canvas wait in the Elsewhere tray.
