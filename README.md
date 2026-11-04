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
open a plain terminal in it (see [Terminal](#terminal)), or start a Claude session in it (see
[Starting sessions](#starting-sessions)). Expanded, a project lists its Claude Code
sessions, past and running: a running session shows `busy` or `idle` and the card counts it in its `N live`
badge; sessions running in folders not on the canvas wait in the Elsewhere tray. A session that just finished
its turn turns the accent and makes its project glow until it is selected, with an optional OS toast while the
window is in the background (see [Needs you](#needs-you)). Everything on screen follows one quiet visual
language (see [Design](#design)).

## Install

There are no releases yet: installers come from CI. Open a green run of
[`ci.yml`](https://github.com/EmilsRLV/switchboard/actions/workflows/ci.yml) on `master` and download its
artefact: `switchboard-windows` (NSIS `.exe` and `.msi`) or `switchboard-linux` (`.AppImage` and `.deb`).
Artefacts are kept for **7 days**; after that, push or re-run the workflow to get fresh ones. With no CI
artefact at hand, build the installers yourself: follow [Dev loop](#dev-loop) and run `npm run tauri build`
(the bundles land in `src-tauri/target/release/bundle/`). The installers are not code-signed, so Windows
SmartScreen may warn before the first run ("More info" → "Run anyway"). Nothing auto-updates: install a newer
build over the old one.

**Windows 11 x64.**

- **NSIS (`Switchboard_<version>_x64-setup.exe`), recommended.** A per-user install under
  `%LOCALAPPDATA%\Switchboard`; no admin rights needed. Uninstall from Settings → Apps → Switchboard.
  Running the same version's installer again may ask whether to reinstall or uninstall first.
- **MSI (`Switchboard_<version>_x64_en-US.msi`).** The Windows Installer package, for machines managed that
  way; it installs per machine and asks for admin rights. Uninstall from Settings → Apps → Switchboard. To
  install the same version again, uninstall the old one first.
- **Pick one.** NSIS and MSI install to different places, so installing both gives two separate
  Switchboard installs (two Start-menu entries, two uninstall entries); uninstall one.
- **WebView2.** Both installers carry the small WebView2 bootstrapper and install the runtime only when it is
  missing (that needs a network connection). Windows 11 already has it.
- **`claude` must be the native `claude.exe`** (Claude Code's native installer). The npm package installs a
  `claude.cmd` shim that Switchboard will not run; with only the shim, the app says so in a banner (see
  [Starting sessions](#starting-sessions)). `git` for Windows is optional but needed for branches and review.

**Linux x64** (X11 or Wayland).

- **`.deb` (Debian, Ubuntu 24.04 and derivatives).** `sudo apt install ./<the downloaded .deb>` (the
  leading `./` makes apt treat it as a file) pulls in the runtime packages: `libwebkit2gtk-4.1-0`,
  `libgtk-3-0`, `xdg-utils` (used to open folders and the editor) and `libayatana-appindicator3-1` (the tray
  icon, see [Tray and closing the window](#tray-and-closing-the-window)). Uninstall with
  `sudo apt remove switchboard`.
- **AppImage (any distro).** `chmod +x` the downloaded `.AppImage`, then run it. It bundles the webview; the
  system still needs `xdg-utils` for "open folder" and FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04)
  to mount the image. Uninstall by deleting the file.
- `claude` is looked up on PATH, then in `~/.local/bin` (where the native installer puts it). `git` is
  looked up on PATH.

**Where things live.** Settings and the canvas are two JSON files, both written on first launch, beside
`state.json`, the app's own small state (the Getting started checklist's progress and whether its card was
dismissed, the last version whose changes you have seen, whether the canvas hints are hidden or shown
(`hints.hidden`), and whether the first-run tour was taken (`tour.done`); never hand-edited, and deleting it
resets only the checklist, the seen version, the hints setting and the tour (which starts on its own only on
a fresh profile); on an existing profile that brings the `new in <version>` chip back once):

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\switchboard\` (`settings.json`, `workspace.json`, `state.json`) |
| Linux | `$XDG_CONFIG_HOME/switchboard/` (default `~/.config/switchboard/`) |

Uninstalling leaves them in place; delete the folder for a truly clean start. Switchboard reads Claude Code's
own files under `~/.claude` but never writes there; a machine where Claude Code never ran simply shows no
sessions.

### Clean-machine checklist

For checking an installed build by hand, on a machine (or user profile) that has never run Switchboard:

1. Install as above and start Switchboard from the Start menu or the app launcher. The window opens on an
   empty canvas with the dashed ghost card `Drop a folder here` at its centre and, under it, `ctrl+o pick a
   folder · ctrl+k palette · f1 help` (a click on it opens the folder picker), the Getting started card at its
   top-right, and no wizard or modal. After a project is added, a muted hint under it reads `n new session ·
   hover for more`.
2. `settings.json`, `workspace.json` and `state.json` now exist in the folder above; `settings.json` has `claude.path` filled in when `claude` was
   found.
3. With native `claude` installed: no banner, and `ctrl+,` shows `claude` with its version. Without it: the
   banner `claude not found — searched: …` lists the directories searched, and the canvas still works. On
   Windows with only the npm package: the banner `<path>\claude.cmd (npm shim) found — install the native
   claude.exe`, and starting a session fails with the same text.
4. Without `git`: the `git not found — searched: …` banner, and the canvas still works.
5. Without `~/.claude` (Claude Code never run): no error banner, no sessions under projects, and no
   `~/.claude` folder appears.
6. `ctrl+o` adds a folder; expanding the card lists its sessions. `n` on it starts a session in a terminal
   (needs the native `claude`).
7. Quit with `ctrl+q`, start again: the project and viewport are where you left them.
8. Uninstall; the app is gone and the config folder is left as documented.

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
| [`_bmad-output/planning-artifacts/epics.md`](_bmad-output/planning-artifacts/epics.md) | 10 epics / 44 stories with acceptance criteria |
| [`docs/research/claude-code-integration.md`](docs/research/claude-code-integration.md) | What was verified about Claude Code 2.1.301 and what still needs checking |

What changed and what is coming, in plain words: [`CHANGELOG.md`](CHANGELOG.md) (newest first, `## Unreleased`
on top, each release grouped by area) and [`ROADMAP.md`](ROADMAP.md) (Next, Later, Known limitations, Not planned). Both are bundled into the app:
Help → Contents → **Changelog** / **Roadmap**, or **Help: changelog** / **Help: roadmap** in the palette. Contents
ends with `Switchboard <version>` and the config folder. A test (`src/help/version.test.ts`) fails when
`package.json`, `src-tauri/Cargo.toml` and the newest released `CHANGELOG.md` heading disagree, so a version bump
needs its changelog entry; new work goes under `## Unreleased` until then.

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
artefacts for 7 days.

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
| `ctrl+q` | Quit: stops every session and terminal, even with `close_to_tray` on (see [Tray and closing the window](#tray-and-closing-the-window)). |
| `n` | New session…: with a project selected, open the launch sheet (see [Starting sessions](#starting-sessions)); with a branch card selected, the sheet aimed at that branch (see [Sessions on a branch](#sessions-on-a-branch)); on a session it does nothing. Not while focus is in a text field or a select, nor while the context menu is open. |
| ``ctrl+` `` | Toggle terminal: hide the terminal pane, or show it again with the last terminal focused. Works with focus in the terminal too. |
| `ctrl+shift+k` | The palette's second binding: the same toggle as `ctrl+k`, and the one that still works with focus in a terminal (where `ctrl+k` is the shell's). |
| `ctrl+pageup` / `ctrl+pagedown` | Previous / next terminal tab, wrapping around (see [Tabs and pop-outs](#tabs-and-pop-outs)). Only while the terminal pane shows two tabs or more; works with focus in the terminal too. |
| `ctrl+j` | Go to session that needs you: the session that has been `finished` (or `waiting`) longest is revealed and selected, its project expanded first when collapsed (see [Needs you](#needs-you)). Enabled only while a session on a canvas project needs you; press again for the next one. |
| `←` `→` `↑` `↓` | Move the selection to the nearest node in that direction (see [Keyboard navigation](#keyboard-navigation)); with nothing selected, select the node nearest the middle of the view. Only while no palette, pane, menu or Elsewhere list is open: those keep their own arrow handling. |
| Enter | The selected node's default action (with an edge selected, it opens the edge inspector): a project with children expands or collapses (persisted); a `show all (N)` / `show fewer` row toggles the column (see [Sessions](#sessions)); a childless project or a child card does nothing (Resume, Fork and Stop are menu and palette commands; see [Resume, fork, stop](#resume-fork-stop)). Same condition as the arrows. |
| `e` | Link to…: with a session or project card selected, the palette becomes a pick list of the nodes it can be linked to; Enter draws the edge, Esc cancels (see [Edges](#edges)). Also in the node menu and the palette. Not while focus is in a text field or a select, nor while the context menu is open. |
| `r` | Review changes: with a project, branch or session card selected, open the Review pane on its working tree (see [Review](#review)). Also in the node menu and the palette. Only while no palette, pane, menu or Elsewhere list is open, and not while focus is in a text field or a select. |
| `j` / `k` | Next / previous file in the Review pane's tree (the requested files first). Only while the Review pane is open, and not in a text field. |
| `o` | Open in editor: the Review pane's selected file in the external editor, at the line under the cursor (see [Open in editor](#open-in-editor)). Only while the Review pane is open, not in a text field and not while the context menu is open. Also in the palette. |
| `c` | Comment on line: on a session's Review pane showing a file, open the comment box at the current line (see [Line comments](#line-comments)); ctrl+Enter in the box sends, Esc cancels. Not in a text field and not while the context menu is open. Also in the palette. |
| Delete | Delete edge: only while an edge is selected (a click on its line), deletes it at once, no confirmation (see [Edges](#edges)). With no edge selected Delete does nothing; in a text field it is the field's. |
| Esc | One step back, in this order: closes the node context menu, else the Elsewhere list, else the palette, else the open pane (settings, import, terminal, the launch sheet, the worktree sheet, the remove-worktree sheet, the edge inspector or the Review pane), else clears the selected node or edge. With all of them open, five presses. With focus in a terminal Esc is the terminal's (see [Terminal](#terminal)). With focus in the Review pane's comment box, Esc closes only the box (see [Line comments](#line-comments)); with the focus elsewhere it does the above. |

`/` is reserved for a later epic and deliberately unbound. Delete is bound only to deleting a selected edge;
removing a project stays a menu action.

The palette lists up to seventy-nine commands, each only while its `when` holds: Toggle command palette, Add project folder…, Import from Claude…, Open
settings, Reveal settings file (only when the file's location is known), Re-detect binaries (not while one
runs), Fit view (once the canvas has mounted; the two project commands need it too), Quit, Toggle Elsewhere
sessions (only while the Elsewhere tray has rows), Go to session that needs you (only while one does),
Resume, Fork and Stop (for the selected session card, each when it applies; see
[Resume, fork, stop](#resume-fork-stop)), Show terminal (only while a session Switchboard started is selected; see
[Starting sessions](#starting-sessions)), Attach in terminal (only while a live session card started elsewhere
is selected; see [Live sessions](#live-sessions)), Toggle terminal (only while there is a terminal; see
[Terminal](#terminal)), Kill terminal (only while the pane's terminal runs), Restart terminal (only once a plain terminal has
exited), Close terminal (only once a session terminal has exited), Pop out terminal (only while the pane's
terminal is not in its own window yet), Next / Previous terminal tab (only while the pane shows two tabs or
more; see [Tabs and pop-outs](#tabs-and-pop-outs)), and, while a
project card is selected, the project actions: New session…, Plain terminal…, New worktree… (git repos only; see
[Worktrees](#worktrees)), Open in external editor, Open
in file manager, Reveal Claude project dir, Re-layout children, Remove from canvas, plus exactly one of Expand
project / Collapse project (neither for a project without children), Show all sessions (only for an
expanded project with more than ten sessions) and, for a git repo, Show branches / Hide branches (see
[Branches](#branches)); while a branch card is selected, Copy branch name and, for a branch with no worktree
that is not checked out in the project's folder, New worktree…, New session… (unless its worktree is `missing`), and, for a
branch with a worktree chip (a `missing` one too), Remove worktree… (see [Removing a worktree](#removing-a-worktree));
Link to… while a session or project card is selected, Select edge… while the selected card has a drawn
edge, and Delete edge and Inspect edge while an edge is selected (Inspect edge only while its inspector is closed; see [Edges](#edges));
Restart with flags while a context edge from a session is selected, and Retry edge while that edge failed or
a draft holds it back, and Retry edge while a selected cooperate edge has a side that failed or that a draft
holds back (see [Context edges on live sessions](#context-edges-on-live-sessions) and [Cooperation
edges](#cooperation-edges)); Open review request while any session has a review request, and Clear review
flag while a session is flagged (see [Review requests](#review-requests-request_review)); Review changes while a
project, branch or session card is selected and, while the Review pane is open, Review: refresh, Review: all /
staged / unstaged changes, Review: unified view (or side-by-side view), Review: next / previous file, Open in
editor, Review: files (where the pane has a folder), Comment on line (a session showing a file) and, on a project or
branch, Review: changes / vs base / commits (see [Review](#review)). Story 9.4 adds the pane buttons that had no
command: New session: start / add folder… (the launch sheet), New worktree: new branch / existing branch / create,
Remove worktree: remove / force remove… / discard changes and remove (the second step only once Force remove…
was pressed and its delay passed), Import: add selected, Return terminal to pane and Focus terminal window (a
popped-out tab), Review: back to commits, Dismiss review toast (the oldest) and Always allow agent request (this
edge) (the oldest request, where it offers it). The palette sorts by title. The key-only
carriers (the `ctrl+,` toggle, the palette's second binding `ctrl+shift+k`, the five Esc commands, the four
arrows and Enter) are registered but hidden from
the list, as are the Review pane's two layout buttons (`review.layoutSplit` / `review.layoutUnified`; the palette
has Review: unified view / side-by-side view, and the two have no default key, so they are reachable from the
keyboard only once bound in `keybindings.json`); every pane's Close button runs the Esc command (`pane.close`), the chevron on a card runs
Expand/Collapse, and the context menu lists the commands tagged for it in its own fixed order.

### keybindings.json

Every command can be bound, rebound or unbound in `keybindings.json`, beside `settings.json` in the config
directory (`%APPDATA%\switchboard\keybindings.json` on Windows, `$XDG_CONFIG_HOME/switchboard/keybindings.json`
on Linux). It is optional; without it the defaults above apply. It reloads live, like `settings.json`:

```json
{
  "review.refresh": "ctrl+shift+r",
  "attention.next": null,
  "terminal.toggle": "ctrl+shift+t"
}
```

Each key is a command id, each value a binding in the form above (`ctrl+`/`shift+`/`alt+` plus one key; no chords
or sequences) or `null` to remove the command's key. An unknown id or a binding that does not parse is an error and
is skipped (that command keeps its default); the other entries apply. A file that is not a JSON object, or cannot be
read, is an error and changes nothing (the bindings from the last good file stay). The palette shows the effective
keys. **Settings → Diagnostics → Keybindings** shows the file's status (`none`, `ok` or `n errors`), each error
(`unknown command nope`, `bad key "ctrl+" for review.refresh`, `terminal.toggle needs ctrl, alt or shift`,
`ctrl+shift+c is the terminal's copy`), each warning (unbinding `palette.toggle`, `palette.toggleFromTerminal` or a
key-only command such as `pane.close` leaves it out of reach; `live reload unavailable: …` when the file cannot
be watched) and each conflict: two or more commands on one key where at least one of those bindings came from the
file (`ctrl+k: palette.toggle, review.refresh`; of those enabled at the time, the first by title runs), or a
command moved onto the terminal's copy / paste keys (`ctrl+shift+c: review.refresh, terminal copy`: in a terminal
the key stays the terminal's). Keys are written as in this file (`escape`, `arrowup`). The status reads `ok, 1
conflict` while there are conflicts. An id no command has is an error until one registers under it, when its entry
applies. The defaults' own shared keys (Esc, `n`) are told apart by their `when`s and are never reported. Inside
a focused terminal the keys that still reach the app are the effective keys of `terminal.toggle`,
`palette.toggleFromTerminal`, `terminal.prevTab` and `terminal.nextTab` (matched on the physical key too, so a
rebound letter works on any keyboard layout); they need a modifier and may not be the clipboard keys
(`ctrl+shift+c`, `ctrl+shift+v`, `ctrl+v`), so a rebound terminal toggle works there too (a pop-out window keeps
the default keys).

The command ids:

| Command id | Default key |
|---|---|
| `agentActions.allowAll` | — |
| `agentActions.ask` | — |
| `app.quit` | `ctrl+q` |
| `approval.allow` | — |
| `approval.always` | — |
| `approval.deny` | — |
| `attention.next` | `ctrl+j` |
| `binaries.redetect` | — |
| `branch.copyName` | — |
| `branch.newSession` | `n` |
| `branch.newWorktree` | — |
| `branch.removeWorktree` | — |
| `canvas.fitView` | `ctrl+0` |
| `contextMenu.close` (key-only) | `escape` |
| `edge.delete` | `delete` |
| `edge.inspect` | — |
| `edge.link` | `e` |
| `edge.restartWithFlags` | — |
| `edge.retry` | — |
| `edge.revokeAgentPolicy` | — |
| `edge.select` | — |
| `elsewhere.close` (key-only) | `escape` |
| `elsewhere.toggle` | — |
| `import.addSelected` | — |
| `launch.addFolder` | — |
| `launch.start` | — |
| `palette.close` (key-only) | `escape` |
| `palette.toggle` | `ctrl+k` |
| `palette.toggleFromTerminal` (key-only) | `ctrl+shift+k` |
| `pane.close` (key-only) | `escape` |
| `project.add` | `ctrl+o` |
| `project.collapse` | — |
| `project.expand` | — |
| `project.import` | — |
| `project.newSession` | `n` |
| `project.newWorktree` | — |
| `project.openEditor` | — |
| `project.openFolder` | — |
| `project.relayout` | — |
| `project.remove` | — |
| `project.revealClaudeDir` | — |
| `project.terminal` | — |
| `project.toggleBranches` | — |
| `project.toggleShowAll` | — |
| `review.backToCommits` | — |
| `review.changes` | `r` |
| `review.clear` | — |
| `review.comment` | `c` |
| `review.dismissToast` | — |
| `review.filterAll` | — |
| `review.filterStaged` | — |
| `review.filterUnstaged` | — |
| `review.layoutSplit` (key-only) | — |
| `review.layoutUnified` (key-only) | — |
| `review.modeBase` | — |
| `review.modeChanges` | — |
| `review.modeCommits` | — |
| `review.modeFiles` | — |
| `review.nextFile` | `j` |
| `review.open` | — |
| `review.openEditor` | `o` |
| `review.prevFile` | `k` |
| `review.refresh` | — |
| `review.toggleLayout` | — |
| `selection.activate` (key-only) | `enter` |
| `selection.clear` (key-only) | `escape` |
| `selection.move.down` (key-only) | `arrowdown` |
| `selection.move.left` (key-only) | `arrowleft` |
| `selection.move.right` (key-only) | `arrowright` |
| `selection.move.up` (key-only) | `arrowup` |
| `session.attach` | — |
| `session.fork` | — |
| `session.resume` | — |
| `session.showTerminal` | — |
| `session.stop` | — |
| `settings.open` | — |
| `settings.reveal` | — |
| `settings.toggle` (key-only) | `ctrl+,` |
| `terminal.close` | — |
| `terminal.focusWindow` | — |
| `terminal.kill` | — |
| `terminal.nextTab` | `ctrl+pagedown` |
| `terminal.popOut` | — |
| `terminal.prevTab` | `ctrl+pageup` |
| `terminal.restart` | — |
| `terminal.returnToPane` | — |
| `terminal.toggle` | ``ctrl+` `` |
| `worktree.create` | — |
| `worktree.discardAndRemove` | — |
| `worktree.forceRemove` | — |
| `worktree.modeExisting` | — |
| `worktree.modeNew` | — |
| `worktree.remove` | — |

**Exempt from commands** (the audit, `src/commands/audit.test.ts`, fails on any other direct `onClick` /
`onChange` / `onSubmit` handler in `src/components`, `src/canvas` and `src/terminal`): controls that act on one
specific item rather than the pane's subject, each with a palette route where one makes sense: a click on a file,
tree, commit or terminal tab row (`review.nextFile` / `review.prevFile`, `terminal.nextTab` / `terminal.prevTab`),
a tab's ×, a cooperate edge's per-side Retry (`edge.retry` retries every failed side), an add-dir row's Remove, an
import row's checkbox, an Elsewhere row's Add folder (the tray has no selection), a card's `review` flag
(`review.open`), the Allow / Deny / Always for this edge / Open / Dismiss buttons of a specific toast
(`approval.allow`, `approval.deny`, `approval.always`, `review.open`, `review.dismissToast`: the oldest); form fields
(the sheets' inputs and selects, the base `<select>`, the edge label, the comment box, the palette's input); pointer
gestures on the canvas (clicks, drag-to-link); and a pop-out window's header buttons (that window has no command
registry; the pane's buttons run `terminal.restart`, `terminal.close`, `terminal.kill` and `terminal.returnToPane`).

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
a dot grid and, while it has no nodes, a dashed ghost card "Drop a folder here" (a click adds a project) over "ctrl+o pick a folder · ctrl+k palette · f1 help". Pan with the **middle** or **right**
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
| Sessions | New session…, Plain terminal…, Link to… | New session… opens the launch sheet (see [Starting sessions](#starting-sessions)). Plain terminal… opens the project's terminal (see [Terminal](#terminal)). Link to… picks a node to draw an edge to (see [Edges](#edges)). |
| Open | Open in external editor, Open in file manager, Reveal Claude project dir | Rust performs each (the webview never spawns a process or touches the file system). The editor is the program named by the first token of `external_editor` in settings, launched detached with the project folder as its only argument (see [Settings](#settings)); the file manager opens the folder itself; the reveal opens `~/.claude/projects/<dir>` for the Claude project whose working directory is this folder (the import pane's comparison), and only if that directory already exists. The editor action is meant for GUI editors: a terminal editor such as vim starts with no window and nothing is seen. |
| Layout | Expand project or Collapse project (whichever applies, only when the project has children), Re-layout children | As before. |
| Remove | Remove from canvas | Immediate: no confirmation, no undo. The card, its children, its `sessions[]` refs and `branches`, every edge touching any of them and its live git status go; the selection is cleared if it pointed at the project or one of its children; a relaunch does not bring it back. On a read-only or newer-version `workspace.json` the removal applies in memory only, and the project comes back on relaunch. |

`↑`/`↓` move, Enter or a click runs, Esc, a click elsewhere or losing focus closes. The same commands are in
the palette (by title) while a project card is selected. A right-click on a **session card** selects it and
opens a menu with its enabled entries only: **Attach in terminal** while the session is live, and **Link to…**
on every session (see [Edges](#edges)). A right-click on a **branch card** opens a menu with **Copy branch name**
only (see [Branches](#branches)).

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
`(16, 92)` relative to the card), each child 208 × 40 with 8 px gaps, in a stable order: the sessions in list
order, then, as a second group, the branches (see [Branches](#branches)). Children move with their parent. A child **dragged** out of the column keeps that
spot, relative to the parent, across restarts, and leaves its slot empty; **Re-layout children** returns every child of that project
to its slot.

Children are derived by Rust from the discovered sessions (see [Sessions](#sessions)), `sessions` and
`branches` and carried on the snapshot as a flat type-independent list (`children: [{ id, projectId, kind:
session|branch, label, detail, position, session, branchId, branch }]`, `position: null` for a child in its
slot, `session` the card's facts for a discovered session and `branch` those of a discovered branch, `null`
otherwise). The layout can also be tried with **stub children**: set `SWITCHBOARD_STUB_CHILDREN=n` (0–50, read once at startup)
and every project gets `n` session stubs (`session 1`…`session n`, detail `stub`) after its real sessions. A
value above 50 is clamped to 50; a blank, non-numeric or negative value means 0. Launch again without the
variable and the stubs are gone, while a project's persisted `expanded: true` lingers harmlessly (no chevron,
nothing to show) until real children arrive. Stubs themselves are never written to the file; dragging one
stores a `sessions[]` entry holding just its id, project and position, and Re-layout removes such an entry
again when nothing else is in it.

### Sessions

An expanded project lists the **Claude Code sessions already run in its folder**, one child card each. They come
from Claude's own transcripts: every `~/.claude/projects/<dir>` whose working directory (read from its newest
transcript, as the import pane does) is the project folder, or one of the project's **known worktrees**,
contributes its top-level `*.jsonl` files, one per
session, keyed by the session id (the file name); per-session folders (`subagents/`, `tool-results/`,
`memory/`) are not sessions. Several dirs naming the same folder are merged. A project's known worktrees are
the `worktreePath`s stored in `branches[]` plus every linked worktree `git worktree list` reports for its repo
that is neither bare nor missing, the main checkout aside (the 5 s status poll already lists them for the
dirty count, so this costs no extra git call; it holds whatever the branches toggle, and a listing that fails
keeps the last list). A session whose folder is a worktree belongs under that
worktree's branch (the deepest worktree holding its folder): under its branch card while branches are shown, in
the session group otherwise. A folder that is a project's own folder always belongs to that project. Otherwise, when several projects on
the canvas know it as a worktree (two projects of one repository), the deepest matching worktree wins and, on
an equal depth, the first project in canvas order; the live poll uses the same rule. Each card shows the **title** (the
`/rename` title, else Claude's own `ai-title`, else the first prompt cut to 60 characters, else `(untitled)`)
and a muted meta line, `branch · N msgs · 3h`: the latest git branch the transcript names (left out when
none), prompts plus assistant replies, and the time since the last record (`now`, `5m`, `3h`, `2d`, then
`12 Oct` or `12 Oct 2025`, updated each minute). Hovering shows the full title and the exact start and
last-active times. The order is live sessions first (see [Live sessions](#live-sessions)), then pinned ones,
then the most recently started (so running sessions keep their slots); the collapsed badge counts them all. Past ten, a **`show all (N)`** row follows the tenth
card; clicking it, Enter while it is selected, or **Show all sessions** in the palette or the
card's menu shows the rest and the row becomes **`show fewer`** (a per-project view choice, not saved). A
session card can be dragged like any child and keeps its spot; a dragged child past the tenth is drawn even
while the rest are hidden. Enter on a session does nothing (Resume and Fork are in its menu and the palette).

Reading is **read-only**: nothing under `~/.claude` is written, renamed, locked or created. Transcripts are
streamed line by line on a background thread, and unknown record types, broken lines and a half-written last
line are skipped. The results are cached in memory only, by file size and modification time. Every **5 s** a
pass re-checks the files and re-reads only those that changed, so a running session's count and age stay
current and a new session appears on its own; adding or removing a project runs a pass at once. A pass that
finds nothing new changes nothing on screen.

### Live sessions

Every `poll.agents_ms` (default 2 s, re-read each tick, floor 500 ms) Rust runs the detected `claude` as
`claude agents --json --all` on a background thread with a 5 s timeout, and keeps the rows in memory, keyed by
session id. Nothing is persisted and nothing under `~/.claude` is touched; the poll does not run while
`claude` is not found (badges stay at 0, no tray). A row whose `cwd` is a project folder (or lies in one of its
known worktrees, see [Sessions](#sessions); Claude's own `.claude/worktrees/<name>` too) belongs to that project:

- its **session card** shows the state as the first word of the meta line, `busy · master · 12 msgs · now`:
  `busy` in full text colour after a small pulsing dot (static under reduced motion), `idle` muted, `finished`
  in the accent (see [Needs you](#needs-you)), and any other
  status Claude reports kept as it is (`compacting`) and muted. Live sessions sort first in the column. A
  running session with no transcript yet gets a card at once, labelled with the row's `name` (or "new
  session"), with no age, replaced by the transcript summary once the 5 s pass finds it;
- the project card's **`N live`** badge counts its session cards in a live state (hidden at 0);
- when the session ends it drops out of the poll and its card turns **`exited`** (muted) and stays as a
  historic session; it is live again if it comes back. Exited sessions are remembered until the app quits.

A busy ↔ idle flip travels on its own event (`sessions://live`) and never bumps the workspace revision; only a
change to which sessions are live, or to where they belong, re-derives the children (`workspace://changed`, no
file write).

Rows whose `cwd` is **no project on the canvas** go to the **Elsewhere tray**: a chip `elsewhere N` at the
bottom-left of the canvas, shown only when N > 0. Clicking it (or **Toggle Elsewhere sessions** in the
palette) opens a list above it with one row per session: state, name, shortened folder and an **Add folder**
button, which adds that folder at the centre of the view (a failure is the `project add failed` banner); on
the next poll the session sits under its new project and leaves the tray. Esc or a press outside closes the
list. A project removed from the canvas sends its live sessions to the tray on the next poll. A session
running in a **subfolder** of a project also shows in the tray (its `cwd` is not the project folder), and
Add folder there adds the subfolder as a project of its own.

If `claude` stops being found (settings changed, binary removed), the live state is cleared: no states,
badges, tray or banner until it is found again.

A session started elsewhere is read-only. **Attach in terminal** (palette, or the session card's right-click
menu, for a live session started elsewhere only) is still a stub: it shows the notice "Attach arrives in Epic 4
(claude attach <id>)". A session Switchboard started has **Show terminal** instead (see
[Starting sessions](#starting-sessions)).

One failed poll (the CLI cannot start, exits non-zero, times out or prints something that is not a JSON array)
keeps the last state, so nothing turns exited on a hiccup. After three failures in a row a banner reads
"live session status unavailable: <cause>"; the next successful poll clears it. Rows without a `sessionId` or
`cwd` are skipped and unknown fields ignored.

### Needs you

A session **needs you** when it is `finished` or `waiting`. Until hooks arrive (Story 4.3) only `finished`
happens, and Rust derives it from the poll: a session polled `busy` since it was last `idle` that now reports
`idle` is `finished` (another status in between, such as `compacting`, does not break that), and stays so while
the poll keeps saying `idle` or another status. It turns `busy` on the next `busy` and `exited` when it drops
out. A session already idle when first seen (at startup, say) is plain `idle`. A turn shorter than one poll
interval (`poll.agents_ms`) is never seen `busy`, so it never finishes (until hooks).

- Its **session card** goes into the accent: an accent border, `finished` in the accent and its dot pulsing.
- Its **project card glows**, collapsed or expanded (the count badge does not change): an accent outline just
  outside the card, pulsing; a selected card keeps its selection outline inside the glow. Both are static
  under reduced motion.
- **Selecting the session** (click, arrow keys, `ctrl+j`, a toast click) acknowledges it: Rust records it and
  the session reads `idle` (accent and glow gone, unless another session of the project still needs you) until
  it is busy again. Selecting the project does not acknowledge its sessions. A session that finishes while it
  is already selected keeps the accent until it is clicked (or reached with `ctrl+j`). Opening the Elsewhere
  tray acknowledges the Elsewhere sessions it lists.
- While the Switchboard window is **not focused**, a session entering `finished` (or `waiting`) sends one OS
  toast, if that kind is on in settings (`notifications.finished`, `notifications.waiting`): the title is the
  project label and the state (`ide — finished`; the folder name for an Elsewhere session), the body the
  session's title, else its name, else `session <first 8 of its id>`. No toast while focused, on startup, on
  acknowledgement, or for a session already in that state. A toast that cannot be shown is logged, never shown
  as a banner. No sound, badge or toast history.
- **Clicking a toast** brings the Switchboard window forward (unminimised, shown, focused) and reveals its
  session: its project expands if collapsed (persisted, as with the chevron), the session is selected,
  acknowledged and panned into view. An Elsewhere session opens the Elsewhere tray instead. A session that no
  longer needs you only gets the window focused. Focusing the window any other way moves nothing.
- On Windows a click is reported only while the toast is on screen; a toast clicked from the Action Center may
  report nothing, so use `ctrl+j` then. Development builds (`src-tauri\target\debug` / `release`) show toasts
  under PowerShell's name and icon and their clicks may not reach the app; an installed build shows
  Switchboard.
- **Go to session that needs you** (`ctrl+j`, palette) does the same reveal for the session that has needed you
  longest; press again for the next. When it cannot reach the session, a notice says so.

Nothing of this is persisted.

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

Git repos also show the **branches** chip at the right of the git line: a toggle that lists the repo's local
branches under the card (see [Branches](#branches)); the `N live` badge counts the project's live
sessions (see [Live sessions](#live-sessions)) and is hidden at 0. Git status is **live state**: it is never written to disk. A poller
on Tauri's async runtime refreshes every project every `poll.git_ms` (default 5 s, re-read from settings
each tick, floor 250 ms) and right after an add, running `git` off the UI thread with a 5 s timeout and
`GIT_OPTIONAL_LOCKS=0` so it never blocks a `git` you are running yourself. The binary is the one detection
found (or `git.path` from settings), else `git` on PATH. Only the changes are pushed to the UI
(`projects://status`).

### Branches

The **branches** chip on a git project's card (or **Show branches** / **Hide branches** in its menu and the
palette) toggles the project's **branch cards**. The choice is saved per project (`showBranches`, off by
default); turning it on with the card collapsed also expands it. Plain folders have neither the chip nor the
command.

With branches on, the project's **local branches** follow its sessions as a second group in the column, each
group with its own limit of ten and its own `show all (N)` / `show fewer` row, so sessions and branches never
push each other out. The checked-out branch comes first, then the rest by last commit, newest first, then by
name. Each card shows:

| Part | Meaning |
|---|---|
| `main *` | The branch name; `*` marks the branch checked out in the project's folder. A detached HEAD marks none (the git line already says `detached`). |
| `↑2 ↓1` | Commits ahead of / behind its upstream, either part left out when 0; nothing for a branch without an upstream. Ahead/behind is against the last-known upstream refs: nothing is ever fetched. |
| `upstream gone` | The upstream is configured but its ref no longer exists. |
| `…/.worktrees/feat` | A **linked worktree** has the branch checked out: the folder's last two path segments, full path on hover. `missing` when that folder is gone (git reports the worktree prunable). The project's own checkout gets no chip. |

The lists come from two read-only git calls per project, run from its folder on a background thread with a 5 s
timeout: `git for-each-ref refs/heads` (name, HEAD mark, upstream, ahead/behind, last commit date) and `git
worktree list --porcelain`. No ref, worktree or index is touched. They are **live state**, never written to
the file. A watcher on the repo's common git dir (`git rev-parse --git-common-dir`, so a project that is
itself a linked worktree works the same) covers `HEAD`, `packed-refs`, `refs/heads/**`, `refs/remotes/**` (so a
`git fetch` in a terminal updates `↑n ↓m` and `upstream gone`), `worktrees/**` and, in a reftable repository,
`reftable/**`; a folder of these that does not exist yet is watched once it appears. A burst of changes there
re-reads that project 300 ms after the last one, so a `git branch x` in a terminal shows within 2 s. A separate
pass re-reads every project with branches on every 30 s (four at a time, each project on its own, so a slow repo
never holds up another), which covers a watcher that failed and restarts a watch whose git dir moved. Turning
branches off or removing the project stops its watch.

When a git call fails, or the folder is gone or no longer a git repository, the last good list stays and the card's path row reads **`branches unavailable`**
(muted) with git's message on hover (the full path is then on the project name's hover).

Branch cards can be selected, reached with the arrow keys and dragged like session cards; a moved branch is
written to `branches[]` as `{ id: "<projectId>:<name>", projectId, name, position }` (only then); Re-layout
removes it again (unless it has a stored worktree path: one the app created, or a worktree a session was started in), and so does a read that no longer lists the branch, unless an edge or a session points at it. A stored branch with a `worktreePath` is never removed by a read, even once its branch is deleted: the path is
kept as history so its past sessions stay listed. Enter does nothing on a branch; its menu holds **Copy branch name**, for a branch with no worktree chip that is not checked out in the project's folder **New worktree…** (see [Worktrees](#worktrees)), **New session…** (`n`; see [Sessions on a branch](#sessions-on-a-branch)), and, with a worktree chip, **Remove worktree…** (see [Removing a worktree](#removing-a-worktree)). While branches are shown, a session started on a branch is drawn right under its branch card, one step further in.
Checking out branches comes in a later story.

### Worktrees

**New worktree…** in a git project's menu or the palette (enabled while the status poll says the folder is a
repo; no key) opens the **worktree sheet**, a pane on the right like the launch sheet. **New branch** (the
default) takes a name and a base (the local branches; the checked-out branch by default, or the repo's
default branch when HEAD is detached: `origin/HEAD`'s branch, else `main`, else `master`, else the first).
**Existing branch** picks one of the local branches that have no worktree and are not checked out anywhere;
**New worktree…** on such a branch card opens the sheet with it preselected. Under the fields the sheet shows
the exact command Rust will run, updated as you type, for example:

```
git worktree add -b auth-refresh B:\r\.worktrees\auth-refresh main
```

Enter (or `ctrl+Enter`) or **Create** runs it: the submit is the consent, there is no second confirmation; Esc
closes the sheet. Before anything runs Rust checks, read-only, that a new name passes `git check-ref-format
--branch` (and, on Windows, has no `< > " |`), that it is not taken, that the base is a local branch and that
the target folder does not exist yet; any refusal, and git's own error when the add fails, shows in the sheet,
which stays open. The command runs from the project folder with the configured git and a 30 s timeout, under
the project's branch lock. On success the branch is written to `branches[]` with its `worktreePath`
(canonical; a stored position is kept), the project's branches are turned on (expanding the card) when they
were off, the list is re-read, and the new branch card, with its worktree chip, is selected.

**Where it goes.** With `worktrees_root` null (the default), `<repo>/.worktrees/<branch>`, `<repo>` being the
project's top level (`git rev-parse --show-toplevel`). With `worktrees_root` set to an absolute path,
`<root>/<repo folder name>/<branch>`, so one root serves many projects; a relative root is refused in the sheet.
A `/` in a branch name becomes nested folders (`feat/x` → `.worktrees/feat/x`). Changing `worktrees_root`
affects only worktrees created afterwards; existing ones are never moved. There is no settings UI for it.

**The dirty count.** Every linked worktree inside the repository's top level (any of them, from `git worktree
list`, not only the app's) is left out of the card's `N changed` with one `:(top,exclude,literal)<folder>`
pathspec per worktree (the folder relative to the top level), so a clean repo with worktrees in `.worktrees/`
still reads clean, also for a project that is a subfolder of its repository. A stray file next to them (say
`.worktrees/notes.txt`) still counts. Nothing is written to `.gitignore` or `.git/info/exclude`.

### Removing a worktree

**Remove worktree…** in a branch card's menu or the palette (a card with a worktree chip, a `missing` one
too; no key) opens the **remove-worktree sheet**, the app's first confirmation. It names the branch and the
worktree's full path, and Rust checks first, read-only:

| Check | The sheet |
|---|---|
| Clean | One **Remove** button: the click is the confirmation. Enter does not remove. |
| Dirty | `N changed files (modified or untracked)`, counted by `git status` inside the worktree. **Remove** becomes **Force remove…**, which reveals a second button below it, `Discard N changed files and remove` (not focused, and disabled for 0.6 s so a double-click cannot confirm); only that second click runs `git worktree remove --force <path>`, and only while the worktree still has exactly those N changed files (otherwise Rust refuses and the sheet re-reads the checks). |
| Locked | `locked` (`locked: <reason>` when the lock has one): refused (unlock it in git first); there is no force. |
| A session in it | A live session with its folder inside the worktree, or an app terminal that was started there: `a session is running in this worktree: <name>`. Stop it first. A terminal that later changed into the folder, or any other program, is not seen (on Windows git then fails to delete and its message shows). |
| Folder missing | **Remove** runs `git worktree remove <path>`, which clears that one stale record and leaves any other alone. |

Under **Runs** the sheet shows the exact command Rust will run, e.g. `git worktree remove <path>`. **Also
delete branch <name>** (off by default; a line says the branch is kept) adds `git branch -d <name>`, run after a
successful remove; never `-D`. A refusal (not fully merged, checked out elsewhere) shows git's message in the
sheet and the worktree stays removed. The commands run from the project folder under the project's branch lock
with a 30 s timeout; git's first error line (on Windows, for example, a process holding a file) stays in the
sheet; after any refusal the sheet re-reads the checks. Once the remove succeeded, Rust stores the worktree's
path on the branch's `branches[]` entry (even for a worktree only `git worktree list` knew; a failed remove
stores nothing), so the sessions run there keep their place under the branch card, after a restart too; then the branches and the status are re-read, so the chip goes and the card stays
(the branch still exists). Resume of such a session falls back to the project folder. A launch on the branch
still resolves from git's live list, so a removed path is never used as a working folder.

### Edges

An **edge** records a relationship between two nodes. It is stored in `workspace.json` and drawn on the
canvas. There are two kinds, and Rust picks the kind from the two ends:

| Kind | From | To | Drawn as |
|---|---|---|---|
| context | a session or a project | a project or a branch (project → project included) | a dashed 1-px line |
| cooperate | a session | another session (undirected) | two parallel 1-px lines |

A context edge grants its source directory access **at launch** (see [Context edges at
launch](#context-edges-at-launch)), and one drawn from a session running in Switchboard is applied to it at
once (see [Context edges on live sessions](#context-edges-on-live-sessions)). A cooperate edge tells each of
its two sessions that the other exists (see [Cooperation edges](#cooperation-edges)). Edges to folders that
are not canvas nodes come later.

**Drawing an edge.** Hover a session or project card, or select it, and a small round handle appears on its
right edge. Drag from the handle and drop on any project, branch or session card. The whole card is the
target. While you drag, a card the pair is refused for shows the not-allowed cursor. A drop on empty canvas
does nothing. A refused drop shows a notice with the reason:

- `can't link a project to a session`
- `can't link from a branch`
- `can't link a node to itself`
- `already linked`: the same kind between the same two ends already exists, in either direction for
  cooperate.

From the keyboard, **Link to…** (`e`, the node menu or the palette, with a session or project selected)
turns the palette into a pick list of the nodes the selected one can be linked to. Collapsed projects'
children are included. Each row reads `<kind>: <target label> (<project>)`. Type to filter, Enter links,
and Esc cancels. The UI sends only the two ends: Rust validates the pair, refuses an unknown node, creates
the edge (`edge_add`), writes the file and broadcasts the snapshot.

**Selecting, labelling, deleting.** A click on an edge's line (or its label) selects it, which draws it in the
focus colour, and opens the **edge inspector** on the right. While the launch, worktree or remove-worktree
sheet is open, the click only selects the edge, so the sheet's form is kept; **Inspect edge** (or Enter
with no pane open) opens the inspector. From the keyboard, **Select edge…** (node menu or palette, with a
card selected) lists that card's drawn edges as `<kind>: <other end> — <label>`; picking one selects it
and opens the inspector. The inspector shows the kind, both ends and a
**Label** field. The label is saved on Enter or when the field loses focus. Control characters become a single space, it is trimmed and cut to 200 characters, and a blank
label clears it. The label shows at the edge's midpoint in small muted text, cut with an ellipsis. **Delete**
in the inspector, or Del while the edge is selected and focus is not in the field, deletes it at once
(`edge_remove`). There is no confirmation, because an edge is cheap to redraw. Esc closes the inspector and
keeps the edge selected. A second Esc, or a click on empty canvas, clears the selection. The arrow keys never
visit edges.

**Hidden ends.** An edge is drawn only while both of its end cards are drawn. If an end is in a collapsed
project, cut by the show-all limit, or no longer listed, the edge is not drawn but stays stored, as fork lines
behave; a selected edge that stops being drawn is deselected. An edge between two cards of one column (a
session and its own project, two sessions of one project) ends on the target's right edge, so it curves out
to the right and back; an edge to a card further left leaves its source on the left and enters the target on
the right, so it never sweeps back across the canvas. A branch end is always stored by its card id (`<projectId>:<name>`), and a session
end without a `sessions[]` entry gets one, so the edge goes when its project is removed. Removing a project deletes every edge touching it or its children. An edge to a session or branch
that is no longer listed is kept until its project is removed. The "forked from" line is not an edge: it
cannot be selected, labelled or deleted.

### Context edges at launch

A context edge means "you may also work in there": Rust turns it into `--add-dir <folder>` when a session
starts. The folder an edge grants is resolved by Rust, never by the UI:

| The edge's `to` | Folder |
|---|---|
| A project | The project's folder. |
| A branch with a linked worktree | That worktree's folder. |
| The checked-out branch | The project's folder. |
| A branch with no worktree | None: `no worktree`. |
| Any target whose folder no longer exists | None: `folder missing`. |
| A project removed from the canvas, or a branch no longer listed | None: `not found`. |

A branch is looked up in its project's latest branch list. With branches off there is no list: the
worktrees git last listed are used, then the branch checked out in the project's folder (from the status
poll; a detached HEAD checks out none), else `no worktree`. A project end is labelled with the project's
label, a branch end `<project>:<branch>`, and a removed project `a removed project`. Paths are canonical, a
folder is passed once, and a folder equal to the one the session runs in is dropped.

- **New session.** The project's outgoing context edges prefill the launch sheet's add-dirs, on the project's
  sheet and on a branch sheet of that project. Each prefilled row reads `via edge → <target>`; **Remove** drops
  it for this launch only (the edge stays). Targets that give no folder are not prefilled: a muted line under
  the add-dirs lists them (`not added: ui:feat (no worktree), docs (folder missing)`), and Start is not
  blocked. A prefilled folder that disappears before Start is refused like any missing add-dir: its row is
  marked and Start is blocked until it is removed.
- **Resume and Fork.** The session's own context edges plus its project's are passed as `--add-dir`, resolved
  against the folder the session resumes in. Unusable targets are skipped, and the notice names them first
  (`resumed without: ui:feat (no worktree) · resumed with model …`, or `forked without: …` after a fork). A
  fork takes the original's edges; a later Resume of the fork applies the fork's own edges, not the
  original's.
- **Not remembered.** Edge add-dirs are recomputed at every launch and never stored in the project's launch
  defaults.

### Context edges on live sessions

A context edge drawn from a session that runs in a Switchboard terminal (its terminal running, its live
state not `exited`) does something now, not only at the next resume. A project's edges stay launch defaults
for future sessions; an edge from a historic session, or from a session running elsewhere, has no live state.

1. **Resolve.** Rust resolves the edge's folder with the same rules as at launch (above). A target that gives
   no folder fails at once with its reason (`failed (no worktree)`, `folder missing`, `not found`), and nothing
   is written. A folder equal to the one the session runs in is `applied (the session's own folder)`. A path
   with a control character or a newline is refused (`failed (path has control characters)`).
2. **Wait for idle.** The line is written only while the session is `idle` or `finished` (as Stop reads them),
   never while it is `busy`, `waiting`, `starting` or being stopped. Until then the edge is `pending (waiting
   for idle)`; a session that stays not idle for 60 s fails it: `failed (session stayed busy)`.
3. **Never over a draft.** If you have typed into that session's terminal and not sent it (Enter, Ctrl+C or
   Ctrl+U send or clear it; a paste always counts as typed; keys pressed while the session is `waiting`
   answer a dialog and do not count), nothing is written: the edge stays `pending (you're typing — Retry when done)`
   and your draft is never touched. **Retry** says the prompt is clear and runs the step again.
4. **Inject.** Exactly one line is written to the session's PTY: `/add-dir <folder>` and Enter. Nothing else,
   ever: no further keys, no multi-line text. One edge per session is injected at a time.
5. **Confirm.** `/add-dir` is a local command: it writes no assistant turn, only (as expected, **not yet
   verified** with the real `claude`) a `<local-command-stdout>` record to the session's transcript
   (`~/.claude/projects/<dir>/<id>.jsonl`, read only). Rust tails the transcript for the first such record
   after the line: `Added … as a working directory` or `… already accessible …` makes the edge `applied`;
   any other output, and any `<local-command-stderr>`, fails it with that text (escape codes stripped); no
   record within 10 s is `failed (not confirmed)`. That would also cover a choice dialog waiting for an
   answer, if `/add-dir` shows one (**unverified**); the app never presses further keys. See
   [`docs/research/claude-code-integration.md`](docs/research/claude-code-integration.md).

The edge inspector shows a **Now:** line with the state and its detail. With no live state (an edge from a
historic session, a project's edge, or any edge after an app restart: the state lives in memory only and is
never persisted) it says what the edge does at the next launch or resume. On the canvas a pending edge is
drawn muted and a failed one in the attention accent. The state goes out on `edges://live` with the whole map.

- **Retry** (inspector, or **Retry edge** in the palette) appears when the edge failed or a draft holds it
  back, and runs the injection again.
- **Restart with flags** (inspector, or the palette) is always offered for a context edge from a session: it
  stops the session the way Stop does, waits until it has exited, then resumes the same id, which passes the
  session's context edges as `--add-dir` (see Resume above). The edge then reads `applied (restarted with
  flags)`, and so does every other context edge of that session (or `failed (<reason>)` when its target
  gives no folder). It needs a discovered transcript, as Resume does; without one the notice says so and
  nothing is stopped. One restart per session runs at a time (`that session is already restarting`). If it
  fails partway, the session's edges read `failed (<error>)`; a session that was stopped but could not be
  resumed says `stopped but not resumed: <error>`.
- **The session exits** while an edge is pending: its state is dropped; the edge applies at the next resume.
- **Deleting an edge** takes nothing away from a running session: Claude has no `/remove-dir`, so the folder
  stays until the session restarts.

### Cooperation edges

A cooperate edge between two sessions tells each session that the other exists, what the link is for and how
to reach it, so two sessions in different repos can coordinate without you passing messages along. Each
session is a **peer** of the other. Rust owns all of the text below; the UI only shows it.

A peer is named the way Resume names a session: its live name (`--name`), else its transcript title, else its
project's label. Its **node path** is `<project label>` (or `<project label>:<branch>` when the branch it was
started on is known), then ` / <name>`. Its **purpose** is the edge's label, or `no stated purpose`.

**At launch.** A resumed session's `--append-system-prompt` adds, after its context lines:

```
Peer sessions (cooperate edges):
- "ui-2" (ui / ui-2): API shape for auth refresh
Prefer SendMessage to a peer by its name to coordinate; if that does not reach it, use switchboard send and inbox.
```

At most five peers are listed, then `- … and N more`. Control characters and the Unicode line and paragraph
separators are stripped from every value, a `"` becomes `'` (so a name cannot close its quotes), and each value
is cut to 120 characters (then `…`), so no value can add a line. A session with no peers gets the prompt
unchanged. A new session has no edges yet. A **fork does not inherit** the original's peers: the peer only
knows the original.

**On live sessions.** When you link two sessions, each end that runs in a Switchboard terminal is sent one
plain line, with the same idle wait, draft rule and one-injection-per-session rule as `/add-dir` (see
[Context edges on live sessions](#context-edges-on-live-sessions)):

```
A new peer session "<other name>" is linked to you (<purpose>). Use SendMessage or switchboard.inbox to coordinate.
```

followed by Enter, with the same value cleaning as the prompt. The line is a user prompt, so a side counts as
`notified` when its session goes busy within 3 s of the write. An end that is not running gets nothing now: the peer is in its prompt at its next resume.
Because an edge starts without a label, the line usually says `no stated purpose`; the label you set later is
in the prompt at the next resume. When both ends run, each also finds a notice from `switchboard` in its
[inbox](#peer-messages-send-and-inbox), `Linked to "<other name>" (<purpose>).`, which counts toward its `N new`
badge but does not nudge on its own (the line above already told it).

The edge inspector shows one **Now:** line per side:

- `<name>: pending (waiting for idle)`: the session is not idle yet;
- `<name>: pending (you're typing — Retry when done)`: a draft in its prompt holds the line back;
- `<name>: pending (sent, waiting for the session to take it)`: the line was written;
- `<name>: notified`: the session went busy within 3 s of the line. That is the only signal there is, so
  something else making the session busy in that window reads the same;
- `<name>: failed (not confirmed)`: it did not go busy within 3 s (or its terminal was being stopped);
- `<name>: failed (session stayed busy)`: it stayed not idle for 60 s;
- `<name>: failed (<error>)`: the write failed, or a Restart with flags of that session failed while the
  side was pending;
- `<name>: peer named at the next resume`: no live state (the session is not running in Switchboard, or
  the app restarted).

**Retry** appears under a side that failed or that a draft holds back, and sends that side's line again;
Rust refuses it for any other side, since a pending line may already have been written. **Retry edge** in
the palette retries every such side. There is no
Restart with flags: the next resume carries the peer anyway. On the canvas the edge is drawn muted while a side
is pending and in the attention accent when a side failed. The state lives in memory only, on `edges://live`,
keyed `<edgeId>#<sessionId>` per side; the session exiting or the edge being deleted drops it.

`SendMessage` is named first; the `switchboard` MCP server's `send` / `inbox` tools (Story 7.3, see
[Peer messages](#peer-messages-send-and-inbox)) are the fallback. **Not yet verified:** that `SendMessage` from one session by the peer's name reaches the
other while it is idle. That check is done by hand with the real `claude`; if it does not deliver, the inbox
nudge of Story 7.3 becomes the primary channel. See
[`docs/research/claude-code-integration.md`](docs/research/claude-code-integration.md).

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
Each project is `{ id (UUID v4), path (canonical), label, position, expanded, color, launchDefaults,
showBranches }`;
`sessions[]` holds `{ sessionId, projectId, branchId, label, pinned, position }` (a child's `position` is
relative to its parent card and `null` in its slot), `branches[].position` likewise (a branch is written
only once it is moved, or given a worktree from the sheet, which also sets its `worktreePath`, or a session is
started in its worktree; see [Branches](#branches), [Worktrees](#worktrees) and
[Sessions on a branch](#sessions-on-a-branch)); a session started on a branch has its `branchId`; `edges[]` holds
`{ id (UUID v4), from, to, kind: context|cooperate, label, createdAt }`, each end `{ type:
project|branch|session, id }` (see [Edges](#edges)), written when an edge is drawn, labelled or deleted. A `sessions[]` entry whose session is no longer a child (a stub from a higher count, a
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
| node move failed / expand failed / collapse failed / re-layout failed / remove failed / label edge failed / delete edge failed: … | Rust rejected the change (an id it does not know, no runtime) | Nothing changes; a dropped node goes back to its stored position; the banner clears on the next successful change. |

## Terminal

**Plain terminal…** (a project card's menu, or the palette with a project selected) opens that project's
terminal in the **terminal pane**: the configured shell (`shell` in [Settings](#settings); unset, `pwsh` if it
is on PATH else `powershell` on Windows, `$SHELL` else `/bin/sh` on Linux) runs in the project folder, in a
real PTY (ConPTY on Windows, a Unix PTY on Linux) with `TERM=xterm-256color` and `COLORTERM=truecolor`, so
256-colour and truecolour output, the cursor and full-screen programs work. A project has one plain terminal:
running Plain terminal… again shows the same one, running or exited, and never starts a second shell. A shell
that cannot be started leaves the terminal exited, with `could not start <shell>: <cause>` in the header and the
terminal, and **Restart**.

The pane is wider than the others (`min(720px, 70vw)`) and its left edge drags it between 360 px and 90vw; the
width is remembered in this browser profile (`localStorage`, best effort). Its header shows the project, its
folder, the state (`running`, `stopping` during a Stop, `exited N`) and **Restart** (once exited), **Hide** and **Kill**; below it the
terminal itself, with 5 000 lines of scrollback. Resizing the pane or the window refits the terminal and resizes
the PTY (debounced to 50 ms). The pane shows one terminal at a time, the active tab (see
[Tabs and pop-outs](#tabs-and-pop-outs)).

**Keys.** With focus in the terminal every key is the terminal's: Esc, `ctrl+c`, `ctrl+o`, `ctrl+k`, `ctrl+r`
and the rest reach the shell (or the program running in it), and Esc does not close the pane. Only four keys
still reach the app: ``ctrl+` `` hides the pane (and shows it again from anywhere, refocusing the terminal),
`ctrl+shift+k` opens the palette, and `ctrl+pageup` / `ctrl+pagedown` move between the tabs. Alt+F4 is never
the terminal's: it closes the window, as anywhere else. Outside the terminal (on the header's buttons, say) Esc closes the pane as
usual.

**Copy and paste.** `ctrl+shift+c` copies the selection; `ctrl+shift+v` pastes, as do `ctrl+v` and the
webview's right-click Paste. A paste goes through the terminal's paste path, so a program that asked for
bracketed paste gets it as one block. Selecting text never copies it by itself.

**Hide, kill, restart.** Hiding the pane (Hide, ``ctrl+` ``, Esc outside the terminal) keeps the process
running and its output arriving; reopening shows everything it printed meanwhile. **Kill** (`terminal.kill`)
ends the process: the header reads `exited N` and the output stays. **Restart** (`terminal.restart`) starts the
shell again in the same terminal, below the old output. Exiting the shell (`exit`) is the same as a kill: the
header reads `exited 0`. Quitting the app kills every terminal's process; no shell outlives Switchboard
(on Windows each shell runs in a job object, so whatever it started goes with it). **Remove from canvas**
kills the project's terminal and forgets it.
Terminals do not survive a restart of the app. Rust keeps the last 2 MiB of each terminal's output, so a
webview reload gets every terminal back with its recent output.

**Rendering.** The terminal draws with WebGL when it can. When WebGL is unavailable, or its context is lost (a
GPU reset), it switches to its DOM renderer for the rest of its life: the same output, drawn more slowly. Links
are underlined on hover but do not open a browser. Its colours come from the design tokens, the 16 ANSI colours
included (see [Design](#design)).

### Tabs and pop-outs

Every terminal opened or shown in the pane (Plain terminal…, Show terminal, a launched, resumed or forked
session, ``ctrl+` ``) becomes a **tab** in a strip over the header, added at the end and made active. A tab
shows the terminal's title, its state word (muted: `running`, `exited N`, or a session's own `busy` /
`idle` / …) and, for a `waiting` or `finished` session, the attention dot. The strip scrolls sideways when the
tabs do not fit. Each tab is a plain button (screen readers hear the active one as current) with its own
labelled × button ("Close tab <title>"), so Tab walks through them in order. Switching tabs is instant: every terminal's view lives on, hidden, and keeps receiving output.
Click a tab, or press `ctrl+pageup` / `ctrl+pagedown` (from inside the terminal too). While the pane is open,
selecting a session card with a Switchboard terminal, or a project whose plain terminal is open, switches to
that terminal's tab (adding it if needed) and leaves focus on the canvas; with the pane closed, selecting
changes nothing. A tab's **×** removes the tab only: the process keeps running, and Show terminal or Plain
terminal… brings it back. On an exited session terminal × closes the terminal, as its Close does; if that is
refused, the tab stays and the notice says why. There is no
key for closing a tab. Removing a project from the canvas takes its terminals' tabs with it.

**Pop out** (the header button, or Pop out terminal in the palette while the pane is open) moves the active
terminal into its own OS window, `<title> — Switchboard terminal` (the title follows a restart), 900 × 600,
resizable down to 480 × 320. It is the same process and the same output:
the window replays what the terminal kept and follows it live, and typing there goes to the same shell. That
window has only the terminal, its header (title, state, Restart / Close / Kill as in the pane, and **Return to
pane**) and copy and paste; no canvas command runs there, and ``ctrl+` ``, `ctrl+shift+k` and the tab keys go to
the program. Alt+F4 closes it. A refused action shows as the notice in that window. While it is open it sets
the terminal's size, and only it answers the program's terminal queries. In the
main window the tab stays, marked `↗`; the pane's header keeps only the title, the state and Hide, and the body
shows "In its own window" with **Focus window** and **Return to pane**. Output keeps arriving in the pane's
hidden view too. A Restart in either window clears the other window's view as well. Popping out a terminal that already is
in a window focuses that window. Closing the window by any means, or Return to pane in either window, brings
the terminal back: the PTY gets the pane's size at once (even when its tab is not the one showing) and the
pane's view redraws from the kept output, so lines printed at the window's width are not garbled. Resuming a
session whose earlier run is popped out returns it to the pane once the new run has started. If the process exits while
popped out, the window stays and reads `exited N`. Quitting the app (or closing the main window while it quits,
see [Tray and closing the window](#tray-and-closing-the-window)) closes every pop-out and kills every terminal as
before; closing the main window to the tray leaves pop-outs open. Tabs and pop-outs do not survive a restart of the app.

## Starting sessions

`n` on a selected project (or **New session…** in its menu or the palette) opens the **launch sheet**, a pane on
the right like settings and import:

| Field | What it is |
|---|---|
| Name | The session's name (`--name`). Defaults to `<project label>-<first 4 hex of the session id>`; editable, not blank. |
| Model | `default`, `fable`, `opus`, `sonnet`, `haiku`, or `custom` with free text (`--model`). |
| Effort | `default`, `low`, `medium`, `high`, `xhigh`, `max` (`--effort`). |
| Permission mode | `default`, `manual`, `acceptEdits`, `plan`, `auto`, `dontAsk` (`--permission-mode`). `bypassPermissions` is not offered, and Switchboard never passes `--dangerously-skip-permissions`. |
| Add-dirs | Extra folders the session may use (`--add-dir` each): prefilled with the folders the project's context edges grant, each marked `via edge → <target>` (see [Context edges at launch](#context-edges-at-launch)); **Add folder…** opens the folder dialog ("Add folder for this session"), **Remove** drops a row. Duplicates and the project's own folder are left out; every folder that no longer exists is marked on its row and blocks Start until removed. |
| First prompt | Optional; sent as the session's first message. |
| Start in background | Start without opening the terminal. |

Model, effort and permission mode come from the project's last choices, then `defaults` in
[Settings](#settings), then `default`; each start remembers the three for the project (in `workspace.json`).
Add-dirs (edge-derived ones included), the prompt, the name and the background toggle are never
remembered. A choice left at `default` passes no flag, so `claude`'s own default applies.

**Keys.** Enter in a one-line text field or a select starts; Enter in the prompt adds a newline (and on the
background checkbox or a button does what it does there); `ctrl+Enter` starts from anywhere in the sheet; Esc
closes it. While Start is disabled the reason shows beside it. If the start is refused (no `claude` found, a
folder gone, a sheet that is out of date, a `claude.path` that is a `.cmd` / `.bat` on Windows), the sheet stays
with the reason under Start and nothing is started. Each sheet carries the session id its default name was
made from; Start uses that id once, so a double Start or a stale sheet is refused rather than starting twice.

**Windows: use the native `claude.exe`.** The npm package installs `claude` as a `claude.cmd` shim, and running
a batch file would let `cmd.exe` re-parse the prompt, so a `claude.path` that is (or resolves through
`PATHEXT` to) a `.cmd` / `.bat` is refused. Install Claude Code with the native installer and point
`claude.path` at its `claude.exe` (or leave it unset if the native one comes first on PATH); to switch from
npm, uninstall the global npm package after installing the native one.

**What runs.** Rust assigns a fresh session id and runs, as separate arguments (never a shell string):

```
<claude> --session-id <uuid> --name <name> [--model <m>] [--effort <e>] [--permission-mode <p>] [--add-dir <d>]…
         --settings <session dir>/<uuid>.settings.json [--mcp-config <session dir>/<uuid>.mcp.json]
         --append-system-prompt <context> [<prompt>]
```

in the project folder, in a terminal (`TERM=xterm-256color`, `COLORTERM=truecolor`, `SWITCHBOARD_NODE=<uuid>`).
`<context>` is a few lines saying the session runs inside Switchboard, with the project's label, folder and
branch (when known) and the session's name and node id. A session with cooperate peers (on Resume) also gets
the peer block and its one instruction (see [Cooperation edges](#cooperation-edges)). The settings file holds the session's
hooks (see [Status](#status)), or `{}` when the hooks endpoint is down; the env then also has
`SWITCHBOARD_PORT=<port>`. Your own Claude settings and hooks are untouched (settings layers merge) and
nothing is written under `~/.claude`.
The session dir is per user: `%TEMP%\switchboard\sessions` on Windows, `$XDG_RUNTIME_DIR/switchboard/sessions`
on Linux (else `~/.cache/switchboard/sessions`). On Linux the folder is created 0700 and refused if another
user owns it or it is a symlink, and each file is created new (0600), never overwritten. The file is deleted
when the session's process exits and when the app quits; files a crash left behind are swept at the next start
once they are a day old. A prompt that starts with `-` is passed after `--`, so it is
never read as a flag. While the hooks endpoint is up, the launch also writes `<uuid>.mcp.json` beside the
settings file (created, swept and deleted the same way) and passes it as `--mcp-config`: it gives the session the
[`switchboard` MCP server](#the-switchboard-mcp-server). With the endpoint down there is neither the file nor the
flag. `--strict-mcp-config` is never passed, so your own MCP servers stay available.

**On the canvas.** The session appears at once under its project as a child in the muted `starting` state, and
turns `idle` on its first printable output (or its first poll row); the terminal's own start-up escape
sequences do not count. In the foreground the terminal pane opens on it,
focused, and the child is selected (its project expanded); in the background only the child appears. While its
process runs, the live poll not listing it yet never marks it `exited`; when the process ends it turns `exited`
at once and stays as a historic child. When its transcript appears, it is the same child (matched by session
id), now with the transcript's title and facts.

**The terminal.** The session's terminal is titled with the session's name and runs in the project folder. It
has **Kill** but no **Restart**: an exited session is resumed instead (see
[Resume, fork, stop](#resume-fork-stop)). Once it has exited, **Close** (`terminal.close`) forgets the terminal
and its output. **Show terminal** (the session card's menu, or the palette, with the session selected) opens
the pane on it again. Quitting the app kills the session like any terminal.

### Sessions on a branch

`n` on a selected **branch card** (or **New session…** in its menu or the palette; disabled while its worktree
chip reads `missing`) opens the same launch sheet aimed at that branch. Every field, default and key is as
above; the subtitle reads `Starts claude on <branch> in <folder>`, and an add-dir equal to that folder is
left out. Rust resolves the folder from its own latest branch list, never from a path the UI sends:

| Branch | Where the session runs |
|---|---|
| Has a worktree chip | The worktree's folder (also one made in a terminal, not by the app). |
| Checked out here (`*`) | The project folder. |
| No worktree | A worktree Start creates first: the sheet shows a **Worktree** section, `Creates a worktree for <branch>`, with the exact command [Worktrees](#worktrees) would run, e.g. `git worktree add <repo>/.worktrees/feat feat`. |

The one Start is the consent to both: it creates the worktree exactly as **New worktree…** does (branch card
with its chip, branches on, list re-read) and then starts `claude` in it. If the worktree cannot be made (the
folder exists, git refuses), the reason shows in the sheet and nothing starts; if it was made but the session
fails to start, the worktree stays and the start's reason shows. A start races a changed list cleanly:
`branch not found` or `worktree folder missing` in the sheet. The system prompt's branch is that branch.

Before the spawn Rust records the branch's `worktreePath` in `branches[]` (so a worktree made outside the app
maps too) and writes the session's `{ sessionId, projectId, branchId: "<projectId>:<branch>" }` to
`sessions[]`. The live session's working folder then resolves to that project and branch, and while the
project's branches are shown the session card is drawn **directly under its branch card**, one step further
in, in the branch group. It counts toward neither group's ten and follows its branch card, dragged or not;
it moves and selects like any session card, and the arrow keys follow the
column as drawn. With branches off, once the branch is gone, or while its branch card is cut by the ten, the card is in the session group.

**`claude --worktree`.** The project's own sheet (in a git project) offers **Let Claude make a worktree
(`--worktree`)** with a **Worktree name**, prefilled from the session name (lower case, dashes) until you edit
it. Claude then creates the new branch `worktree-<name>` from the repo's default branch in
`<repo>/.claude/worktrees/<name>`; the field says so. `--worktree <name>` goes into the argv and `claude` runs
from the repo's top level. The name must pass `git check-ref-format --branch worktree-<name>` (checked as you
type, and again by Rust at Start). Rust stores `{ name: "worktree-<name>", worktreePath:
"<repo>/.claude/worktrees/<name>" }` and the session's `branchId` before the spawn; the ref keeps that branch
entry until git lists the branch, and the session's live folder then maps to it. A Claude configured to put its
worktrees elsewhere maps too, once the status poll sees the worktree in `git worktree list`. Not offered on a branch sheet: `--worktree` always
makes its own branch.

Sessions run in a worktree (the app's, Claude's `--worktree` ones, or one made in a terminal) are found again
after a restart: discovery and the live poll accept every known worktree of the project (see
[Sessions](#sessions)).

## Resume, fork, stop

Three commands on a selected session card (its menu, in this order, and the palette; no keys):

| Command | Offered for | What it does |
|---|---|---|
| **Resume** | A session with a transcript that is not live (never seen running this run, or `exited`) | Runs `claude --resume <id>` at once (no sheet). The **same node** turns `starting`, then `idle`, … as for a new session; the terminal pane opens on it, focused, and it is selected. |
| **Fork** | Any session with a transcript, live or not | Runs `claude --resume <id> --fork-session --session-id <new id>` at once. A **new node** appears, joined to the original's card by a thin muted "forked from" line; it is selected and the pane opens on it. |
| **Stop** | A session running in a Switchboard terminal | At its prompt (`idle`, `finished`) clears the input line (Ctrl+U, so an unsent draft is never submitted), then types `/exit` and Enter; otherwise (`starting`, `busy`, `waiting`, …) sends Ctrl+C, waits 300 ms, sends Ctrl+C again. A `starting` session is interrupted rather than sent Enter, which could accept a start-up dialog's default (such as folder trust). Still running 5 s later, it is killed. The card reads `stopping` (muted) until the process ends, then `exited`. Stop again while it is stopping kills at once. |

**What runs.** Resume and Fork use the same path as a new session (see [Starting sessions](#starting-sessions)),
with the **project's latest choices** (the last ones a launch sheet started with, else `defaults`) for model,
effort and permission mode, not the ones the session itself last ran with. The notice after each says what was
used, for example `resumed with model opus, effort default, mode plan` (`default`: the flag was left out). The
rest is the same: the hooks `--settings` file, the `--append-system-prompt` context and the environment; the
add-dirs are the folders the session's own context edges and its project's grant (see [Context edges at
launch](#context-edges-at-launch)); there is no first prompt:

```
<claude> --resume <id> [--model …] [--effort …] [--permission-mode …] [--add-dir <d>]… --settings … --append-system-prompt …
<claude> --resume <id> --fork-session --session-id <new> --name <name>-fork-<4 hex> [--model …] … [--add-dir <d>]… --settings … --append-system-prompt …
```

A resume passes no `--session-id` and no `--name`, so the session keeps its own name; a fork is named after the
original (its name, else its title, else the project's label, cut to 40 characters, and without the
`-fork-<4 hex>` of a fork it was itself forked from) with `-fork-` and the first four hex of its new id.
Claude finds a session through the folder it ran in, so both run in the **transcript's recorded folder** when it
still exists, else in the project's folder; when neither exists the command is refused with
`session folder not found: <path>`.

**Refusals** are the notice: resuming a session that is starting or running (here or elsewhere), a second Fork of a
session while its first is still starting, a session with no transcript, a project that is gone, a folder that is
gone, no usable `claude`; a fork whose link to its original cannot be saved is refused too. A resume reuses the terminal id `session:<id>`: the exited
terminal of the earlier run is replaced and its view starts afresh.

**The fork line** is saved: the fork's entry in `workspace.json` records `forkedFrom`, so after a restart the
line is drawn again whenever both cards are drawn (not when the original is in a collapsed project, past the
tenth child, or no longer listed). It is a drawing of that field, not an edge: it cannot be selected or edited.
When the fork itself is gone (neither its transcript nor a live or exited node of this run remains), the next
discovery pass drops its entry; a missing original only hides the line.
The fork card's tooltip and accessible name say `forked from <original title>`.

**Only Switchboard's own sessions are stopped.** A session started in another terminal keeps **Attach in
terminal** (still a stub) and is never signalled or killed.

## Status

A session Switchboard starts reports its own state through **Claude Code hooks**; sessions started elsewhere
keep the 2-second `claude agents --json` poll alone, exactly as before.

**Hooks.** On start the app writes `http` hooks into the session's `--settings` file for `SessionStart`,
`UserPromptSubmit`, `PermissionRequest`, `Notification` (permission, elicitation and needs-input types only),
`Elicitation`, `PostToolUse`, `PostToolUseFailure`, `Stop` and `StopFailure`. Each POSTs its event to an
endpoint inside the app on `127.0.0.1:<ephemeral port>` with a per-session bearer token (32 random bytes,
dropped when the session exits). The endpoint binds 127.0.0.1 only. It checks the path and token from the
request head before reading any body, refuses an unknown token (401), any other path or method (404) and a body
over 1 MiB (413) and closes the connection after a refusal; it serves at most 64 connections at once and closes
one that sends nothing for 10 s. Every accepted hook gets an **empty 200**, sent before the event is applied, so
a hook never approves, denies, blocks or waits on anything: Claude's own permission dialog still decides.

| Hook | State |
|---|---|
| `SessionStart` | `starting` → `idle` |
| `UserPromptSubmit` | `busy` |
| `PostToolUse`, `PostToolUseFailure` | `busy`, except that a `waiting` session stays waiting (a parallel tool or a subagent finishing does not answer its prompt) |
| `PermissionRequest`, `Elicitation`, `Notification` (wired types) | `waiting`; the reason is the card's tooltip and part of its accessible name |
| `Stop` | `finished`; the card shows `finished · <last line>` (the turn's first non-empty line, cut to 200 characters) until acknowledged |
| `StopFailure` | `finished`, `turn failed` |

A session counts as hooked from its first accepted hook event. **Answering in the terminal:** while a session is
`waiting`, a single key press typed into its terminal answers at once, before the tool's own hook arrives. On a
permission prompt, Enter, a digit, `y` or `n` turns it `busy`, and a lone Esc (a rejection, which ends the turn)
turns it `idle`; on an elicitation or needs-input prompt only Enter counts (`busy`). Pasted text and the
terminal's own reply sequences never count. The permission `Notification` that arrives about 6 s after the
dialog is ignored for 10 s after such an answer. The glow, toasts and acknowledgement follow
[Needs you](#needs-you) whatever the source.

**Polling stays the baseline.** For a hooked session the poll's busy → idle `finished` guess is off; the poll
is checked against the hook state instead (`busy`/busy, `waiting`/busy, idle or another status, `finished`/idle
or another status, `idle`/idle and `starting`/anything agree). When it disagrees for two polls in a row with no
hook event between, the poll's state is applied and, when that changed the state, the **poll overrides**
counter goes up. If the endpoint cannot bind (or stops), launches still work without hooks (`{}` settings),
every session goes back to the poll's rules, and a banner reads `hooks endpoint unavailable: <cause>`.

**Diagnostics.** Settings (`ctrl+,`) → **Diagnostics** shows the endpoint (`127.0.0.1:<port>` or the bind
error), hook events received, refused requests, session-id mismatches (an event whose `session_id` is not the
token's session, nor one a `SessionStart` on that token announced, as after `/clear`; it still applies to the
token's session), poll overrides and **MCP refused requests** (below), refreshed every 2 s while open. Under
the counters, **Recent MCP refusals** lists the last 20 refused `/mcp` requests newest first
(`<time> /mcp — <reason>`: `missing token`, `unknown token`, `body too large` or `read timeout`; never any part
of a token). A failed read shows next to the last counters read.

**Limits worth knowing.**
- The bearer token is written in the session's settings file, so the session's own processes (Claude, its
  tools, anything it runs) can read it and could post hook events for that session. It only ever changes that
  session's status on the canvas.
- The same token (also in the session's `.mcp.json`) opens the [`switchboard` MCP server](#the-switchboard-mcp-server):
  whatever can read it can **read the whole graph** through the read tools: every project path, every live
  session's name, status and last line, the edges and their labels, and the session's own add-dirs. It can also
  ask for the act tools (Story 7.2: start a session, link, unlink), which run only after the operator's approval
  (or under a policy the operator set), and post the session's status line. And it can use `send` and `inbox`
  (Story 7.3), which never ask: it can message that session's cooperate peers, whose nudge then **types a line
  into each peer's terminal** (at most 20 an hour per peer), and read and clear that session's inbox. And it can
  call `request_review` (Story 7.4), which never asks: it flags that session's own card and shows a review toast
  (and, unfocused, an OS notification), listing paths within that session's own folders only.
- On Windows the settings file is protected only by the per-user `%TEMP%` folder's permissions (on Linux it is
  0600 in a 0700 folder).
- If one of your own `Stop` hooks blocks the stop (asks Claude to continue), Switchboard's `Stop` hook still
  fires in parallel, so the card may show `finished` and a toast may go out while Claude keeps working; the
  next hook event corrects the state.

## Review

**Review changes** (`r`, the node menu or the palette, Story 8.1) opens the Review pane on the selected card's
working tree, read-only: nothing is staged, committed or written.

| Card | Reviews |
|---|---|
| Project | Its folder (a project in a subfolder of a repository sees only that subfolder's files). |
| Branch | Its linked worktree, found from the branch list as a launch finds it. A branch without a worktree is refused with `no worktree`, and so is the branch checked out in the project's folder (review the project instead). |
| Session | Its cwd (the live one, else its transcript's). |

The UI only names the card; Rust finds the folder, runs git and reads the files. The pane is wide, like the terminal
pane: `min(1100px, 85vw)` by default, dragged between 360 px and 90vw by its left edge (the width is remembered), with
the canvas still visible beside it. Esc closes it.

**The tree.** The changed files, with a plain mark (`M` modified, `A` added, `D` deleted, `R` renamed, with `renamed
from <old>`, `U` untracked, `C` conflicted) and `+N −M` counts; folders first, a chain of single folders on one row.
Linked worktrees inside the repository are left out, as in the status count. An untracked file counts all its
lines as added. A clean tree says `No changes`.

**The filter** (a three-way toggle, also palette commands): **All** compares HEAD with the working tree (the
default), **Staged** HEAD with the index, **Unstaged** the index with the working tree. The tree and its counts
follow it.

**The diff.** The selected file opens in a CodeMirror 6 merge view: side by side by default, **Unified** with the
toggle (or Review: unified view). Changed words are highlighted within changed lines, and unchanged stretches are
collapsed to 3 lines of context (click one to open it). Syntax highlighting comes from language packs loaded on
demand by extension: JS/TS/JSX/TSX, Rust, Python, JSON, CSS, HTML, Markdown and YAML; anything else is plain text.
The pane, CodeMirror and each language pack are separate chunks, loaded the first time they are needed.

| File | Shown as |
|---|---|
| Binary (holds a NUL byte, or `git diff --numstat` counts it `-`) | `binary file`, no text. |
| A side over 2 MB or over 50,000 lines | `too large to show (+N −M)`. |
| Text that is not valid UTF-8 | Decoded lossily, with a `not UTF-8` line over the diff. |
| A symbolic link | Its target, as git stores it (never followed). |
| A submodule | `submodule`, no text. |
| A path that is not valid UTF-8 | Listed lossily as `unreadable name`, no text. |
| An untracked file over 2 MB | `too large` in the tree, not counted. |
| `git rm --cached` | One row: deleted from the index, still on disk. |

CRLF line ends are shown as LF on both sides, so a file checked out with `core.autocrlf` is not
changed on every line. The tree lists at most 5,000 files, then says `N more files not shown`. A review
request's paths are matched by Rust against the reviewed folder; one outside it is marked `outside this
folder`. A branch's worktree, or a session outside its project's folder, is not covered by the project's
status poll, so while the pane shows one its list is read again every `poll.git_ms`.

**Freshness.** The list is read when the pane opens and on **Refresh**; it is read again whenever the project's
status poll changes while the pane is open. **Diagnostics** (Settings) shows `last diff render: N ms`: the time from
the selected file's text arriving to the merge view's first frame (the budget is 300 ms for a 3,000-line file with
40 hunks).

**How it reads git.** `git status --porcelain=v2 -z --untracked-files=all` and `git diff --numstat -z -M` (against
`HEAD`, `--cached`, or the index) list the files, limited to the folder; the old side is `git show HEAD:<path>` (or
`:<path>`, the index), the new side the index or the file on disk. A file is read only when git listed it, and only
inside the reviewed folder (its real location, links followed). Every call is prompt-less and takes no optional
locks.

### vs base and Commits

On a project or a branch card the toolbar starts with a mode toggle (Story 8.2; also the palette's **Review:
changes**, **Review: vs base** and **Review: commits**): **Changes** is the working tree above (and the only mode on a
session card), **vs base** is what the branch changed since it forked from a base, **Commits** is the branch's
commits beyond the base. A branch's vs base and Commits need no worktree: they read the repository at the project's
folder. On a project they read its checked-out branch (a detached HEAD is refused). The filter shows in Changes only.
A branch card without a linked worktree opens in vs base (its Changes would only say `no worktree`).

- **The base** defaults to the repository's default branch (`origin/HEAD`'s name when that is a local branch, then
  `main`, then `master`) as long as it is a local branch other than the one compared; otherwise the first other
  local branch by name. With no other local branch there is no base and the pane says `no base branch: pick one`.
  The dropdown offers every local branch, the default first and marked `(default)`. Remote branches are never
  offered, and Rust refuses any base that is not a local branch. When the branch has nothing beyond the base (a
  branch picked against itself, say), the pane says `No commits on <branch> beyond <base>`. A failed read (a base
  with no common ancestor, say) shows its error in the tree and keeps the dropdown, so another base can be picked.
  Branch names that are not valid UTF-8 are left out.
- **vs base** lists `git diff --raw -z -M` and `--numstat -z -M` between `git merge-base <base> <branch>` and the
  branch, keeping the files inside the project's folder: only what the branch changed, not what the base did since.
  A rename into the folder from outside it is a rename (`renamed from :/<path>`); one out of it is a deletion. A
  project in a subfolder whose range touches nothing in it says `No changes in this folder`. A file's old side is
  the merge-base's, its new side the branch's (`git show <commit>:<path>`); opening a file diffs only that path. Each
  read resolves the branch and the base to commits once, so a branch that moves mid-read cannot mix states. Marks,
  counts, the 5,000-row cap, the 2 MB / 50,000-line sides, binary, submodule, not-UTF-8 and CRLF handling are as in
  Changes.
- **Commits** lists `git log <base>..<branch>`, newest first: short hash, subject, author and age. At most 200 are
  listed, then `N older commits not shown`. Selecting one shows its files in the same tree and diff, against its
  first parent (a merge commit's first parent; the empty tree for a root commit); **← Commits** goes back to the
  list. Rust accepts only a full hash among the commits it listed; a shown commit that a re-read no longer lists (the
  branch was rewritten) goes back to the list. Commits are listed for the whole branch, also in a subfolder project.
- **Freshness.** vs base and Commits are read when the mode opens, when the base changes and on **Refresh**. They
  never poll.

### Files

**Files** (the last position of the mode toggle, or the palette's **Review: files**, Story 8.3) browses every file of
the reviewed folder, read-only. It is offered wherever the pane has a folder: a project, a branch with a linked worktree,
or a session (a branch without a worktree has none).

- **The tree** is lazy: the folder's own entries are read when Files opens, and a folder's children the first time it is
  opened (a click on its row, `▸` / `▾`). Folders come first, then names sorted case-insensitively; dotfiles are
  listed. `.git` and the linked worktrees inside the repository are left out. Entries git ignores (`git check-ignore
  --stdin -z`, one call per folder; everything under an ignored folder) are listed dimmed; inside a submodule or a
  nested repository its own ignore rules decide, and its top folder is never dimmed. A folder lists at most 2,000
  entries, then `N more not shown` (entries that could not be read count there too). A name the UI could not send back
  (not UTF-8, control characters, a Windows device name such as `CON` or `aux.txt`) is listed but cannot be opened. A symbolic link (or a junction) is listed as `link` and never followed: it does not
  open as a folder, and a path through it to elsewhere is refused. A folder that cannot be read shows its error in
  place of its children. A folder that is not a git repository lists nothing as ignored.
- **The viewer.** The selected file opens in a read-only CodeMirror view with line numbers and the same language packs
  as the diff. The diff's limits apply: `binary file`, `too large to show` (over 2 MB or 50,000 lines), `not UTF-8
  (shown lossily)`, and CRLF shown as LF. A link shows its target. `submodule` and `unreadable name` are the lines the
  viewer would show for a submodule or an unreadable name. `j` / `k` step through the files of the open folders.
  Switching from Changes to Files keeps the selected file and opens the folders above it.
- **Paths.** The UI sends Rust a path relative to the folder; Rust accepts only plain names (no `..`, no root or drive,
  no control characters, never `.git` (any case on Windows), and on Windows no device names such as `CON`, `NUL`,
  `COM1` or `aux.txt` and no name ending in a dot or a space). It refuses a path inside a linked worktree (`not shown
  in the folder`) and any path that passes through a link, even one pointing inside the folder (`a path through a
  link`), and checks the real location lies inside the folder (7.4's check) before it lists or reads anything.
- **Freshness.** **Refresh** reads every open folder and the open file again. A folder closed and opened again is read
  again. Files never polls.

### Open in editor

`o` (or the palette's **Open in editor**) runs the `external_editor` command of the settings at the selected file and
line, in every mode. Rust finds the file and builds the command; the UI only names the node, the mode, the path it shows
and a line.

- **The line** is the line at the cursor of the view last clicked (a click places it), else the first visible line. A
  line on the old side of the side-by-side diff, or a deleted line of the unified diff, opens the new file at the
  nearest new line (the same place in the changed block, or the line after a deletion). Clicking elsewhere or moving
  the cursor drops a deleted line's mapping. Clicks on the gutters or scrollbars do not place the cursor. With no view
  showing (a binary file, say), line 1. In vs base and Commits the line is the shown commit's, while the file that opens
  is the working copy: when the working copy has changed since, the line may have drifted.
- **The file** is `<folder>/<path>` in Changes and Files. In vs base and Commits it is the file in the branch's linked
  worktree; a branch without one opens the project's folder when that branch is checked out there, and is otherwise
  refused with `this branch is not checked out anywhere`. A file that is not there is refused with `not on disk:
  <path>`, and one whose real location is outside the folder with `outside the reviewed folder`. With no file
  selected (the commit list, a requested path that names no changed file), `o` says `Open in editor: no file
  selected`.
- **The command.** The template is split into arguments (whitespace separates them, double quotes group: `"C:\Program
  Files\Ed\ed.exe" --line {line} {file}`), and `{file}` and `{line}` are replaced in each argument; a template that
  names no `{file}` gets the file as its last argument. A program (the first argument) naming `{file}` or `{line}` is
  refused with `the editor program cannot contain {file} or {line}`: it would run the reviewed file. The program is resolved like "Open in external editor"
  (PATH, with `PATHEXT` on Windows, so `code` finds `code.cmd`) and started detached. The default is `code -g
  {file}:{line}`, set at first run when `code` is on PATH.
- **No editor.** With `external_editor` unset (or blank), `o` shows `No external editor set: add external_editor to
  settings` and opens Settings, also when no file is selected. Any other refusal (the program not found, could not
  start) is the notice.

### Session-touched files

On a session (Story 8.4), the files the session itself edited carry a muted `•` in the Changes tree and in Files (its
tooltip and accessible name: `edited by this session`), so its own edits stand apart from files that were already
dirty.

- **Source.** Rust reads the session's own transcript (`<claude_home>/projects/*/<id>.jsonl`), read-only and
  leniently (a line that is not JSON, or not shaped as expected, is skipped). An assistant record's `tool_use` blocks
  named `Edit`, `Write` or `MultiEdit` give their `input.file_path`, and `NotebookEdit` its `input.notebook_path`.
  Sidechain records in the same file count; separate subagent transcript files are not read. A session with no
  transcript yet has no marks.
- **Keys.** Each absolute path is mapped to the reviewed folder with 7.4's canonical check (links followed, case as
  on disk), and also by its text, so a file named through a link inside the folder keeps that key. A path outside the
  folder, or one that is not absolute on this OS (a `C:\…` path on Linux), is ignored.
- **Freshness.** The marks are read with the list (Changes) or the tree (Files), so **Refresh** and the git poll update
  them in both. Each transcript's scan is kept in memory and resumes where the last one stopped; a transcript that
  shrank or was rewritten (its length, modified time and a fingerprint of its start tell) is read again, and a removed
  session's scan goes.
- **Other targets.** Projects and branches have no marks.

### Line comments

On a session (Story 8.4), **Comment on line** (`c`, the palette, or the toolbar's **Comment** button) opens a one-line
box under the toolbar, `Comment on <file>:<line>`, anchored at the shown file's current line (the line `o` would open:
the cursor of the view last clicked, else the first visible line; line 1 with no view). ctrl+Enter sends; Esc, while
the focus is in the box, closes the box (the pane stays open); Enter alone does nothing, and bare keys (`c`, `o`, `j`,
…) never fire while typing. The text is kept per reviewed node while the box moves to another line, and dropped when
the pane closes. While it sends the box is read-only; a refusal shows under it and the focus returns to it. On a
project or a branch the command is not offered and the button is disabled, titled `comments go to a session`.

- **The line.** Rust builds `Review comment on <path>:<line>: <comment>`, the path relative to the reviewed folder.
  Each run of line breaks becomes one space, control characters and U+2028/U+2029 are stripped, and the line is cut
  to 1,000 characters. An empty comment is refused (`comment is empty`), and so is a path that is not a plain relative
  path inside the folder (checked on its text: no `.` or `..` parts, no control characters, and on Windows no `:` or
  `\`; names are kept as listed, spaces included) or one so long it leaves no room for the comment.
- **Delivery.** The line lands in the session's inbox from `operator`, so the session's `inbox()` returns it (the
  `N new` badge counts it). While the session runs in a Switchboard terminal, the line itself is typed in at its next
  idle, through the same injection slot and draft rule as the peer line and the nudge (one plain line and Enter, never
  over a draft). Comments are typed whatever `peers.nudge` says: that setting governs only the peer-message nudge.
  The generic `You have N messages` nudge never fires for a comment, and comments do not count toward its loop guard.
  Each comment is typed once, oldest first; a failed write is tried again. A session that is not running keeps the
  comment queued in its inbox, and it is typed once the session next runs here and is idle, unless the session read it
  with `inbox()` first. A typed comment leaves the inbox (it counts as read there), so the agent never gets it twice.
- **Limits.** A full inbox (100 messages) drops its oldest peer messages and notices before any comment, and a
  session's comment list (100) drops its oldest typed, read or dropped comments first. A comment that must go anyway is
  `dropped`: it leaves the inbox, is never typed, and shows as such in the list. Other sessions' comments are never
  touched.
- **States.** Under the toolbar the pane lists this session's comments of this app run, oldest first: where, what and
  the state, `queued` (in the inbox, waiting for idle or for the session to run here), `sent` (typed into the
  session), `read` (drained by `inbox()`) or `dropped`. They update live and are never persisted.

## The switchboard MCP server

A session Switchboard starts (New, Resume, Fork) can see the graph it sits in through a `switchboard` MCP
server inside the app. Sessions started elsewhere do not get it, and nothing is written under `~/.claude`.

**Where.** `POST http://127.0.0.1:<port>/mcp` on the hooks endpoint (same port, 127.0.0.1 only). The launch
writes `<session dir>/<uuid>.mcp.json`:

```json
{"mcpServers":{"switchboard":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}
```

and passes it with `--mcp-config`. The token is the session's hooks token: it names the caller (no tool takes an
identity argument) and dies when the session exits.

**Transport.** Streamable HTTP in stateless JSON mode: each POST carries one JSON-RPC message and gets one
`application/json` reply; no SSE stream, no session id. `initialize`, `ping`, `tools/list` and `tools/call` are
answered; notifications get a 202 with no body; any other method is "method not found". Another HTTP method is
405 (`Allow: POST`). A missing, wrong or expired token is a **401 with no body**; an authenticated body over
1 MiB is a 413 and one that does not arrive within 10 s a 408. Each is counted in Diagnostics as an MCP refusal
and closes the connection. A tool that fails unexpectedly is a JSON-RPC internal error (-32603); a panic is
caught that way only in debug builds, as release builds abort on panic. `initialize`
offers `2025-06-18` (or `2025-03-26` when the client asks for it). The `Origin`, `Accept` and
`MCP-Protocol-Version` headers are not checked: the clients are not browsers, and every request needs the
bearer token.

**Read tools.** They never change anything, and the session's settings file allows each one
(`permissions.allow: ["mcp__switchboard__my_node", …]`), so they never ask for permission. Each result is one
`text` item holding compact JSON; an error is `isError: true` with a plain message (an unknown node or
project, or a label two projects share). An unknown tool is such an `isError` result too, by design (the model
reads it), not a protocol error.

| Tool | Returns |
|---|---|
| `my_node()` | `{nodeId, name, path, project{id,label,path}, branch, worktree, cwd, statusText, peers[], addDirs[]}`. `path` is `<project>[:<branch>] / <name>`; `branch` is the branch the session was started on, else the branch of its folder; `worktree` is the linked worktree it runs in, else `null`; `addDirs` are the folders the launch was given (`via` `sheet` or `edge → <target>`) plus context edges applied live (`via` `/add-dir`). |
| `workspace()` | `{projects[{id,label,path,sessions[{nodeId,name,status,lastLine}]}], edges[{id,kind,from,to,label}]}`: live sessions only; names, labels and last lines without control characters and cut to 120 characters; edge ends as `<type>:<id>` (`session:<id>`, `project:<id>`, …). No positions, viewport or historic sessions. It aims to stay under 8 KB: if it would not, the last lines are cut to 40 characters (`lastLinesCut: 40`), then left out (`lastLinesCut: "omitted"`), then the edge labels go too (`truncated: true`). |
| `node(id)` | A project's `{id,label,path,branch}` or a session's `{nodeId,name,status,lastLine,project,branch,statusText}`. An edge end as `workspace()` lists it (`project:<id>`, `session:<id>`) works too; a `branch:` or `folder:` end is an error. |
| `peers()` | `my_node().peers`: `[{nodeId,name,path,purpose}]` for each cooperate edge. |
| `sessions(project)` | The project (by id, else label; a label two projects share is an error naming their ids) and its live and historic sessions: `{nodeId,name,status,lastActive,statusText}`, live first, then newest. `status` is the live state (`busy`, `idle`, …); `exited` for a session that ran this app run and has ended; `historic` for one known only from its transcript. `lastActive` is the newer of the transcript's last record and what the live map saw. |

`statusText` (Story 7.2) is what the session last posted with `set_status`, until its state changes; `null`
otherwise. `my_node()`, `node(id)` and each `sessions(project)` row add `reviewRequested: true` while the session's
card shows the review flag (Story 7.4; left out otherwise).

**Act tools (Story 7.2).** `start_session`, `link` and `unlink` change the workspace, so each waits for the
operator unless a policy covers it; `set_status` never asks. They are **not** in the session's
`permissions.allow`, so Claude Code may also ask its own permission before calling them. Each is checked in full
first: a refusal (an unknown or ambiguous project, a kind mismatch, one of 6.1's link refusals, a branch without a
worktree, `bypassPermissions`, a missing add-dir) is an `isError` with the reason and **no toast**.

| Tool | Does |
|---|---|
| `start_session({project\|branch, prompt?, name?, model?, effort?, permissionMode?, addDirs?, cooperateWithMe?})` | Starts a session the way the launch sheet does: `project` is an id or a label (a shared label is an error); `branch` is `<project id or label>:<branch>` and runs in that branch's worktree (or the project folder for the checked-out branch) -- a branch with no worktree is `branch has no worktree`, and no worktree is ever created. The name defaults to `<label>-<4 hex>`, the choices to the project's last ones, the add-dirs are the project's context-edge folders plus `addDirs`, and `bypassPermissions` is refused. The toast shows the **exact argv** (`claude --session-id … --name … --settings … --mcp-config … --append-system-prompt … <prompt>`); on Allow that argv runs (built again and compared; if anything changed meanwhile, nothing starts), in the background: the card appears, no terminal is focused. With `cooperateWithMe` a cooperate edge between the caller and the new session is stored first, so the new session's prompt names the caller as a peer. Returns `{nodeId, name}`; Deny returns `the operator denied: start a session on <target>`. |
| `link({from, to, kind, label?})` | Ends as `workspace()` lists them (`project:<id>`, `session:<id>`, `branch:<projectId>:<name>`), or `self`. `kind` must be the one the app derives (`cooperate` between two sessions, `context` from a session or project to a project or branch). The toast reads `link <from> → <to> (<kind>) "<label>"`; Allow stores the edge with every 6.1–6.4 effect (live `/add-dir`, peer lines). Returns `{edgeId}`. |
| `unlink({edgeId})` | The toast describes the edge; Allow deletes it as Delete does. An unknown edge is an error. Returns `{edgeId}`. |
| `set_status({text})` | No approval. The text (control characters and U+2028/U+2029 stripped, cut to 120 characters) shows on the session's card in place of branch, count and age until its state changes or the next `set_status`; an empty text clears it. Runtime only. Returns `{statusText}`. |

**Approval toasts.** Pending requests stack at the bottom right, oldest first: who asks, the action, and the
argv or edge in mono, with **Allow**, **Deny** and -- when a stored edge (either kind, either direction) joins
the caller and the target -- **Always for this edge**. The target is the project (or branch) a start goes to,
the end of a link that is not the caller, or the deleted edge's end that is not the caller; a link or unlink with
neither end the caller always asks. The palette's **Allow agent request** / **Deny agent request** answer the
oldest. While Switchboard is not the focused window a new request also sends an OS notification (`<caller>
wants to <action>`), following `notifications.waiting`; clicking it brings the app forward. A request nobody
answers within 120 s is denied (`the operator did not answer`); one whose caller exits, or whose `/mcp` call goes
away (the client timed out or disconnected), is dropped, so a late answer runs nothing. A caller may have at most
3 requests waiting; a fourth is refused with `too many pending requests` and no toast. A start's prompt is at most
8000 characters. The call keeps its HTTP request open meanwhile: the endpoint's 10 s idle timer does not apply to a
connection whose `/mcp` reply is pending, and starts again once the reply is out.

**Policies.** **Always for this edge** sets `agentAllowed: true` on that edge in `workspace.json`, once the act
succeeded (never on the edge an `unlink` deletes; if it cannot be stored, the result's `policyError` says why): acts by the
caller on that target then run without a toast, and the edge inspector shows `Agent actions: always allowed`
with **Revoke** (also the palette's **Revoke agent policy**). It goes with the edge. **Agent actions: allow
all** / **Agent actions: ask** in the palette set the workspace's `agentActions` (`ask` by default, left out of
the file then); while it is `allowAll` Settings says so and no act tool asks. An act that ran without a toast,
either way, shows a one-line notice (`ide-1a2b started ui-3c4d on ui`). Older workspace files load unchanged.

**Not yet verified with the real `claude`:** that a `--mcp-config` HTTP server connects without a trust prompt
(`/mcp` should list `switchboard` as connected), that calling the read tools asks for no permission, whether
Claude Code asks its own permission before an act tool, and that a long wait at the toast does not time out the
tool call on Claude Code's side.

### Peer messages: send and inbox

**Peer tools (Story 7.3).** Two sessions joined by a cooperate edge can message each other through the server.
Neither tool ever asks: the cooperate edge is the permission, and both are in the session's `permissions.allow`
(with the read tools).

| Tool | Does |
|---|---|
| `send({peer, text})` | `peer` is one of the caller's cooperate peers (Story 6.4's rule): its session id or `session:<id>`, else its name as `peers()` gives it, exact first, then ignoring case. No match is `not a peer: <peer>`; two peers with that name are an error naming both node ids. The text keeps its line breaks (U+2028 and U+2029 become line breaks too); every other control character and the bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069) are stripped. A blank text, or one over 4,000 characters once cleaned, is refused. The message lands in the peer's inbox. Returns `{delivered: true, to: "<name>", unread: <the peer's count>}`, plus `running: false` when the peer is not running in a Switchboard terminal (historic, stopped, or in a terminal outside the app): the message waits for it (see below), and `dropped: N` when it pushed N older unread messages out. |
| `inbox()` | The caller's unread messages, oldest first: `[{from, fromNodeId, text, at}]` (`at` in ISO 8601 UTC; a notice is `from: "switchboard"`, `fromNodeId: null`). Each message is returned once: reading clears the inbox and the badge. |

**The inbox.** Rust keeps each session's unread messages in memory, at most 100 (the oldest go first, and the
inbox then starts with a notice from `switchboard`, `N older messages were dropped`). The app quitting drops them
all, and removing a session's ref or its project drops that session's inbox. A session's card shows `N new` on its first line while it has any (see
`docs/DESIGN.md`); `inbox://unread` carries `{sessionId: count}` to the UI. A message to a peer that is not running in a Switchboard
terminal (historic, stopped, or running in a terminal outside the app, which gets no nudge) is kept for it: the inbox survives the session's exit within this app run, and once the
session is resumed it shows the badge and is nudged.

**The nudge** (`peers.nudge`, on by default). When messages land for a session running in a Switchboard terminal,
it is sent one line once it is idle (`idle` or `finished`), with no draft in its prompt, through the same
one-injection-per-session slot as `/add-dir` and the peer line:

```
You have 1 message from "api-1". Call switchboard.inbox.
```

then Enter. With more than one message it reads `You have N messages from "api-1". Call switchboard.inbox.` (one
sender) or `You have N messages from M peers. Call switchboard.inbox.`; the link notice is not counted. The line is
built when it is written, from what is unread then, and nothing is written if the messages were already read. A
busy session is nudged at its next idle, however long that takes (no 60 s give-up); a draft holds the nudge until
an idle with no draft. There is one nudge per arrival of new messages: a later idle with the same unread messages
writes nothing. An arrival counts as nudged only once its line was written, so a failed write is tried again at the
next arrival or resume. With `peers.nudge: false` the badge is all; turning it back on nudges the running sessions
that got messages meanwhile.

**The loop guard.** Two agents answering each other could nudge each other forever, so a session gets at most 20
nudges in any rolling hour. Past that its messages still arrive and its badge still counts, but no nudge is typed,
and a one-line notice says `nudges paused for <name>: 20 in the last hour`. Nudges resume once the hour's count
falls below 20.

**Not yet verified with the real `claude`:** that two linked sessions coordinate through `send` / `inbox` after a
nudge (a manual check, together with Story 6.4's `SendMessage` check).

### Review requests: request_review

**Review tool (Story 7.4).** A session says "this is ready, look here". It never asks the operator (a decision:
it only flags the caller's own card), and it is in the session's `permissions.allow`, so Claude Code does not
prompt either.

| Tool | Does |
|---|---|
| `request_review({summary, paths?})` | `summary` is required: control characters, U+2028/U+2029 and the bidi embeddings, overrides and isolates are stripped, it is trimmed and kept to 500 characters (a longer one is cut there and ends in `…`). `paths` is at most 50 strings, each cleaned the same way. A relative path resolves against the caller's cwd, and `.` and `..` are resolved on the text. Every path must lie within the caller's cwd, its worktree, its project folder or one of its add-dirs (as `my_node().addDirs` lists them), judged by where it really is: the deepest existing part of the path and each of those folders are canonicalised (symlinks and junctions followed), so a link inside the cwd that points elsewhere counts as outside. Any path outside refuses the **whole call** with `outside this session's folders: <paths>` and nothing is flagged. A path that does not exist is accepted and listed as `missing`; a path given twice is listed once. Existence is checked; contents are never read. A request with no paths needs no folder (it works even when the session's cwd is not known). Returns `{flagged: true, paths: N}`. |

**The flag.** The caller's session card shows a plain `review` flag on its first line (beside the `N new` badge;
see `docs/DESIGN.md`) until the operator opens the review or runs **Clear review flag**. A new request from the
same session replaces the summary and paths (one toast, one flag). Rust keeps each session's last request in
memory only: the app quitting drops them, and removing a session's ref or its project drops its request.
`review://requests` carries `{sessionId: request}` to the UI.

**The toast.** A review toast joins the agent approval toasts at the bottom right: `<name> asks for review:
<summary>`, with **Open** and **Dismiss**. It does not wait or expire; Dismiss closes the toast and keeps the
flag. While Switchboard is not the focused window, the request also sends an OS notification `<name> asks for
review` (the summary, cut to 200 characters, as its body), following `notifications.review`; clicking it brings the app forward and opens
the review.

**The Review pane.** Clicking the flag, the toast's **Open**, the notification, or **Open review request** in the
palette (the selected session when it is flagged, else the newest request) opens the [Review](#review) pane on the
session's folder, titled with the session's name, with the request on top: the summary and when it was requested.
The requested paths are listed first in the changed-files tree (relative to the session's folder) and selected in
turn (`j` / `k`); a requested path that names no changed file is marked `unchanged`, or `missing` where nothing is
there (checked again on each open). Opening it clears the flag. A new request from the session whose pane is open
counts as seen: the pane shows it and no flag or toast rises.

**Opening and clearing are tied to what the operator saw.** The UI names the request it showed (`review_open` /
`review_clear` take the session id and the request's `seq`). If the session asked again meanwhile, opening is
refused with `the review request was replaced; open the new one` and clearing does nothing, so a replacement the
operator never saw keeps its flag. Either call for a session with no request is refused with `no review request
for this session` (the notice says so).

**Not yet verified with the real `claude`:** that a session asked to request review when done calls the tool
without a permission prompt, and that the flag, toast, notification and pane all appear.

## Tray and closing the window

Switchboard puts an icon in the system tray for as long as it runs: the app icon, with the tooltip
`Switchboard — 2 busy · 1 waiting` (or `Switchboard — no live sessions`). **Busy** counts sessions that are
`busy` or `starting`; **waiting** counts the ones that need you, `waiting` or `finished`. The counts follow the
live sessions as they change. A left click on the icon brings the window back (un-minimised, shown, focused).
Its menu holds **Show Switchboard**, a greyed-out line with the same counts, and **Quit**, which exits exactly as
`ctrl+q` does. On Linux the tray reports no clicks and shows no tooltip: use the menu's Show and read its counts
line.

**Closing the window.** By default (`close_to_tray: false`) closing the main window quits, as it always did.
With `close_to_tray: true`, closing the main window (its × button, Alt+F4) only hides it: sessions, terminals
and pop-out windows keep running. On **Linux** it is minimized instead of hidden, so it stays in the taskbar (an
indicator can load with no tray host to show it, and a hidden window could then never come back). The first
time in each run, one OS notification says `Switchboard is still running in the tray` (with
`notifications.tray` on and notifications allowed by the OS); clicking it brings the window back. Bring the
window back from the tray icon, or by starting Switchboard again (the second launch shows the running one). If
the window cannot be hidden, the close goes ahead and quits. **Quit** (`ctrl+q`, the tray menu or the palette) always exits and stops every
session and terminal; there is no confirmation.

**No tray.** Where the tray icon cannot be created, closing the window always quits, whatever the setting says,
because a hidden window could not be brought back. On Linux the tray is not tried at all unless the
appindicator library (`libayatana-appindicator3` or `libappindicator3`) is found through `ldconfig -p`,
`LD_LIBRARY_PATH` or the usual library folders. A banner says `tray unavailable: closing the window quits`. The `.deb` depends on `libayatana-appindicator3-1` for the
icon.

## Performance

The budgets (cold start to an interactive canvas under 1 s, idle RSS of the app's own share under 150 MB not counting `claude`,
added typing latency under 16 ms), how they are measured and the measured results are in
[`docs/perf.md`](docs/perf.md). Settings (`ctrl+,`) → Diagnostics → **Performance** shows the app's own
measuring points: `startup: N ms` (process start to the first canvas frame) and `typing: median N ms · p95 M ms`
over the last 100 keystrokes in a terminal (`not enough samples` below 5). They are always on, memory only and
never sent anywhere. [`scripts/perf/measure.ps1`](scripts/perf/measure.ps1) repeats the measurement on Windows.

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
| `worktrees_root` | `null` | Root for app-made worktrees; `null` means `<repo>/.worktrees/<branch>`, an absolute path `<root>/<repo folder>/<branch>` (see [Worktrees](#worktrees)). Affects only worktrees created afterwards. |
| `external_editor` | `"code -g {file}:{line}"` when `code` is on PATH, else `null` | Command template for "open in editor". The Review pane's `o` (see [Open in editor](#open-in-editor)) splits it into arguments (double quotes group) and fills `{file}` and `{line}` in each; "Open in external editor" on a project card runs only the **first token** with the project folder as its single argument. A path with spaces must be quoted (`"C:\Program Files\…\code.cmd" -g {file}:{line}`). A bare name is resolved like binary detection (PATH, with `PATHEXT` on Windows, so `code` finds `code.cmd`); a path (or `~/…`) is used as given. A `.cmd`/`.bat` runs through `cmd.exe` without a console window; the child is detached, never waited on. `null` makes the action a notice (and `o` opens Settings). |
| `shell` | Windows: `"pwsh"` if present, else `"powershell"`; Linux: `$SHELL` (`null` when unset) | Shell for plain terminals. |
| `theme` | `"dark"` | UI theme. Reserved; not applied yet (the UI is dark-only). |
| `poll.agents_ms` | `2000` | `claude agents --json --all` poll interval (live sessions); floor 500 ms. |
| `poll.git_ms` | `5000` | Git status poll interval. |
| `notifications.finished` | `true` | Send an OS toast when a session finishes its turn while the window is unfocused (see [Needs you](#needs-you)). |
| `notifications.waiting` | `true` | Same for a session waiting for input (hooks, Story 4.3). |
| `notifications.review` | `true` | Send an OS toast when a session asks for review (`request_review`) while the window is unfocused; clicking it opens the review (see [Review requests](#review-requests-request_review)). |
| `close_to_tray` | `false` | `true`: closing the main window hides it to the tray (minimizes it on Linux) and sessions keep running; `false`: closing quits (see [Tray and closing the window](#tray-and-closing-the-window)). Read at close time, so a saved edit applies at once. Without a tray, closing always quits. |
| `notifications.tray` | `true` | Send the one OS toast `Switchboard is still running in the tray` the first time in a run the window is closed to the tray. |
| `peers.nudge` | `true` | Nudge a session that has new peer messages with one injected line once it is idle (see [Peer messages](#peer-messages-send-and-inbox)); `false` shows the `N new` badge only. Review line comments (see [Line comments](#line-comments)) are typed either way. |

Binary detection: `claude` is searched on PATH, then `~/.local/bin`; `git` on PATH. Each one found is run
with `--version` (5 s timeout) and its version recorded. A configured `*.path` may be absolute, start with
`~/`, or be a bare name (then it is looked up on PATH). Problems are non-blocking banners at the top of the
window, never a crash: `claude` missing (banner lists the searched directories), a configured path that does
not exist, or a `--version` that fails.

On Windows only, `claude` is never run through a batch file (see [Starting sessions](#starting-sessions)).
The search accepts only a native `claude.exe` / `claude.com` (a `claude.ps1` or other `PATHEXT` entry does not
count), so a native one anywhere on PATH or in `~/.local/bin` wins over an earlier `claude.cmd`. When a
`.cmd` / `.bat` is all there is, `claude` is reported as not found, the file is never run (not even for
`--version`), and the banner names its full path: `<path>\claude.cmd (npm shim) found — install the native
claude.exe` (any other batch file reads `(a batch file)` instead of `(npm shim)`). The same applies when
`claude.path` is set to a batch file, by bare name or by path; if a native `claude.exe` is also on the search,
the banner instead reads `claude.path names the npm shim; clear it to use claude.exe`. Starting a session
then fails with that banner's text. First launch never writes a batch file into `claude.path`. `git` is not
affected, and on Linux a file named `claude.cmd` is just a file.

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
