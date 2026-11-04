# What you see

What the words, colours and lines on the canvas mean. Hover a session node, a badge or an edge line and
its tooltip tells its state and what it means.

## Session states

```figure session-states
A session node steps through starting, busy (a pulsing dot), waiting, busy, finished, idle and exited.
While it is waiting or finished, its state word and border take the attention colour and its project node
glows.
```

```table session-states
The session states and what each means.
```

A session the poll has not seen this run shows no state: it is a past session, kept as a transcript.

## Colour, glow and badges

- The **attention colour** marks what needs you: a `finished` or `waiting` session (its state word and
  border), a failed edge and an approval toast. Selecting the session marks it seen.
- A project node **glows** while one of its sessions needs you; hover it to see which one. `ctrl+j` (**Go
  to session that needs you**) selects the one that has waited longest.
- `N live` on a project node counts its running sessions. While it is collapsed, the number by its
  chevron counts its children.
- On a session node, `N new` counts unread peer messages and **review** means Claude asks you to look at
  its work; click it to open the [Review pane](review.md).
- `elsewhere N` at the bottom left is the Elsewhere tray: live sessions in folders not on the canvas;
  **Add folder** adds one.

## Edges

```figure edge-kinds
Five edges: context (dashed), cooperate (double), pending (muted), failed (attention colour), selected.
```

```table edge-looks
The edge looks and what each means.
```

Hover an edge line for what it is doing now, in the [edge inspector](edges.md#the-edge-inspector)'s words.
