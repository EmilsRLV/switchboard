# Epic 9 Context: Ship it

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make Switchboard something you can install on a second machine and live with every day. That means Windows and Linux installers that start cleanly, a tray icon with close-to-tray so sessions survive closing the window, a performance budget that is measured and met, and a complete keyboard story: every action is in the palette and every palette action can be bound to a key. This is the last v1 epic. It turns the feature-complete tool from Epics 1–8 into the light, keyboard-first desktop app the product promised.

## Stories

- Story 9.1: Installers and first-run
- Story 9.2: Tray and close-to-tray
- Story 9.3: Performance budget
- Story 9.4: Keybindings and palette completeness

## Requirements & Constraints

- **Platforms and packages:** Windows 11 x64 ships as NSIS and MSI. Linux x64 ships as AppImage and .deb and must work on both X11 and Wayland. All four come from the Tauri bundler in CI.
- **Clean first run:** a fresh install with `claude` present detects the binary and opens on the empty canvas with an "Add project" hint. With `claude` absent, the app shows the existing non-blocking missing-binary banner (the one listing the search path) and must not crash. `claude` is looked up on PATH, then `~/.local/bin`. The app also detects `git`. (Story 9.1 decided `curl` is not needed: the hooks are Claude Code `http` hooks, so nothing calls `curl`.)
- **Tray:** the tray icon summarises live sessions with busy/waiting counts. Close-to-tray is an option, not the default. With it on, closing the window leaves sessions and their PTYs running, and clicking the tray icon restores the window.
- **Performance budgets (measured on the dev machine with 5 projects and 3 live sessions with terminals open):**
  - Cold start to an interactive canvas: under 1 s, and under 2 s on a cold Linux laptop.
  - Idle RSS: under 150 MB, not counting the `claude` processes.
  - Added terminal typing latency: under 16 ms, so typing feels like a native terminal.
  - Record the results and the measurement method in `docs/perf.md`.
- **Keyboard completeness:** everything the UI can do, the palette can do, and everything the palette can do has a keybinding or can be bound. There is no menu bar. Required canvas keys: arrows move the selection, Enter opens, `n` starts a new session, `e` starts an edge, `/` opens the palette, Esc closes panes, and `ctrl+k` also opens the palette. A user `keybindings.json` overrides the defaults. Keybinding conflicts are reported in settings → diagnostics.
- **Still in force:** no telemetry and no network calls besides `claude`'s own and the localhost MCP/hooks endpoints. The app never writes into `~/.claude`.
- **Out of scope for this epic:** auto-update, macOS and multiple workspaces (all deferred).

## Technical Decisions

- **Shell:** Tauri 2 with a Rust core and the OS webview (WebView2 on Windows, webkit2gtk 4.1 on Linux). It was chosen to meet the start-time and memory budgets. If they are missed, fix bundle size and lazy loading before questioning the stack.
- **Avoiding bundle creep:**
  - CodeMirror is used instead of Monaco.
  - The review pane and language packs are lazy-loaded.
  - Bundle size is measured in CI.
  - Terminals stay mounted (hidden with `display:none`) instead of re-rendering.
  - xterm uses the WebGL addon with a canvas fallback, because webkit2gtk may lack WebGL.
- **Single instance:** `tauri-plugin-single-instance` is already in place. Tray restore and second-launch focus should both bring back the same window.
- **Command registry (frontend `palette/`):** each command has an id, title, keybinding and when-clause. Every action is registered there first, and menus, buttons and context menus call the same commands. The 9.4 audit checks UI entry points against this registry.
- **Paths and state:**
  - Settings and workspace live as JSON files under `%APPDATA%\switchboard\` on Windows and `$XDG_CONFIG_HOME/switchboard/` on Linux.
  - Writes are atomic and the files are schema-versioned.
  - `settings.json` is hot-reloaded through an fs watch. `keybindings.json` should follow the same pattern.
  - Live session state is never persisted.
- **CI:** `.github/workflows/*.yml` builds NSIS/MSI on `windows-latest` and AppImage/deb on `ubuntu-24.04`, runs `cargo test` and `vitest`, and uploads artifacts with 7-day retention. GitHub Actions is suspended until the end of the month (monthly limit). Stories 6.4–8.4 were closed on local Windows verification and still need Linux CI (tracked in `deferred-work.md`). Anything in 9.1 that depends on CI-built installers or Linux runs has to either wait for Actions or be recorded as a deferred check.

## UX & Interaction Patterns

- **The canvas is the home screen:** no welcome page or sidebar. The first-run hint is a light pointer on the empty canvas, not a wizard or modal.
- **Status is ambient:** tray counts and tooltips are plain text. Nothing in this epic adds modals.
- **Low chrome:** use 1-px borders, monochrome icons and a single accent colour for attention states only. The tray icon should follow the same monochrome style.
- **Diagnostics:** settings → diagnostics, which already exists for debug counters and rejected requests, is where keybinding conflicts appear.

## Cross-Story Dependencies

- 9.1 builds on the Epic 1 CI pipeline, binary detection and the missing-`claude` banner. It needs the CI artifacts, which are blocked until Actions resumes.
- 9.2 builds on the live session table and status machine from Epics 3–4. Closing the window must not tear down PTYs.
- 9.3 needs every feature in place (Epics 1–8). Running it after 9.2 means the tray's overhead is included in the measurement.
- 9.4 audits every command added in Epics 1–8, plus anything 9.1 and 9.2 add (for example a close-to-tray toggle or "Show window"). Run it last, or re-run the audit after the other stories land.
