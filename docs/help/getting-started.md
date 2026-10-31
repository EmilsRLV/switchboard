# Getting started

Getting started is a list of six first moves in Switchboard. Each one ticks itself off when you really do
it, whichever way you do it: a key, the [command palette](keyboard.md#the-command-palette), a node's menu or
the mouse. Your progress is kept across restarts.

## The six steps

1. **Open the command palette.** Press `ctrl+k`; `esc` closes it again.
2. **Add a project.** Press `ctrl+o` and pick a folder, or drop a folder onto the canvas. See
   [Projects](projects.md).
3. **Start a session.** Select a project node and press `n` for the
   [launch sheet](sessions.md#the-launch-sheet), then Start. The step ticks once the session is running
   (`busy`, `idle`, `waiting` or `finished`); `starting` alone does not count.
4. **Open a plain terminal.** Right-click a project node and choose **Plain terminal…**. See
   [Terminals, tabs & pop-outs](terminals.md).
5. **Link two nodes.** Select a session or project node and press `e` (**Link to…**), or drag from its
   handle onto another node. See [Edges](edges.md).
6. **Review changes.** Select a node and press `r` to open the [Review pane](review.md) on its changes.

A step stays ticked once done, even after the palette closes or the edge is deleted.

## The card

On a fresh profile the list shows as the **Getting started card** at the top right of the canvas, under
any notice. A step you can do right now is a button that does it; the others are plain text. A ticked step
shows a muted ✓. When all six are done the card reads `All done` and is gone at the next launch.
**Dismiss** (or **Dismiss getting started** in the palette) keeps it away, across restarts, until you show
it again.

## Here in Help

Below, the same list shows your progress. **Show on canvas** (or **Show getting started** in the palette)
brings the card back. **Help: getting started** opens this page.
