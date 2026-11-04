# Sessions & launch sheet

A **session node** is one Claude Code session in a project's folder: ones Switchboard starts, and ones
Claude ran before or runs elsewhere. Sessions started here run in a terminal pane.

## The launch sheet

Select a project or branch node and press `n` (**New session…**) to open the launch sheet:

- **Name**, prefilled and selected.
- **Model**, **Effort** and **Permission mode**; `default` leaves the choice to Claude. The sheet
  keeps each project's last choices.
- On a git project, **Let Claude make a worktree** with its **Worktree name**.
- **Add-dirs**: extra folders the session may read. Rows marked `via edge → …` come from
  [context edges](edges.md); **Add folder…** (also **New session: add folder…**) picks another.
- **First prompt (optional)** and **Start in background**.

Enter in a field, or **Start** (also **New session: start**), starts the session; ctrl+Enter starts from the
prompt box. A blocked Start shows its reason beside it. Once started, the node is
selected and the terminal pane opens on it, unless started in the background.

## Commands on a session node

Right-click a session node, or use the palette:

- **Resume** reopens a stopped session with the same id.
- **Fork** copies the conversation into a new session node, joined to the original by a thin line.
- **Show terminal** opens the terminal pane on it; **Stop** ends a session running here (a second **Stop**
  ends it at once). Sessions started outside Switchboard are never stopped.
- **Review changes** (`r`) opens the [Review pane](review.md) on its folder.

Hovered or selected, the node shows a **toolbar** of what it can run.

## What you can see

```figure session-states
A session node steps through starting, busy (a pulsing dot), waiting, busy, finished, idle and exited.
While it is waiting or finished, its state word and border take the attention colour and its project node
glows.
```

The first line is the session's title, then `N new` for unread peer messages and **review** when Claude asks
for one. The second line: its state, then branch, message count and age:

- `starting`, `busy`, `idle`, `stopping`, `exited`;
- `finished` (it went from busy to idle) or `waiting` (Claude needs an answer). Selecting the session marks
  it seen.

`ctrl+j` (**Go to session that needs you**) selects the session that has waited longest. Live sessions in
folders not on the canvas wait in the Elsewhere tray.
