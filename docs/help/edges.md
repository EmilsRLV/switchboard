# Edges

An edge joins two nodes and tells Claude about the other end. Its kind follows from the two ends:

- A **context edge** runs from a session or project node to a project or branch node. It gives the session the target's folder (`--add-dir`). From a project
  node, every new session there gets it.
- A **cooperate edge** joins two session nodes. The two are told about each other and
  can message (see [Peer messages](tool.md#peer-messages)). It grants no folder.

## Drawing and finding edges

```figure draw-edge
A hovered session node shows its handle, a small dot on its right edge. A line dragged from it onto a
project node becomes a dashed context edge; onto a session node, a cooperate edge's double line.
```

- Drag from a node's **handle** onto another node. A branch node can be a target but has no handle.
- Or press `e` (**Link to…**) on a selected node and pick the target.
- **Select edge…** lists the selected node's edges; clicking a line selects it too.
- `delete` (**Delete edge**) removes the selected edge at once; a running session keeps
  the folder.

## The edge inspector

Selecting an edge opens the edge inspector (or press `enter`, or run **Inspect edge**). It shows the kind,
the two ends, a **Label** field and what the edge is doing **Now:**. Its buttons:

- **Retry** (**Retry edge**) sends the folder, or the peer line, again after a failure.
- **Restart with flags** stops the session and resumes it with its context edges' folders.
- **Delete** removes the edge.
- With **Always for this edge** set: **Agent actions: always allowed** and **Revoke** (see
  [Approvals](tool.md#approvals)).

## What you can see

```figure edge-kinds
Five edges: context (dashed), cooperate (double), pending (muted), failed (attention colour), selected.
```

A context edge from a session running here is applied live: once it is idle and you are not typing in it,
Switchboard types `/add-dir` with the folder.

- `pending`: waiting for the session to go idle, or held back while you type (Retry when done).
- `applied`: Claude has the folder.
- `notified`: a cooperate side took the peer line.
- `failed`: not confirmed, or the folder is missing.

A session that is not running gets its context edges at the next **Resume**, and its peers at the next start.
An edge with a hidden end is not drawn but stays.
