# Switchboard (working title)

![ci](https://github.com/EmilsRLV/switchboard/actions/workflows/ci.yml/badge.svg?branch=master)

A small desktop app for Windows and Linux whose main surface is a **graph of projects, Claude Code
sessions and branches**. It starts, watches, connects and reviews Claude Code sessions. It is not a
text editor.

Status: **Epic 1 in progress**. The Tauri 2 shell (Rust core, React 19 + TypeScript + Vite UI) builds
and tests on Windows and Linux (CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)); no product
features yet.

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
| `ctrl+,` | Open (toggle) the settings pane. |
| `ctrl+q` | Quit. |
| Esc | Closes the palette if it is open, else the settings pane. With both open, the first Esc closes the palette, the second the pane. |

The palette lists five commands: Toggle command palette, Open settings, Reveal settings file (only when the
file's location is known), Re-detect binaries (not while one runs) and Quit; the key-only carriers (the
`ctrl+,` toggle and the two Esc commands) are registered but hidden from the list. Keybindings are not
editable yet (Epic 9).

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
| `external_editor` | `"code -g {file}:{line}"` when `code` is on PATH, else `null` | Command template for "open in editor". |
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
commands, `state/` holds Zustand stores, `theme/` the CSS variables),
`src-tauri/` the Rust core (`src/ipc/` holds the thin Tauri commands; other modules arrive with their stories).

Stories are specced one at a time into `_bmad-output/implementation-artifacts/spec-<epic>-<story>-*.md`
in the same shape as `map-maker`'s specs (Intent / Boundaries / I-O matrix / Code Map / Tasks).
