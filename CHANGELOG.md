# Changelog

What changed in Switchboard, newest first. Each release lists what you can see and do, grouped by area.

## Unreleased

### Help

- A Help pane of short guide pages, one per area, written in the words the app itself uses. `f1` opens and
  closes it, and **Help** in the command palette opens it.
- Help opens on the page for where you are: the pane that is open, or the node or edge that is selected, else
  the page you last read. Closing it brings back the pane it covered.
- **Help: open page…** jumps to any page and **Help: contents** returns to the list. Links between pages
  work inside the pane; a web link opens in your browser only when you click it.
- The Keyboard & palette page ends with every command and the key it has now, your own keys included.
- A Getting started list of six first moves that tick themselves off as you do them, however you do them. On
  a fresh profile it shows as a card at the top right of the canvas; **Dismiss** keeps it away, and **Show on
  canvas** brings it back.
- The empty canvas hint now ends with `f1` for help.
- This changelog and the roadmap, readable in Help (**Help: changelog**, **Help: roadmap**). Contents shows
  the running version and the config folder.

## 0.1.0 — 2026-10-31

The first version: the canvas, sessions, terminals, branches, edges, review and the tool server for Claude,
on Windows and Linux.

### Canvas

- An endless canvas that is the home screen. Pan by dragging with the middle or right mouse button, or with
  Space and the left button; zoom with the wheel. The view is where you left it at the next launch.
- `ctrl+0` (**Fit view**) brings every node into view.
- Drag any node to place it; it stays there across restarts. A project node's children move with it, and
  **Re-layout children** puts a column back in order.
- Select with a click or the arrow keys, which move to the nearest node in that direction. `esc` clears the
  selection.
- Right-click a project, session or branch node for its menu. Every entry is also in the command palette.
- A column shows ten children; **show all (N)** shows the rest and **show fewer** folds them again.
- A session that is `finished` or `waiting` takes the attention colour, and its project node glows, even while
  collapsed. Selecting the session marks it seen.
- `ctrl+j` (**Go to session that needs you**) goes to the session that has waited longest.
- The empty canvas says how to add a first project.
- One quiet look throughout: dark, thin lines, no shadows, and one colour kept for what needs you.

### Projects

- Add a folder as a project node with `ctrl+o`, by dropping folders onto the canvas, or with **Import from
  Claude…**, which lists every folder Claude Code has run in that still exists, with its session count.
- Adding a folder that is already there flashes the existing node instead of adding another.
- A project node shows the folder name, its path, `N live` while sessions run, and its git state: the branch,
  the changed-file count, and how far it is ahead of or behind its upstream.
- A folder that is not a git repository, a missing folder or a missing git each show as a plain muted line,
  never an error.
- Expand or collapse with `enter` or the chevron; a collapsed node counts its children.
- **Open in external editor**, **Open in file manager** and **Reveal Claude project dir** on every project node.
- **Remove from canvas** takes a project node off the canvas without touching the folder.
- Live sessions in folders that are not on the canvas wait in the Elsewhere tray at the bottom left, where
  **Add folder** adds their folder.

### Sessions

- Every project node lists its past Claude Code sessions with title, branch, message count and age.
- Running sessions show their state, `busy`, `idle` or `exited`, within seconds, including sessions started
  in another terminal.
- `waiting` (Claude needs an answer) and `finished` (its turn ended) arrive within about a second for sessions
  Switchboard started.
- An optional system notification when a session needs you while the window is in the background; clicking it
  goes to the session.
- `n` (**New session…**) opens the launch sheet: name, model, effort, permission mode, extra folders, a first
  prompt, and starting in the background. It remembers your last choices per project.
- A new session appears at once as `starting` and opens in the terminal pane.
- **Resume** reopens a past session with the same id; **Fork** copies it into a new session node, joined to the
  original by a thin line.
- **Stop** ends a session running in Switchboard; a second **Stop** ends it at once. Sessions started elsewhere
  are never stopped.
- A session can post a short status line that shows on its node, and asks for review with a **review** flag.
- Unread peer messages show as `N new` after the session's title.

### Terminals

- A terminal pane on the right runs the real Claude Code screen unchanged, with full colour, paste and a long
  scrollback.
- **Plain terminal…** opens a shell in a project's folder, one per project.
- Every terminal gets a tab. `ctrl+pageup` and `ctrl+pagedown` step through them, and selecting a node with a
  terminal switches to its tab.
