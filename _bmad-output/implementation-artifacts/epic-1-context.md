# Epic 1 Context: Shell that runs on both platforms

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Stand up the Tauri 2 desktop shell for Switchboard: a Rust core with a React web UI that opens fast, remembers its window state, finds the `claude` and `git` binaries, exposes a settings file plus a command palette, and builds and tests on both Windows and Linux from one tree with CI from day one. No product features (canvas, sessions, terminals) land here; every later epic stands on this foundation, so the point is getting the platform plumbing, repo layout and dev loop right rather than anything visible.

## Stories

- Story 1.1: Scaffold and dev loop
- Story 1.2: Linux build in CI
- Story 1.3: Settings and app paths
- Story 1.4: Single instance, window state, palette skeleton

## Requirements & Constraints

- Targets Windows 11 x64 and Linux x64 (X11 and Wayland). Installers are NSIS/MSI on Windows and AppImage plus .deb on Linux, all via the Tauri bundler.
- The app is single-instance: a second launch focuses the existing window instead of opening another.
- Settings live in a human-editable JSON file in the platform config dir, with a minimal settings pane. Settings cover: claude binary path (auto-detected), default model/effort/permission mode, worktrees root, external editor command, theme, poll intervals. Edits on disk are picked up live via fs watch; a parse error surfaces as a banner naming the line, not a crash.
- Binary detection: `claude` is searched on PATH, then `~/.local/bin`; `git` on PATH. Versions are recorded. A missing `claude` is a non-blocking banner showing the search path.
- Performance budget that the shell must not compromise: cold start to interactive under 1 s on the dev machine (under 2 s on a cold Linux laptop); idle RSS under 150 MB with a populated workspace later. Keep the bundle small from the start; no heavy UI/component libraries.
- No menu bar. Every action is a registered command reachable from the `ctrl+k` palette; later every command gets a keybinding or is bindable.
- No telemetry and no network calls other than what `claude` makes and localhost endpoints added in later epics.
- The app never writes into `~/.claude`; settings and app data go in the app's own config dir only.
- Degrade gracefully when the Claude CLI is missing or a different version: show a banner, never fail fatally.
- Dev environment is Rust 1.94 and Node 25; Claude Code CLI 2.1.x is the only agent runtime.

## Technical Decisions

- **Shell:** Tauri 2. Rust core on tokio; UI in the OS webview (WebView2 on Windows, webkit2gtk 4.1 on Linux). Chosen for small binary, low idle RAM, and because PTYs, process supervision, git and HTTP servers belong in Rust.
- **Frontend:** React 19 + TypeScript + Vite. State with Zustand. No component library; the app builds its own dozen primitives. Theme via CSS variables, dark default, one accent colour.
- **Rust is the source of truth.** Tauri IPC commands are thin: validate, then delegate to a module. Long-lived state lives in an `AppState` behind `tokio::sync::RwLock` / channels; changes are pushed to the webview via `app.emit` events (e.g. a `workspace://changed` convention).
- **Rust module layout** under `src-tauri/src/`: `main.rs`, `lib.rs`, `graph/`, `claude/`, `pty/`, `git/`, `mcp/`, `approvals/`, `settings/`, `ipc/`. Epic 1 populates `settings/` and `ipc/` for real and may leave the others as stubs. `settings/` owns the settings JSON, binary detection and platform paths (`dirs` crate).
- **Frontend layout** under `src/`: `state/` (Zustand stores), `canvas/`, `terminal/`, `review/`, `palette/`, `theme/`. Epic 1 needs `state/`, `palette/` and `theme/`; others may be placeholders.
- **Command palette** is a command registry (id, title, keybinding, when-clause). Every action is registered there first; menus and buttons call the same commands. Epic 1 ships the skeleton with at least "Open settings" and "Quit".
- **Persistence:** one JSON settings file and (later) one JSON workspace file, schema-versioned, written atomically (write temp then rename). Platform paths: `%APPDATA%\switchboard\` on Windows, `$XDG_CONFIG_HOME/switchboard/` on Linux.
- **Plugins:** `tauri-plugin-single-instance` for single-instance behaviour; `tauri-plugin-opener` for external opens (used later). Window state should be restored on reopen.
- **Repo layout:** `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` at root; `src/`; `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `capabilities/`; `docs/` for project knowledge; `_bmad-output/` for planning and implementation artifacts. BMAD is installed with `project_name = switchboard`.
- **Testing:** `cargo test` for Rust modules (fixture-based tests for parsers), `vitest` for store and logic. No Playwright in v1; UI is checked by hand.
- **CI:** GitHub Actions. `ubuntu-latest` installs webkit2gtk-4.1 and related deps, runs `cargo test`, `vitest`, and builds AppImage + .deb; `windows-latest` does the same producing NSIS + MSI. Both upload artefacts.

## UX & Interaction Patterns

- Dark background by default, no menu bar, no devtools open on launch, window titled "Switchboard".
- Low chrome: 1-px borders, monochrome icons, a single accent colour reserved for attention states. No gradients, no cards-within-cards. One UI sans and one monospace font, system-available or bundled once.
- Status and errors are ambient: banners and toasts, not modals. The missing-`claude` and settings-parse-error states are non-blocking banners.
- Keyboard-first: `ctrl+k` opens the palette; it filters as you type, runs on Enter, closes on Esc. Esc closes panes generally.
- Panes (settings here; terminal/review later) slide in from the right and dismiss with Esc. The canvas (Epic 2) will be the home screen, so the shell should not introduce a welcome page, sidebar tree or tab row.

## Cross-Story Dependencies

- Story 1.1 (scaffold) is the base for all other stories in this and every later epic; 1.2 (CI) builds on 1.1's test placeholders.
- Story 1.3's settings module supplies defaults consumed by the launch sheet (Epic 4), worktrees root (Epic 5), external editor (Epic 8) and poll intervals (Epic 3); its binary detection also feeds the first-run banner in Epic 9.
- Story 1.4's command registry is the backbone for every later action (Epic 2 context menus, Epic 9 keybinding audit); window-state persistence sets the pattern Epic 2 reuses for viewport persistence.
- Epic 9 (installers, performance budget) verifies what Epic 1 sets up; CI artefacts from 1.2 are what 9.1 installs on a clean machine.
