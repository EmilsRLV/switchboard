---
title: 'Story 1.3: Settings and app paths'
type: 'feature'
created: '2026-10-16'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'ffb9566f6a7f924a24a9b170d9f19a1f5e125b1f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The app has no idea where `claude` and `git` are, no place to keep preferences, and no way to tell the operator when something it depends on is missing. Every later epic (launch sheet, worktrees, review, polling) reads from a settings module that does not exist yet.

**Approach:** A Rust `settings/` module that owns one human-editable `settings.json` in the platform config dir (`%APPDATA%\switchboard\` / `$XDG_CONFIG_HOME/switchboard/`), written with defaults on first launch, reloaded live when edited on disk, and surfaced to the UI as a snapshot plus zero or more **banners** (missing `claude`, parse error naming the line). Binary detection records path and version for `claude` (PATH, then `~/.local/bin`) and `git` (PATH). A read-only settings pane (`ctrl+,`, Esc closes) shows the effective settings, the detected binaries and the file path with a "reveal file" action — the JSON file is the editing surface.

**Decisions (recorded):** config dir is `dirs::config_dir().join("switchboard")`, not Tauri's identifier-based `app_config_dir`; file schema is versioned (`"version": 1`) and tolerant (`#[serde(default)]`, unknown keys ignored); atomic writes (temp + rename); `notify` 8 watches the config **directory** and filters on the file name (editors replace files) with a 250 ms debounce; the pane is read-only; `tauri-plugin-opener` 2 returns for `reveal_item_in_dir`; default external editor is `code -g {file}:{line}` when `code` is on PATH else unset; default plain-terminal shell is `pwsh` → `powershell` on Windows, `$SHELL` on Linux (recorded, used by Epic 4); Rust state lives in `AppState { settings: RwLock<SettingsState> }` managed by Tauri, changes pushed with `app.emit("settings://changed", snapshot)`.

## Boundaries & Constraints

**Always:** Never write under `~/.claude`. Detection runs `<bin> --version` with a 5 s timeout and never blocks the UI (spawn via `tauri::async_runtime`). A parse error keeps the **last good** settings in force and shows a banner with `file:line:col` and the serde message. First launch writes the full default file (all keys present, so the operator sees what can be changed). Banners are ambient (top strip, dismiss on fix, no modal). Settings snapshot sent to the UI includes `path`, `settings`, `binaries`, `banners`.

**Never:** No settings editing UI, no form controls, no palette (1.4), no single-instance (1.4). Do not read Claude's own `settings.json`. Do not add `tauri-plugin-store` or any state library. Do not spawn `claude` for anything other than `--version`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| First launch | no config dir | dir + `settings.json` created with defaults; `claude.path` filled from detection; snapshot emitted; no banner when both binaries found | create failure → banner "cannot write settings: <err>", in-memory defaults used |
| Normal launch | valid file | parsed, missing keys defaulted, unknown keys ignored, file **not** rewritten | — |
| Edit on disk | operator saves valid JSON | within 1 s: snapshot re-emitted, pane updates, no restart | — |
| Broken edit | `{ "theme": }` saved | banner `settings.json:3:12 expected value` (serde line/col), previous settings stay active; fixing the file clears the banner | — |
| `claude` missing | not on PATH nor `~/.local/bin` | banner "claude not found — searched: <PATH entries>, <~/.local/bin>"; app otherwise fully usable | — |
| `claude` path set but wrong | `claude.path` points to a non-existent file | banner names the configured path and says detection was skipped because it is set | — |
| `--version` hangs/fails | binary exists, exits non-zero or times out | binary recorded with `version: null`, banner "could not read version of <path>" | — |
| Version parsing | `2.1.301 (Claude Code)` / `git version 2.43.0.windows.1` | `"2.1.301"` / `"2.43.0.windows.1"` | unparseable → raw stdout trimmed |
| Pane | `ctrl+,` | right pane with path, binaries (path + version or "not found"), effective settings as a read-only tree; Esc closes; "Reveal file" opens the folder with the file selected | — |

</frozen-after-approval>

## Code Map

- `src-tauri/src/lib.rs` -- `with_commands<R>()` registers commands; add `.manage(AppState)` and the `settings_*` commands; `builder()` adds `.plugin(tauri_plugin_opener::init())` and a `.setup()` that loads settings, runs detection and starts the watcher. Keep the mock test passing (the mock runtime needs the same `.manage`).
- `src-tauri/src/ipc/mod.rs` -- `app_info` pattern: thin command + unit test. Add `settings_get`, `settings_reveal`, `binaries_redetect` here, delegating to `settings/`.
- `src-tauri/Cargo.toml` -- add `dirs = "7"` (already in lock via tauri), `notify = "8"`, `thiserror = "2"`, `tauri-plugin-opener = "2"`, `tempfile = "3"`; `tokio` features `sync` only if `tauri::async_runtime` does not suffice.
- `src-tauri/capabilities/default.json` -- add `opener:allow-reveal-item-in-dir`.
- `src/App.tsx` -- placeholder that renders name+version; becomes the shell: `<Banners/>` strip at top, content area, `<SettingsPane/>` on the right when open. Keep the `app_info` display inside the content area for now.
- `src/ipc/index.ts` -- `Commands` map + `call()`; add `settings_get`, `settings_reveal`, `binaries_redetect` and a `listen()` helper around `@tauri-apps/api/event` for `settings://changed`.
- `src/state/app.ts`, `src/state/app.test.ts` -- Zustand pattern to copy for `src/state/settings.ts` (snapshot, `applySnapshot`, `paneOpen`, `togglePane`) with tests.
- `src/theme/tokens.css` -- `--accent` is the attention colour for banners; add `--warn` only if needed.
- `package.json` -- add `@tauri-apps/plugin-opener` 2.7.2 (JS side needed only if the frontend calls opener directly; prefer calling our Rust `settings_reveal` and skip the JS package).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/settings/mod.rs` -- `Settings` (serde, `#[serde(default)]`, `version`, `claude.path`, `git.path`, `defaults{model,effort,permission_mode}`, `worktrees_root`, `external_editor`, `shell`, `theme`, `poll{agents_ms,git_ms}`), `Default` with architecture §7 values, `SettingsState`, `Snapshot`, `Banner{id,text}` -- the schema everything else reads
- [x] `src-tauri/src/settings/paths.rs` -- `config_dir()`, `settings_path()` via `dirs`; cfg-tests for both OS shapes -- platform paths
- [x] `src-tauri/src/settings/store.rs` -- `load_or_init()`, `parse(&str) -> Result<Settings, ParseError{line,col,msg}>`, `write_atomic()`; tests: defaults round-trip, missing keys defaulted, unknown key ignored, parse error line/col -- persistence
- [x] `src-tauri/src/settings/detect.rs` -- `detect(name, extra_dirs, runner)` searching PATH then extras, `parse_version(name, stdout)`; tests with a fake runner and fixture outputs for claude/git -- binary detection
- [x] `src-tauri/src/settings/watch.rs` -- `notify` recommended watcher on the config dir, debounce 250 ms, filter `settings.json`, reload → emit `settings://changed` -- live reload
- [x] `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `Cargo.toml`, `capabilities/default.json` -- commands, `AppState`, setup, opener plugin + permission; mock test still green -- wiring
- [x] `src/ipc/index.ts` -- typed `SettingsSnapshot`, three commands, `onSettingsChanged(cb)` -- IPC surface
- [x] `src/state/settings.ts`, `src/state/settings.test.ts` -- store + tests (snapshot apply, pane toggle, banner list derived) -- frontend state
- [x] `src/components/Banners.tsx`, `src/components/SettingsPane.tsx`, `src/App.tsx` -- top strip, right pane (`ctrl+,` toggles, Esc closes), read-only tree, "Reveal file" → `settings_reveal`; styled from tokens only -- UI
- [x] `README.md` -- "Settings" section: file location per OS, keys with defaults, live reload -- docs

**Acceptance Criteria:**
- Given a machine with no config dir, when the app starts, then `settings.json` exists in the platform config dir with every key present, `claude.path` points at the detected binary, and no banner is shown.
- Given the running app, when I edit `settings.json` to break the JSON and save, then within 1 s a banner names the file, line and column; when I fix it, the banner disappears and the pane shows the new values — all without restarting.
- Given `claude` renamed away, when the app starts, then a banner lists the searched locations and the window is otherwise normal; `cargo test` and `npm test` cover the matrix rows that are testable without a GUI (parsing, paths, detection order, version parsing, store).

## Implementation Notes

- Orchestrator GUI run (2026-10-16, pass 1): drove `npm run tauri dev` through first launch → broken JSON → bogus `claude.path` → `ctrl+,` → fix → Esc, screenshotting each state. Verified: first launch writes the full file with `claude.path` pinned, `external_editor = code -g {file}:{line}`, `shell = powershell`; no banner; pane renders path / binaries / tree; `ctrl+,` opens, Esc closes; last-good settings stay in force under a parse banner (pane still showed claude 2.1.301). Found: every file written with a UTF-8 BOM failed with `settings.json:1:1 expected value` (triage O1). RSS 27 MB.
- Orchestrator GUI run (pass 2, after patches): broken file without BOM → `settings.json:3:12 expected value`; valid file **with** BOM and `claude.path = C:\nope.exe` → configured-missing banner, pane row `C:\nope.exe (configured, does not exist)`; fix → no banner, claude re-detected `2.1.301`; `ctrl+,`/Esc work. Full verification after patches: vitest 3 files / 18 passed, `tsc` clean, `cargo test` 72 passed, clippy 0 warnings, debug build OK.

- 2026-10-16: defaults not fixed by architecture §7 (which only names the shell) were chosen as: `defaults.model` / `defaults.effort` `null` (leave to `claude`), `defaults.permission_mode` `"default"` (the CLI's own name for its default mode), `worktrees_root` `null` (= `<repo>/.worktrees/`, FR-BRANCH-2), `theme` `"dark"`, `poll.agents_ms` 2000 (NFR-4's "default 2 s"), `poll.git_ms` 5000. All recorded in the README key table and asserted by `settings::tests::defaults_match_the_recorded_decisions`.
- `Settings::default()` is static (no IO); `Settings::for_machine(&Search)` layers the machine-dependent first-launch values on top: detected `claude.path`, `shell` (`pwsh` → `powershell` on Windows, `$SHELL` elsewhere), `external_editor` = `code -g {file}:{line}` when `code` is on PATH. `git.path` is deliberately **not** pinned on first launch (stays `null`, re-detected every launch) -- the matrix only asks for `claude.path`, and pinning git would skip detection for a binary nothing in this story reads from settings.
- `AppState` holds `settings: RwLock<SettingsState>` (`std::sync`, not tokio: every lock is held for a few field copies and never across an `.await`, so the spec's "tokio only if `tauri::async_runtime` does not suffice" held) plus a `watcher: Mutex<Option<RecommendedWatcher>>` field that only keeps the `notify` watcher alive. `with_commands<R>()` does the `.manage(AppState::default())` so the mock runtime has the same state; `settings::initialise` (in `builder().setup`) fills it: fast fs work inline (locate binaries, `load_or_init`, start watcher, emit), then `--version` probing via `tauri::async_runtime::spawn` → `spawn_blocking`. Until that lands the snapshot reports both binaries with `status: "pending"` (the UI shows "detecting…"), avoiding a false "not found" flash.
- `detect.rs`: the spec's `detect(name, extra_dirs, runner)` became `detect(name, &Search, runner)` where `Search { path_dirs, extra_dirs, extensions }` is built by `Search::from_env(extra_dirs)` in production and by hand in tests, so PATH order is testable without touching the process environment (edition 2024 makes `set_var` unsafe). Windows tries every `PATHEXT` extension (needed: `code` is `code.cmd` here). `resolve(name, configured, ..)` dispatches to `detect_configured` when `<bin>.path` is set. `ProcessRunner` drains stdout/stderr on threads, polls `try_wait` against a 5 s deadline, kills on timeout, and sets `CREATE_NO_WINDOW` so no console flashes from the GUI process. `RunError` is `thiserror` 2 and its `Display` is what the "could not read version of <path>: …" banner carries.
- Reload (`settings::reload`) re-runs detection only when `claude.path`/`git.path` changed between the last good settings and the new ones (so the manual check "set `claude.path` to `C:\\nope.exe` → banner" works live without spawning processes on every unrelated save). The pane has a "Re-detect" button bound to `binaries_redetect` for the "I just installed claude" case; it is an action, not an editing control, so the pane stays read-only.
- A deleted `settings.json` while running is treated as an editor's intermediate step (keep last good, no banner); re-creating it reloads. Not in the matrix; recorded here.
- `serde_json` moved from dev- to runtime dependencies (the store needs it). `tauri-plugin-opener` 2.7.2 is called from Rust (`app.opener().reveal_item_in_dir`), so `@tauri-apps/plugin-opener` was not added to `package.json` as the Code Map preferred; `opener:allow-reveal-item-in-dir` is in the capability anyway as the spec lists it. Lock additions: `notify` 8.2.0, `tempfile` 3.27.0, `thiserror` 2.0.21 (already present via tauri), `dirs` 7.0.0 (already present).
- Verified 2026-10-16 (Windows): `cargo test` 48 passed (45 new; includes a real-`notify` test that writes a temp `settings.json` and asserts the callback fires after the 250 ms debounce and under 1 s, and a real `git --version` probe); `cargo clippy --all-targets` clean; `npm test` 3 files / 16 passed (7 existing + 9 store tests); `npx tsc --noEmit` clean; `npm run tauri build -- --debug --no-bundle` built `switchboard.exe` (14.4 MB). Live: launched the debug exe with no `%APPDATA%\switchboard`; after 5 s the dir held exactly `settings.json` (no temp file) with all nine keys, `claude.path` = `C:\Users\emils\.local\bin\claude.exe`, `external_editor` = `code -g {file}:{line}`, `shell` = `powershell` (no `pwsh` on this machine); overwrote it with `{ "theme": }` → process alive 2 s later; overwrote with valid JSON setting `claude.path` to `C:\nope.exe` → still alive and the file was not rewritten; stopped the process and removed the dir so the operator's first `tauri dev` still exercises first launch. Not observed from the CLI: the banner strip and pane rendering, `ctrl+,`/Esc, and "Reveal file" selecting the file in Explorer -- the spec's manual checks remain for a human run.

- Review patch pass (2026-10-16): `store::parse` strips a UTF-8 BOM (seen live from PowerShell `-Encoding utf8`); `store::validate` reports `version > 1` (`settings.version`) and replaces 0 poll intervals (`settings.poll`), run after every good parse; `initialise` split into `initialise_at(app, path, search)` (loading only, seeded from `Settings::default()` so a failed read never makes a detected path look configured) plus the watcher/emit/redetect tail; `reload` returns `bool` and no longer spawns (the watcher closure does); read errors use `settings.read` and are retried 3× / 100 ms; watcher failure → `settings.watch` banner; `redetect` guarded by an `AtomicU64` generation and marks both binaries `version_failed` if the blocking task fails; `detect_configured` expands `~/`, searches a bare name on PATH (still `configured: true`), `Search::from_env` drops relative PATH entries, Unix `locate` requires an exec bit, empty `--version` output → `version: null`, `RunError::Wait` reaps the child; `watch::is_relevant` honours `need_rescan()`; `settings_reveal` opens the folder when the file is gone; `for_machine` locates `code` PATH-only. Capability `opener:allow-reveal-item-in-dir` removed: in tauri-plugin-opener 2.7.2 `Opener::reveal_item_in_dir` (lib.rs) calls the free function directly, only `commands::reveal_item_in_dir` is ACL-gated, and the app calls the Rust API. Frontend: `event.repeat` ignored, pane focuses Close and restores focus on unmount, `loadError` in the store shown instead of an endless wait, stale `settings_get` result never overwrites an earlier event. Tests: 72 Rust (`initialise_at`/`reload` via the mock app + tempdir, fixture `.cmd`/`sh` scripts for timeout and exit 3, BOM, validate, full snapshot JSON, wire-name `settings_reveal`/`binaries_redetect`), 11 store tests; watcher test timings relaxed for CI.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-16) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG); orchestrator GUI run (O).

- O1 `store::parse` — a UTF-8 BOM (written by Windows PowerShell `-Encoding utf8` and Notepad) is rejected as `settings.json:1:1 expected value`; seen live in shots 2/3/5 — **high** (the editing surface breaks for Windows editors): patch — strip `\u{feff}` before parsing + test.
- VG1 / BH8(reload) `settings::reload` has no test; deleting `file_banner = None` or inverting `binaries_changed` stays green — **medium** (pre-verified): patch — mock-app test with temp file; return `binaries_changed`.
- VG2 / BH8(initialise) `settings::initialise` has no test; dropping `st.settings = loaded.into_settings()` stays green — **medium** (pre-verified): patch — `initialise_at(app, path, search)` + three tests.
- VG3 `settings_reveal` / `binaries_redetect` wire names unverified — **low**: patch — two `invoke()` tests.
- VG4 snapshot JSON contract pinned only for `pending` — **low**: patch — serialise one `Binary` per status, assert exact strings.
- VG5 `ProcessRunner` timeout/kill and non-zero-exit paths never executed; frozen Always demands the 5 s timeout — **medium** (pre-verified): patch — fixture scripts (`.cmd` ping / `sh sleep`) with a 200 ms timeout.
- VG6 frontend shell untested (no DOM env) — **low**: rejected, same call as Story 1.1; the GUI rows were executed by the orchestrator (six screenshots) and the first component story brings jsdom.
- VG-o / BH9 timing tests (`a_burst…`, `real_watcher…`) can false-fail on a loaded runner — **low**: patch — widen quiet window/margins, tolerate a trailing callback.
- BH1 startup seeds `st.settings` with `for_machine()`; on a parse/write failure the *detected* path is treated as configured (`configured: true`, "from settings", wrong `binaries_changed` baseline) — **medium**: patch — seed with `Settings::default()`; `for_machine()` only for the Created write.
- BH2 / EC9 overlapping `redetect` runs store whichever finishes last — **medium**: patch — generation counter, discard stale.
- BH3 / EC7 `watch::start` failure only `eprintln!`s while README promises live reload — **medium**: patch — `settings.watch` banner.
- BH4 / EC8 transient `PermissionDenied` during an editor save → sticky `settings.read` banner; startup read error mislabelled `settings.write` — **medium** on Windows: patch — retry 3×100 ms, then banner; id `settings.read`.
- BH5 / EC11 / EC12 `version` never checked; `poll.*_ms = 0` accepted — **low**: patch — `validate()` → banner for newer schema, 0 → default + banner.
- BH6 missing-binary banner lists every PATH dir — **low**: rejected; the frozen matrix row specifies the searched list; wraps via `overflow-wrap`; revisit in Story 2.5's banner design.
- BH7 `opener:allow-reveal-item-in-dir` capability not needed for a Rust-side call — **low**: patch — remove after confirming in the plugin source that the Rust API bypasses the ACL.
- BH10 pane leaves focus behind; `ctrl+,` auto-repeats — **low**: patch — focus Close on open, restore on close, ignore `event.repeat`.
- BH11 / EC14 no-runtime / load-failure never shown in the pane — **low**: patch — `loadError` in store, rendered in pane.
- BH12 README drift (Re-detect missing, `theme` unused, `shell` null, macOS path) — **low**: patch.
- BH13 / EC2 `try_wait` error reported as `Spawn` and leaves an orphan — **low**: patch — `Wait` variant, kill+wait.
- BH14 `settings_reveal` errors when the file is gone instead of opening the folder — **low**: patch — fall back to the directory.
- BH15 `Loaded::Created` discarded — **low**: rejected; first-launch state is visible in the pane's File section; a one-time notice needs dismissal the banner model does not have.
- EC1 grandchild holding the pipe blocks `join()` past the timeout — **low**: rejected; `claude`/`git` are native executables (or a node shim with no lingering children); a hanging wrapper is the operator's configured choice.
- EC3 `--version` exit 0 with empty stdout → `version: Some("")` — **low**: patch — empty → `None`.
- EC4 bare name or `~` in a configured path resolved against CWD — **low**: patch — expand `~`, search PATH for a single-component name.
- EC5 relative PATH entries can be pinned — **low**: patch — `is_absolute()` filter.
- EC6 Unix non-executable file shadows the real binary — **low**: patch — exec-bit check on unix.
- EC10 `spawn_blocking` failure leaves binaries `pending` forever — **low**: patch — mark `version_failed`.
- EC13 `Rescan` events with empty paths ignored — **low**: patch — treat as relevant.
- EC15 `settings_get` result can overwrite a newer `settings://changed` snapshot — **low**: patch — apply only if still `null`.
- EC16 (claim) "claude renamed away" AC expects the searched-dirs banner but a pinned path yields configured-missing — **low**: rejected; the frozen matrix defines both rows and the configured-missing banner names the path and why detection was skipped; the AC wording is the spec's.
- EC17 (claim) `code` found via `~/.local/bin` would set a template the shell cannot run — **low**: patch — PATH-only search for `code`.

## Verification

**Commands:**
- `cd src-tauri; cargo test` -- expected: all pass, including new `settings::*` tests and the existing mock-runtime test
- `npm test` -- expected: settings store tests pass alongside the existing 7
- `npx tsc --noEmit` -- expected: clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks (if no CLI):**
- `npm run tauri dev`: no banner; `%APPDATA%\switchboard\settings.json` exists with all keys; break the JSON → banner with line:col within 1 s; fix → gone; `ctrl+,` opens the pane, Esc closes, "Reveal file" selects the file in Explorer; temporarily set `"claude": {"path": "C:\\nope.exe"}` → banner names that path.