- `` ctrl+` `` hides the terminal pane or shows the last terminal again. Hidden terminals keep all their output.
- **Pop out terminal** moves a terminal into its own window; closing the window returns it to the pane.
- Drag the pane's left edge to resize it; the width is remembered.
- **Kill**, **Restart** (plain terminals) and **Close** on a terminal's header.
- Inside a terminal, keys belong to the program. `ctrl+shift+k` still opens the command palette.

### Branches and worktrees

- The **branches** chip on a git project node shows its local branches as branch nodes, with the checked-out
  one starred, ahead and behind counts, and the worktree folder.
- The branch list follows changes on disk within a couple of seconds.
- **New worktree…** opens the worktree sheet for a new branch or an existing one, and shows the git command
  before it runs.
- `n` on a branch node starts a session in that branch's worktree, making the worktree first when there is none.
- The launch sheet can also let Claude make its own worktree.
- Sessions that ran in a worktree are listed under its branch node.
- **Remove worktree…** shows what would be lost first. A worktree with changes needs two separate clicks, and
  a running session or a locked worktree blocks the removal.
- **Copy branch name** copies the selected branch's name.

### Edges

- Drag from a node's handle onto another node, or press `e` (**Link to…**), to draw an edge. Switchboard picks
  the kind from the two ends.
- A context edge (dashed) gives a session another project's or branch's folder. From a project node, every new
  session in that project gets it, and the launch sheet shows where each folder came from.
- A context edge added to a running session is applied once the session is idle, and shows `pending`,
  `applied` or `failed`. **Retry** and **Restart with flags** are in the edge inspector.
- A cooperate edge (a double line) joins two sessions: each is told about the other and they can message each
  other.
- The edge inspector shows the kind, the two ends, what the edge is doing now and a **Label** field.
- `delete` removes the selected edge. Edges are kept across restarts.

### The app as a tool for Claude

- Every session Switchboard starts can reach Switchboard's own tool server on this machine, with its own token.
- Claude can read the canvas: where it is, the projects, their sessions, its peers.
- Claude can start a session, draw an edge or delete one, but only after you answer its toast: **Allow**,
  **Deny** or **Always for this edge**. Unanswered requests are denied after two minutes.
- **Revoke** in the edge inspector takes an always-allow back; **Agent actions: allow all** and **Agent
  actions: ask** set the whole workspace.
- Sessions joined by a cooperate edge send each other messages. An idle receiver is told to read them.
- Claude can ask you for a review: the session node shows **review** and a toast offers **Open** and
  **Dismiss**.

### Review

- `r` (**Review changes**) opens the Review pane on a project's, branch's or session's folder.
- **Changes** shows uncommitted changes as a file tree with line counts, filtered **All**, **Staged** or
  **Unstaged**, in a side-by-side or unified diff with syntax colours and the changed words marked.
- **vs base** shows what a branch changed since it left its base; **Commits** lists its commits and shows each
  one.
- **Files** browses every file of the folder, read-only, with ignored files dimmed.
- `j` and `k` step through the files; `o` opens the file at the current line in your editor.
- On a session, a dot marks the files that session edited.
- `c` comments on a diff line and sends it to the session, with its state shown: `queued`, `sent`, `read` or
  `dropped`.
- A review request opens with its summary on top and the requested files first.

### Settings and platform

- Installers for Windows and packages for Linux.
- Settings live in one file you edit by hand; saved changes apply at once. A file that does not parse keeps
  the last good settings and a banner names the line.
- `ctrl+,` opens the settings pane, which shows where the file is, the `claude` and git it found, and every
  setting as it applies now.
- A banner says where Switchboard looked when `claude` cannot be found; the canvas still works.
- Diagnostics in the settings pane: the local endpoint, refused requests, start-up time, typing delay, the
  memory target and any key problems.
- Starting Switchboard again brings the running window forward. The window reopens at its last size and place.
- A tray icon counts busy and waiting sessions. With closing to the tray on, closing the window keeps sessions
  running.
- Hidden terminals and an idle window give memory back.
- `ctrl+q` quits, ending every terminal Switchboard runs.

### Keyboard

- Everything Switchboard does is a command, and every command is in the command palette (`ctrl+k`), listed
  only when it makes sense.
- Buttons, menus and keys run the same commands, so anything you can click you can also type.
- Any command can have your own key, or lose its key, in the keybindings file in the config folder. It reloads
  when you save it, and Diagnostics lists errors and conflicts.
