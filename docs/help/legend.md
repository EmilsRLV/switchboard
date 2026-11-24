# What you see

What the words, colours and lines on the canvas mean. Hover a node, a badge or an edge line for what it
means.

## Session states

```figure session-states
A session node steps through starting, busy (a pulsing dot), waiting, busy, finished, idle and exited.
While it is waiting or finished, its state word and border take the attention colour and its project node
glows.
```

```table session-states
The session states and what each means.
```

A session not seen this run shows no state: it is a past session.

## Agent nodes

An **agent node** is another coding agent (Kimi Code, Qwen Code, …) started from the launch sheet. It reads
`running`, then `exited (<code>)`, then its **agent chip**: the agent's name. A running agent counts in
`N live`; one that exits while you are not looking takes the attention colour until you select it.
**Show terminal**, **Stop**, and once exited **Restart** (same tab) and **Remove** are on its menu. It has no
history or edges and is forgotten on restart.

## Groups

A **group frame** is a thin line around a group's projects, label top-left; a colour shows as its left
rule. A **group card** is a collapsed group: label, `N projects`, summed `N live`, and the glow.

## Colour, glow and badges

- The **attention colour** marks what needs you: a `finished` or `waiting` session (its state word and
  border), an agent node that exited unseen, a failed edge and an approval toast. Selecting it marks it seen.
- A project node **glows** while one of its nodes needs you; hover it to see which one. `ctrl+j` (**Go
  to session that needs you**) selects the session that has waited longest.
- `N live` on a project node counts its running sessions and agents. While it is collapsed, the number by its
  chevron counts its children.
- On a session node, `N new` counts unread peer messages and **review** means Claude asks for a look;
  click it to open the [Review pane](review.md).
- `elsewhere N` at the bottom left is the Elsewhere tray: live sessions in folders off the canvas.

## Edges

```figure edge-kinds
Five edges: context (dashed), cooperate (double), pending (muted), failed (attention colour), selected.
```

```table edge-looks
The edge looks and what each means.
```

Hover an edge line for what it is doing now, in the [edge inspector](edges.md#the-edge-inspector)'s words.
