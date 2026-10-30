# Canvas & navigation

The canvas is Switchboard's home screen: an endless dotted surface with one **project node** per folder you
added. Under an expanded project node sits a column of its children: a **session node** for each Claude
session found for that folder and, with branches on, a **branch node** for each local git branch.

## Adding projects

Press `ctrl+o` to pick a folder, drop a folder from the file manager onto the canvas, or run **Import from
Claude…** from the [command palette](keyboard.md#the-command-palette) to add folders Claude already knows.

## Moving around

- Pan by dragging with the middle or right mouse button, or hold Space and drag with the left button. A
  right-drag pans; a right-click without moving opens a node's menu.
- Zoom with the mouse wheel. `ctrl+0` (**Fit view**) brings every node into view.
- Drag a node to move it; a project node's children move with it. **Re-layout children** puts a column back
  in order.

## Selecting and acting

Click a node, or use the arrow keys, to select it; `esc` clears the selection. `enter` on a project node
expands or collapses it. Right-click a project, session or branch node, without moving the mouse, for its menu;
every entry there is also in the command palette. With a project node selected, `n` opens the [launch sheet](sessions.md#the-launch-sheet) for a new session, and `r`
opens the [Review pane](review.md) on its changes.

When a column holds more than ten children, its last row reads **show all (N)**; click it or press `enter`
on it to see the rest.

## Edges

Each project and session node has a **handle** on its right edge. Drag from it onto another node to draw an
[edge](edges.md), or press `e` (**Link to…**) and pick the target. A **context edge** (dashed) gives a session another
folder; a **cooperate edge** (a double line) lets two sessions message each other. Click an edge to select it;
`delete` removes it.

## What you can see

A session node starts its second line with its state: `busy` with a pulsing dot, `idle`, `exited`. A session
that is `finished` or `waiting` needs you: its border and state word take the attention colour, and its project
node glows. `ctrl+j` goes to the session that has needed you longest.
