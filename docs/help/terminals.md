# Terminals, tabs & pop-outs

The terminal pane on the right shows the terminals Switchboard runs: one for each session it started, and a
**plain terminal** per project, a shell in the project's folder. Every terminal you open or show gets a tab.

## Opening and moving between terminals

- A started, resumed or forked session opens the terminal pane on its tab. **Show terminal** on a session
  node brings it back.
- **Plain terminal…** on a project node opens its shell, or shows it when it is already running.
- `` ctrl+` `` (**Toggle terminal**) hides the pane or shows the last terminal again.
- `ctrl+pagedown` and `ctrl+pageup` (**Next terminal tab**, **Previous terminal tab**) step through the tabs.
- While the pane is open, selecting a node that has a terminal switches to its tab; the focus stays on the
  canvas.
- Drag the pane's left edge to make it wider or narrower; the width is remembered.

A tab's **×** only takes the tab away: the program keeps running, and the node or the palette brings it back.

## Pop-outs

**Pop out terminal**, or **Pop out** in the pane, moves a terminal into its own window. Its tab then reads
**In its own window**, with **Focus window** and **Return to pane** (also **Focus terminal window** and
**Return terminal to pane**). Closing the window returns the terminal to the pane.

## Keys and the clipboard

Inside a terminal, keys belong to the program, `esc` and `f1` included. Only `` ctrl+` ``,
`ctrl+shift+k` (the command palette), `ctrl+pageup` and `ctrl+pagedown` still reach Switchboard; see
[Keys in a terminal](keyboard.md#keys-in-a-terminal). ctrl+shift+c copies the selection and ctrl+shift+v
pastes; plain ctrl+c stays the program's.

## What you can see

Each tab shows its title (the project name for a plain terminal, the session name for a session) and a
muted state: the session's state, or `running`, `stopping` or `exited` with its exit code. A dot in the
attention colour marks a session that is `finished` or `waiting`.

- **Kill** (**Kill terminal**) ends a running terminal; its output stays.
- **Restart** (**Restart terminal**) starts an exited plain terminal again in place. A session terminal is
  never restarted: use **Resume** on its session node.
- **Close** (**Close terminal**) forgets an exited session's terminal.
- **Hide** puts the pane away, like `` ctrl+` ``.
