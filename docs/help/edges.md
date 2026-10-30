# Edges

An edge joins two nodes and tells Claude something about the other end. There are two kinds, and Switchboard
picks the kind from the two ends:

- A **context edge** (a dashed line) runs from a session node or a project node to a project node or a
  branch node. It gives the session the target's folder as an extra folder (`--add-dir`). From a project
  node, every new session in that project gets it.
- A **cooperate edge** (a double line) joins two session nodes. Each session is told about the other and
  they can message each other (see [Peer messages](tool.md#peer-messages)). It grants no folder.

## Drawing and finding edges

- Drag from a node's **handle**, the small dot on its right edge, onto another node. A branch node can be a
  target but has no handle.
- Or select a node and press `e` (**Link to…**), then pick the target.
- **Select edge…** lists the selected node's edges; picking one selects it. Clicking a line selects it too.
- `delete` (**Delete edge**) removes the selected edge at once. It takes no folder back
  from a running session.

## The edge inspector

Selecting an edge opens the edge inspector (or press `enter`, or run **Inspect edge**). It shows the kind,
the two ends, a **Label** field ("What the link is for") and what the edge is doing **Now:**. Its buttons:

- **Retry** (**Retry edge**) sends the folder, or the peer line, again after a failure.
- **Restart with flags** stops the session and resumes it with all its context edges' folders.
- **Delete** removes the edge.
- With **Always for this edge** set: **Agent actions: always allowed** and **Revoke** (see
  [Approvals](tool.md#approvals)).

## What you can see

A context edge from a session running here is applied live: once the session is idle and you are not typing
in it, Switchboard types `/add-dir` with the folder.

- `pending`: waiting for the session to go idle, or held back while you type (Retry when done); drawn muted.
- `applied`: Claude has the folder.
- `notified`: a cooperate side took the peer line.
- `failed`: not confirmed, or the folder is missing; drawn in the attention colour.

A session that is not running gets its context edges at the next **Resume**, and its peers at the next start.
An edge with a hidden end is not drawn but stays.
