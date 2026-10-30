# Settings & diagnostics

Switchboard keeps its settings in `settings.json`, with `workspace.json` and `keybindings.json` beside it, in
its config folder: `%APPDATA%\switchboard` on Windows, `$XDG_CONFIG_HOME/switchboard` (usually
`~/.config/switchboard`) on Linux. You change settings by editing the file; the settings pane only shows them.

## Opening and editing

- `ctrl+,` opens and closes the settings pane; **Open settings** does the same from the command palette.
- **Reveal settings file** (or **Reveal file** in the pane) shows the file in the file manager.
- Save the file and the change applies at once, with no restart. Missing keys take their defaults and unknown
  keys are ignored. A file that does not parse keeps the last good settings, and a banner names the line.

Settings you are likely to change: `claude.path` and `git.path`, the launch sheet's `defaults`,
`worktrees_root` (where [worktrees](branches.md) go), `external_editor` (used by **Open in editor** and
**Open in external editor**, such as `code -g {file}:{line}`), `shell` (the plain terminal), the
`notifications` switches, and `peers.nudge`.

## The settings pane

- **File**: where the file is.
- **Binaries**: the `claude` and `git` Switchboard found, with their versions, or `not found`. **Re-detect**
  (also **Re-detect binaries**) looks again.
- **Agent actions**: whether Claude's acts ask first or are allowed (see [Approvals](tool.md#approvals)).
- **Effective settings**: every setting as it applies now.
- **Diagnostics**, below.

## Diagnostics

Diagnostics refreshes every two seconds while the pane is open:

- the local endpoint sessions report to, and counts of events received and requests refused;
- **Recent MCP refusals**, when there are any;
- **Performance**: start-up time, typing delay and the memory target;
- **Keybindings**: whether `keybindings.json` loaded, with each error, warning and conflict on its own line.
  See [Changing keys](keyboard.md#changing-keys).

A row that needs you is highlighted. When `claude` cannot be found, a banner across the top says where
Switchboard looked; the canvas still works.

## Quitting

`ctrl+q` (**Quit**) closes Switchboard. Every terminal it runs ends with it, sessions included. With
`close_to_tray` on, closing the window only hides it until you quit.
