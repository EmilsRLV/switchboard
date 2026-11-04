# Getting started

Getting started is a list of six first moves in Switchboard. Each ticks itself off when you do it, any
way: a key, the [command palette](keyboard.md#the-command-palette), a node's menu or the mouse. Progress
is kept across restarts.

## The six steps

1. **Open the command palette.** Press `ctrl+k`; `esc` closes it again.
2. **Add a project.** Press `ctrl+o` and pick a folder, or drop one onto the canvas
   ([Projects](projects.md)).
3. **Start a session.** Select a project node and press `n` for the
   [launch sheet](sessions.md#the-launch-sheet), then Start. It ticks once the session runs; `starting`
   alone does not count.
4. **Open a plain terminal.** Right-click a project node, then **Plain terminal…**
   ([Terminals](terminals.md)).
5. **Link two nodes.** Select a session or project node and press `e`, or drag from its handle onto
   another node ([Edges](edges.md)).
6. **Review changes.** Select a node and press `r` to open the [Review pane](review.md) on its changes.

A step stays ticked, even once the palette closes or the edge goes.

## The tour

On a fresh profile a six-stop tour starts once, before the card, dimming all but what it points at.
`right` or `enter` goes on, `left` back, `esc` skips; `ctrl+k` still opens the palette over it. Nothing
under the dim takes a click. **Take the tour** or the button below runs it again; the card links to it until taken.

## The card

On a fresh profile the list shows as the **Getting started card** at the top right of the canvas. A step
you can do now is a button that does it. A ticked step shows a muted ✓; with all six done the card reads
`All done` and is gone at the next launch. **Dismiss** keeps it away, across restarts, until you show it
again.
While the card shows, hints by the first project and live session name the next key until its step is
done. **Hide canvas hints** and **Show canvas hints** turn them off and on, card or not.

## Here in Help

Below, the same list shows your progress. **Show on canvas** (or **Show getting started**) brings the card
back. **Help: getting started** opens this page.

## After an update

After Switchboard's version changes, a muted `new in <version>` chip shows at the bottom left of the canvas
until the Changelog is opened. Click it, or choose **What's new** in the palette, to read the
[Changelog](CHANGELOG.md).
