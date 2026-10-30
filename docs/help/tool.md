# The app as a tool for Claude

Every session Switchboard starts (a new session, **Resume**, **Fork**) is connected to Switchboard's own tool
server, named `switchboard`. It runs on this machine only, and each session can reach it only with its own
token, which dies with the session. Sessions started outside Switchboard are not connected.

## What Claude can do

- **Look:** `my_node`, `workspace`, `node`, `peers` and `sessions` read the canvas. They never ask you.
- **Report:** `set_status` puts a short status line on the session node; `request_review` asks you to look
  at its work (see [Review requests](#review-requests)).
- **Act:** `start_session`, `link` and `unlink` start a session in another project or on a branch node, draw
  an edge, or delete one. These wait for your answer.

## Approvals

An act shows a toast at the bottom right: *name* wants to *action*, the exact command or edge under it, and
**Allow**, **Deny** and, when a stored edge joins the session and its target, **Always for this edge**.
Unanswered, it reads `denied in N s` and is denied after two minutes. From the command palette, **Allow
agent request**, **Deny agent request** and **Always allow agent request (this edge)** answer the oldest one.

**Always for this edge** lets every later act from that session on that target run without asking; a notice
says what ran. The edge inspector then shows **Agent actions: always allowed** with **Revoke** (in the
palette, **Revoke agent policy**). **Agent actions: allow all** skips asking for the whole workspace;
**Agent actions: ask** turns that off. The settings pane shows which is on.

## Peer messages

Two sessions joined by a [cooperate edge](edges.md) can message each other with `send` and read with `inbox`.
The receiving session node shows a muted `N new` after its title until the session reads its inbox. When the
receiver sits idle with an empty prompt, Switchboard types one line telling it to read its messages.

## Review requests

`request_review` puts a **review** button on the session node and a toast: *name* asks for review, with
**Open** and **Dismiss**. **Open**, the button, or **Open review request** opens the [Review pane](review.md)
on that session. **Dismiss** removes the toast but keeps the button; **Clear review flag** lowers it.
