# Roadmap

What may come to Switchboard, what it cannot do well yet, and what it will not do. Nothing here is a promise
or a date.

## Next

- **Reading peer messages:** a way to see the text one session sent another. Today it reaches only the
  receiving session.
- **Resume and fork as the session ran:** use the session's own model and permission mode. Today they use the
  project's last launch sheet choices.
- **Pop-outs that remember where they were:** a pop-out window opening at its last size and place. Today it
  opens at the default size.
- **Folders as edge targets:** a context edge to any folder, not only to a project node or a branch node.
- **Following a cleared session:** after `/clear`, the session node follows the session to its new id.
- **Attach in terminal:** show a session that was started elsewhere in the terminal pane.

## Later

- **Several workspaces:** switch between saved canvases.
- **Cost and tokens:** a total per session, read from its history.
- **Remote branches:** see them, and fetch, pull and push from a branch node.
- **Stage and commit** from the Review pane.
- **Automatic updates.**
- **Searching the help** from the command palette.
- **The help for Claude:** sessions read these pages through Switchboard's tool server.
- **Cloud sessions:** start a session in the cloud, and attach to one driven by remote control.
- **A chat view:** a structured view of a session as an alternative to its terminal.
- **macOS:** a build for the Mac.

## Known limitations

- **Adding a folder to a running session:** Switchboard types `/add-dir` into the session, and Claude Code
  does not always confirm it. You see a context edge stay `pending` or turn `failed`; **Restart with flags**
  always works.
- **Messages between sessions by name:** whether sessions reach each other with Claude Code's own messaging
  is not yet confirmed. You see the peer line suggest it; Switchboard's own peer messages always work.
- **A false finished:** when your own Claude Code stop hook keeps a turn going, the session can still show
  `finished` and send a notification while Claude carries on.
- **After `/clear`:** the session node keeps the old session, so its state stops changing.
- **Memory with full scrollback:** with many sessions each holding a full scrollback, Switchboard uses more
  memory than its target. Fewer open sessions, or a shorter scrollback, keep it under.
- **Typing delay:** most keys reach the terminal within the target, but the slowest few take a little longer.
- **Attach in terminal** on a session started elsewhere only shows a notice for now.
- **Notifications on Windows:** one clicked later from the notification centre may not reach Switchboard.
  `ctrl+j` finds the session.
- **Tray on Linux:** the icon reports no clicks and shows no tooltip; use its menu.
- **Linux checks still owed:** the recent versions have not been tried by hand on Linux, including the tray,
  minimizing on close and the start-up time.
- **Unsigned installers:** Windows warns before installing.

## Not planned

- Editing files: Switchboard shows files and opens them in your own editor.
- Code intelligence and debugging.
- Agents other than Claude Code.
- Testing on macOS for each release (a Mac build is under Later).
- Remote and cloud sessions beyond what Later lists.
- Several people sharing one workspace.
- A marketplace or plugins for Switchboard itself.
- Redrawing Claude Code's own chat screen: the terminal shows it as it is.
