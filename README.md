# Switchboard (working title)

![ci](https://github.com/EmilsRLV/switchboard/actions/workflows/ci.yml/badge.svg?branch=master)

A small desktop app for Windows and Linux whose main surface is a **graph of projects, Claude Code
sessions and branches**. It starts, watches, connects and reviews Claude Code sessions. It is not a
text editor.

Status: **Epic 2 complete**. The Tauri 2 shell (Rust core, React 19 + TypeScript + Vite UI) builds
and tests on Windows and Linux (CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The home
surface is an infinite canvas whose viewport persists, holding one card per project folder with its git
state; cards expand into a column of children, every node drags and remembers where it was put, the arrow
keys walk the selection from card to card, and a right-click menu (or the palette) holds the project actions:
open the folder in the editor or file manager, reveal its Claude project directory, remove it from the canvas,
with New session and Plain terminal as stubs until Epic 4. Everything on screen follows one quiet visual
language (see [Design](#design)).

## Design

[`docs/DESIGN.md`](docs/DESIGN.md) is the visual system: the tokens in
[`src/theme/tokens.css`](src/theme/tokens.css) (surfaces, text, lines, one amber accent reserved for
attention, type scale, radii), 1-px lines, no gradients or shadows, node anatomy, status colours, motion and
the monochrome app icon (`src-tauri/icons/source.svg`, every other icon generated from it with
`npx tauri icon src-tauri/icons/source.svg`). A design lint ([`src/theme/design.test.ts`](src/theme/design.test.ts),
part of `npm test`) fails CI when a stylesheet or inline style writes a colour literal, a gradient or
shadow, a font size or radius off the tokens, or uses the accent outside the attention allow-list.

## Plans

| Document | What it holds |
|---|---|
| [`_bmad-output/planning-artifacts/product-brief.md`](_bmad-output/planning-artifacts/product-brief.md) | Problem, vision, goals, non-goals |
| [`_bmad-output/planning-artifacts/prd.md`](_bmad-output/planning-artifacts/prd.md) | Numbered requirements (`FR-*`, `NFR-*`), UX principles, open questions |
| [`_bmad-output/planning-artifacts/architecture.md`](_bmad-output/planning-artifacts/architecture.md) | Decisions (Tauri 2, terminal-first, in-app MCP, hooks for status), modules, data, launch recipe, risks |
| [`_bmad-output/planning-artifacts/epics.md`](_bmad-output/planning-artifacts/epics.md) | 9 epics / 35 stories with acceptance criteria |
| [`docs/research/claude-code-integration.md`](docs/research/claude-code-integration.md) | What was verified about Claude Code 2.1.301 and what still needs checking |

## Dev loop

Prerequisites: Rust 1.94 (MSVC toolchain on Windows), Node 24 LTS (what CI uses via `lts/*`; Node 25
runs but is outside vitest's engine range), WebView2 (ships with Windows 11).

On Linux (Ubuntu 24.04; other distros need the equivalent packages) the webview is webkit2gtk 4.1, and the
dev loop plus the AppImage/.deb bundler need:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils
```

This is the same list CI installs (`.github/workflows/ci.yml`); keep the two in step.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same loop on `ubuntu-24.04` and
`windows-latest` on every push and pull request: typecheck, vitest, `cargo test`, then `tauri build`,
uploading the bundles as the `switchboard-linux` (AppImage, .deb) and `switchboard-windows` (NSIS, MSI)
artefacts for 14 days.

```powershell
npm install              # frontend deps (pinned in package.json)
npm run tauri dev        # opens the "Switchboard" window; Vite on :1420 with HMR, cargo rebuilds on Rust changes
npm test                 # vitest: frontend stores and logic
npm run typecheck        # tsc --noEmit
cd src-tauri; cargo test # Rust modules
```

`npm run tauri build -- --debug --no-bundle` produces `src-tauri/target/debug/switchboard.exe` without
installers; plain `npm run tauri build` also bundles NSIS/MSI (Windows) or AppImage/.deb (Linux).

## Commands & keys

There is no menu bar. Every action is a command registered in `src/commands/registry.ts` (`id`, `title`,
optional `keybinding` and `when` clause, `run`); the palette, the keyboard and the pane buttons all run the
same commands. Shortcuts go through one `keydown` dispatcher (`src/commands/keybindings.ts`): a binding is
`ctrl+`/`shift+`/`alt+` plus one key, parsed at registration; a held key fires once; a command whose
`when` is false is hidden from the palette and its shortcut does nothing.

| Key | Command |
|---|---|
| `ctrl+k` | Toggle the command palette: type to filter (case-insensitive, over title and id), `↑`/`↓` to move, Enter to run, Esc to close. |
| `ctrl+o` | Add project folder: the native folder picker; the chosen folder becomes a node at the centre of the view. |
| `ctrl+,` | Open (toggle) the settings pane. |
| `ctrl+0` | Fit view: fit every node into the canvas; with no nodes, back to the home viewport (`x 0, y 0, zoom 1`). |
| `ctrl+q` | Quit. |
| `←` `→` `↑` `↓` | Move the selection to the nearest node in that direction (see [Keyboard navigation](#keyboard-navigation)); with nothing selected, select the node nearest the middle of the view. Only while no palette, pane or menu is open: those keep their own arrow handling. |
| Enter | The selected node's default action: a project with children expands or collapses (persisted); a childless project or a child card does nothing yet (sessions attach in Epic 3). Same condition as the arrows. |
| Esc | One step back, in this order: closes the node context menu, else the palette, else the open pane (settings or import), else clears the selected node. With all of them open, four presses. |

`n`, `e` and `/` are reserved for later epics and deliberately unbound; so is Delete (removal is a menu action).

The palette lists seventeen commands: Toggle command palette, Add project folder…, Import from Claude…, Open
settings, Reveal settings file (only when the file's location is known), Re-detect binaries (not while one
runs), Fit view (once the canvas has mounted; the two project commands need it too), Quit, and, while a
project card is selected, the project actions: New session…, Plain terminal…, Open in external editor, Open
in file manager, Reveal Claude project dir, Re-layout children, Remove from canvas, plus exactly one of Expand
project / Collapse project (neither for a project without children). The palette sorts by title. The key-only
carriers (the `ctrl+,` toggle, the four Esc commands, the four arrows and Enter) are registered but hidden from
the list; both panes' Close buttons run the Esc command (`pane.close`), the chevron on a card runs
Expand/Collapse, and the context menu lists the commands tagged for it in its own fixed order. Keybindings are
not editable yet (Epic 9).

The app is **single-instance** (`tauri-plugin-single-instance`): launching it again focuses and
un-minimises the running window and the second process exits. Its arguments are ignored (printed to stderr
in debug builds) until "open project from CLI" lands in Epic 2.

**Window state** (size, position, maximised) is saved on change and restored on launch by
`tauri-plugin-window-state`. The file lives in Tauri's identifier directory, not next to `settings.json`:

| OS | File |
|---|---|
| Windows | `%APPDATA%\dev.switchboard.app\.window-state.json` |
| Linux | `$XDG_CONFIG_HOME/dev.switchboard.app/.window-state.json` (default `~/.config/dev.switchboard.app/`) |

The saved position is applied only if some monitor still intersects it; otherwise the OS places the window
and only the size is restored. Delete the file to reset to the defaults in `tauri.conf.json` (1280×800).

## Workspace

The window is an infinite canvas (`@xyflow/react`, unstyled `base.css`, colours from the theme tokens) with
a dot grid and, while it has no nodes, a quiet "Add a project — ctrl+o, drop a folder, or ctrl+k" hint. Pan with the **middle** or **right**
mouse button, or hold **Space** and drag with the left; zoom with the **wheel** (0.1× to 4×; double-click
does not zoom); `ctrl+0` / palette "Fit view" fits the nodes, or with none returns to `x 0, y 0, zoom 1`.

### Adding projects

A project is a folder. Three ways to put one on the canvas, all ending in the same Rust command
(`workspace_add_projects`), which canonicalises the path, refuses duplicates and writes the file:

| Way | How | Where the node goes |
|---|---|---|
| Picker | `ctrl+o` or palette "Add project folder…" | centre of the current view |
| Drop | drag a folder from Explorer / the file manager onto the canvas | where it was dropped; several folders fan out 24 px apart |
| Import from Claude | palette "Import from Claude…" | centre of the view, fanned out |

The import pane lists every directory under `~/.claude/projects` whose working directory still exists on
this machine (the `cwd` is read from the newest transcript's first `user` record, falling back to decoding
the directory name), newest first, with its session (transcript) count. Folders already on the canvas are
ticked and disabled ("on canvas"). Tab moves between rows, Space ticks, Enter or "Add selected" adds the
ticked folders and closes the pane; Esc closes it. The app only ever **reads** `~/.claude`.

Adding a folder that is already on the canvas adds nothing: the existing node is outlined for 1.5 s.
Dropping a file (not a folder) does nothing. A folder is identified by its canonical path (case-insensitive
on Windows), so `B:\projects\ide\` and `b:\PROJECTS\ide` are the same project. **Remove from canvas** (menu or
palette) takes a node off again; nodes cannot be renamed yet.

### Selecting, dragging, expanding

A **left click** on a card selects it (a 1-px outline in the text colour; never the accent); a click on empty
canvas or Esc clears it. **Drag** any node with the left button to move it; a press that travels less than
4 px is a click and writes nothing, a real drag writes the position once, on release. A **right-button**
drag still pans from empty canvas, but not when it starts on a card (xyflow reserves presses on draggable
nodes); the middle button and Space+drag pan from anywhere, cards included. A right-button
press-and-release on a project card (again within 4 px) opens its **context menu** at the pointer, kept
inside the window, in a fixed order with a 1-px rule between the groups:

| Group | Entries | What they do |
|---|---|---|
| Sessions | New session…, Plain terminal… | Stubs until Epic 4: each shows the 3 s notice "New session arrives in Epic 4" / "Plain terminal arrives in Epic 4" and nothing else. |
| Open | Open in external editor, Open in file manager, Reveal Claude project dir | Rust performs each (the webview never spawns a process or touches the file system). The editor is the program named by the first token of `external_editor` in settings, launched detached with the project folder as its only argument (see [Settings](#settings)); the file manager opens the folder itself; the reveal opens `~/.claude/projects/<dir>` for the Claude project whose working directory is this folder (the import pane's comparison), and only if that directory already exists. The editor action is meant for GUI editors: a terminal editor such as vim starts with no window and nothing is seen. |
| Layout | Expand project or Collapse project (whichever applies, only when the project has children), Re-layout children | As before. |
| Remove | Remove from canvas | Immediate: no confirmation, no undo. The card, its children, its `sessions[]` refs and `branches`, every edge touching any of them and its live git status go; the selection is cleared if it pointed at the project or one of its children; a relaunch does not bring it back. On a read-only or newer-version `workspace.json` the removal applies in memory only, and the project comes back on relaunch. |

`↑`/`↓` move, Enter or a click runs, Esc, a click elsewhere or losing focus closes. Child cards have no menu
yet. The same commands are in the palette (by title) while a project card is selected.

An action that cannot run is a **notice**: a muted line laid over the top edge of the canvas (so it never
moves or resizes the canvas), without the accent (it is information, not attention), gone after 3 s, one at
a time with the newest winning. "No external editor configured — set external_editor in settings",
"external editor code not found on PATH", "external editor C:\Tools\code.exe does not exist",
"could not start external editor: …", "could not open folder: …", "No Claude project directory for this
folder". Only a failed removal is a banner (`remove failed: …`, like the other mutations), since the
workspace itself did not change.

### Keyboard navigation

The arrow keys move the selection over the nodes as drawn: every project card (240 × 80 at its position) and,
for an expanded project, its children (208 × 40 at their slot or dragged position); a collapsed project's
children are not candidates. From the selected node's centre, the candidates are the nodes whose centre lies
strictly in the arrow's half-plane (for `→`, further right); each is scored by its distance along the arrow's
axis plus **twice** its distance across it, and the smallest wins (an exact tie goes to the earlier node:
projects in workspace order, each followed by its children). Nothing that way leaves the selection where it
is. With nothing selected (or a selected node that is not drawn), any arrow selects the node nearest the
middle of the view. When the new node is not fully inside the canvas with a 16 px margin, the view pans by the
smallest distance that shows it, over 150 ms, without changing the zoom, and that pan is persisted like any
other. The keys are commands like everything else (`selection.move.*`, `selection.activate`), enabled only while
no palette, pane or context menu is open; xyflow's own keyboard handling is switched off (`disableKeyboardA11y`,
`nodesFocusable={false}`).

A project with children shows a **chevron** on its card: `▸ 3` while collapsed (the count is the badge),
`▾` while expanded. Clicking it, or running Expand/Collapse from the menu or palette, toggles the project
and persists `expanded`. Expanded, the children appear in a **column** under the card: 16 px in from the
card's left edge, the first 12 px under it (the card is 240 × 80, so the first child's top-left is at
`(16, 92)` relative to the card), each child 208 × 40 with 8 px gaps, in a stable order (sessions in list
order, then branches). Children move with their parent. A child **dragged** out of the column keeps that
spot, relative to the parent, across restarts; **Re-layout children** returns every child of that project
to its slot.

Children are derived by Rust from `sessions` and `branches` and carried on the snapshot as a flat
type-independent list (`children: [{ id, projectId, kind: session|branch, label, detail, position }]`,
`position: null` for a child in its slot). Until Epics 3 and 5 bring real sessions and branches there are
none, so the layout can be tried with **stub children**: set `SWITCHBOARD_STUB_CHILDREN=n` (0–50, read once at
startup) and every project gets `n` session stubs (`session 1`…`session n`, detail `stub`). A value above 50 is
clamped to 50; a blank, non-numeric or negative value means 0. Launch again without the variable and the stubs
are gone, while a project's persisted `expanded: true` lingers harmlessly (no chevron, nothing to show) until
real children arrive. Stubs themselves are never written to the file; dragging one stores a `sessions[]` entry
holding just its id, project and position, and Re-layout removes such an entry again when nothing else is in it.

### The project card

Each node is a compact card: the folder name, the shortened path (full path on hover), and a git line read
with one `git status --porcelain=v2 --branch` per project:

| Line | Meaning |
|---|---|
| `master · 3 changed` | Current branch and the number of changed entries (staged, unstaged, unmerged, untracked). A detached HEAD shows the short commit and `detached`. |
| `↑2 ↓1` | Commits ahead of / behind the upstream, shown only when either is non-zero. |
| `not a git repo` | An ordinary folder; no error, no "branches" affordance. |
| `folder missing` | The folder has gone (deleted, drive unplugged); the node stays until removed. |
| `git unavailable` | `git` could not be started (not installed, wrong path); the settings banner explains the usual cause. |
| `git error` | `git` ran but failed (for example a `safe.directory` refusal); hover for its message. A `git status` that times out keeps the card's previous line. |
| `…` | Not polled yet. |

Git repos also show an inert "branches" affordance (Epic 5) and the card reserves a live-session badge,
hidden while the count is 0 (Epic 3). Git status is **live state**: it is never written to disk. A poller
on Tauri's async runtime refreshes every project every `poll.git_ms` (default 5 s, re-read from settings
each tick, floor 250 ms) and right after an add, running `git` off the UI thread with a 5 s timeout and
`GIT_OPTIONAL_LOCKS=0` so it never blocks a `git` you are running yourself. The binary is the one detection
found (or `git.path` from settings), else `git` on PATH. Only the changes are pushed to the UI
(`projects://status`).

### The file

What the canvas shows is persisted in one app-written JSON file beside `settings.json`:

| OS | File |
|---|---|
| Windows | `%APPDATA%\switchboard\workspace.json` |
| Linux | `$XDG_CONFIG_HOME/switchboard/workspace.json` (default `~/.config/switchboard/workspace.json`) |

The file is written on first launch, when it does not exist (`version: 1`, the home viewport, empty
`projects`, `branches`, `sessions`, `edges` and null launch `defaults`), when a project is added, expanded,
collapsed, re-laid-out or removed, at the end of every node drag, and atomically (temp file + rename) at the end of
every pan or zoom that moved the viewport by more than 0.5 px or 0.001 zoom, so a relaunch opens exactly
where you left off with the same nodes at the same positions. Loading an existing file never rewrites it.
Each project is `{ id (UUID v4), path (canonical), label, position, expanded, color, launchDefaults }`;
`sessions[]` holds `{ sessionId, projectId, branchId, label, pinned, position }` (a child's `position` is
relative to its parent card and `null` in its slot), `branches[].position` likewise; `edges` is reserved
for Epic 6. A `sessions[]` entry whose session is no longer a child (a stub from a higher count, a
hand-edited id) is kept verbatim and never pruned by this story; only Re-layout touches refs, and only
those of the project it was run on. Rust owns the file: the UI never writes it, it mirrors Rust's snapshot (`workspace_get`, then
every `workspace://changed` event) just as it does for settings, and every snapshot carries a revision so a
reply that arrives after a newer one is dropped. A stored zoom is clamped to the canvas limits.

The file is not meant for hand editing and is not watched, but it is read tolerantly: missing keys take
their defaults, unknown keys are ignored, a UTF-8 BOM is fine, an older `version` is upgraded silently, a
viewport the canvas cannot show (zoom outside 0.1–4) is reset to the home view with a banner. Problems are
banners, never a crash:

| Banner | Cause | What happens |
|---|---|---|
| `workspace.json:line:col …` | Broken JSON | Defaults in memory; the file is left alone until the next write replaces it. |
| cannot read workspace: … | The file exists but cannot be read | Defaults in memory; changes are kept in memory and **not saved** this session (the file may well be valid). |
| workspace.json is version N … | A `version` newer than this build | Loaded as-is; changes are kept in memory and **not saved**, so a v1 write cannot drop the newer fields. |
| workspace.json had N projects with an empty or duplicate id | Hand-edited `projects` | Those entries are dropped (the first of a duplicate is kept); the rest load. |
| cannot write workspace: … | The write failed (no config dir, permissions) | The change lives in memory; the next write is tried again. |
| project add failed: … | Adding a folder failed (picker, IPC) | Nothing added; the banner clears on the next successful add. |
| node move failed / expand failed / collapse failed / re-layout failed / remove failed: … | Rust rejected the change (an id it does not know, no runtime) | Nothing changes; a dropped node goes back to its stored position; the banner clears on the next successful change. |

## Settings

One human-editable JSON file, written with every key present on first launch and never rewritten after
that. There is no settings form: `ctrl+,` opens a read-only pane (Esc closes) showing the file path with a
"Reveal file" button, the detected binaries with a "Re-detect" button, and the effective values; edit the
file itself.

| OS | File |
|---|---|
| Windows | `%APPDATA%\switchboard\settings.json` |
| Linux | `$XDG_CONFIG_HOME/switchboard/settings.json` (default `~/.config/switchboard/settings.json`) |

The location is `dirs::config_dir()/switchboard`, so it also resolves on macOS
(`~/Library/Application Support/switchboard/settings.json`), though macOS is not a target and untested.

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | Schema version. |
| `claude.path` | detected path, else `null` | Claude Code binary. Filled on first launch from the search below; when set, detection is skipped and the path is used as is (a banner says so if it does not exist). `null` re-detects on every launch. |
| `git.path` | `null` | `git` binary. `null` means search PATH on every launch. |
| `defaults.model` | `null` | Launch-sheet default model (`null` leaves it to `claude`). |
| `defaults.effort` | `null` | Launch-sheet default effort. |
| `defaults.permission_mode` | `"default"` | Launch-sheet default permission mode. |
| `worktrees_root` | `null` | Root for app-managed worktrees; `null` means `<repo>/.worktrees/`. |
| `external_editor` | `"code -g {file}:{line}"` when `code` is on PATH, else `null` | Command template for "open in editor". The `{file}`/`{line}` form is for Epic 7's file opens; "Open in external editor" on a project card runs only the **first token** with the project folder as its single argument. A path with spaces must be quoted (`"C:\Program Files\…\code.cmd" -g {file}:{line}`). A bare name is resolved like binary detection (PATH, with `PATHEXT` on Windows, so `code` finds `code.cmd`); a path (or `~/…`) is used as given. A `.cmd`/`.bat` runs through `cmd.exe` without a console window; the child is detached, never waited on. `null` makes the action a notice. |
| `shell` | Windows: `"pwsh"` if present, else `"powershell"`; Linux: `$SHELL` (`null` when unset) | Shell for plain terminals. |
| `theme` | `"dark"` | UI theme. Reserved; not applied yet (the UI is dark-only). |
| `poll.agents_ms` | `2000` | `claude agents --json` poll interval. |
| `poll.git_ms` | `5000` | Git status poll interval. |

Binary detection: `claude` is searched on PATH, then `~/.local/bin`; `git` on PATH. Each one found is run
with `--version` (5 s timeout) and its version recorded. A configured `*.path` may be absolute, start with
`~/`, or be a bare name (then it is looked up on PATH). Problems are non-blocking banners at the top of the
window, never a crash: `claude` missing (banner lists the searched directories), a configured path that does
not exist, or a `--version` that fails.

The file is watched: save it and the app reloads within a second, no restart (if the watcher cannot start, a
banner says so and edits apply on the next launch). Missing keys take their defaults and unknown keys are
ignored; a UTF-8 BOM is tolerated. Broken JSON shows a banner with `settings.json:line:col` and the parse
message while the last good settings stay in force; fixing the file clears the banner. A `version` newer
than this build understands, or a poll interval of `0` (replaced by its default), is reported as a banner.

Layout follows [`architecture.md` §8](_bmad-output/planning-artifacts/architecture.md): `src/` is the React
app (`ipc/` is the only place Rust is called, `commands/` the command registry, dispatcher and built-in
commands, `state/` holds Zustand stores, `canvas/` the xyflow canvas, `theme/` the CSS variables),
`src-tauri/` the Rust core (`src/ipc/` holds the thin Tauri commands, `src/settings/` the settings file and
binary detection, `src/graph/` the workspace model and `workspace.json`, `src/git/` the status parser and
poller (the only module that runs `git`), `src/claude/` read-only discovery of Claude Code's project
directories, `src/process.rs` running a child with a timeout, `src/persist.rs` the shared atomic JSON
read/write; other modules arrive with their stories).

Stories are specced one at a time into `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`
in the same shape as `map-maker`'s specs (Intent / Boundaries / I-O matrix / Code Map / Tasks).
