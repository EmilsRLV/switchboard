---
title: 'Story 2.1: Canvas with persisted viewport'
type: 'feature'
created: '2026-10-16'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'b62aa8ce91ff2c07199c8550c5572f52edb71d3d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The window still shows the Epic 1 placeholder (name + version). The product's home surface — an infinite canvas — does not exist, and nothing persists a workspace, so Stories 2.2–2.5 have nowhere to put nodes.

**Approach:** Replace the content area with an `@xyflow/react` canvas: pan (middle/right button, or space + left drag), wheel zoom, a `canvas.fitView` command (`ctrl+0`), a subtle dot background, and a quiet empty-state hint. Introduce the Rust `graph/` module with the complete `Workspace` v1 model and `workspace.json` persistence (beside `settings.json`), two thin commands (`workspace_get`, `workspace_set_viewport`) and the `workspace://changed` event. The viewport is written at the end of every pan/zoom gesture and restored on launch.

**Decisions (recorded):** xyflow's `base.css` (unstyled) not `style.css`; `panOnDrag={[1, 2]}` + `panActivationKeyCode="Space"`, `selectionOnDrag` off, `minZoom 0.1`, `maxZoom 4`; viewport saved on `onMoveEnd` only when it differs from the stored one by more than 0.5 px / 0.001 zoom (no timer); the full `Workspace` envelope (`version, viewport, projects, branches, sessions, edges, defaults`) is defined now with empty collections — no fields used beyond `viewport` in this story; atomic JSON I/O is factored into `src-tauri/src/persist.rs` (`read_json` with BOM strip + line/col error, `write_atomic_json`) and `settings/store.rs` is refactored onto it without behaviour change; `fitView` is exposed to the command via a tiny `canvas` Zustand store holding the xyflow instance; the "60 Hz with 50 nodes" measurement is Story 2.3's (first story with nodes); no `workspace.json` watcher (unlike settings, it is app-written, not hand-edited).

## Boundaries & Constraints

**Always:** Rust is the source of truth — the frontend never writes `workspace.json`; the `workspace` store mirrors the Rust snapshot via `workspace_get` + `workspace://changed`, same subscribe-then-get pattern as settings. Tolerant parse (`serde(default)`, unknown keys ignored, BOM ok), atomic writes, first launch writes the default file. Tokens only for colours; the accent appears nowhere on the canvas. Banners, pane and palette keep working over the canvas; Esc precedence unchanged (nothing to clear yet).

**Never:** No nodes, no project adding, no context menu, no selection, no keyboard navigation of nodes (2.2–2.4). No `style.css` from xyflow, no minimap/controls widgets. No second keydown listener — `ctrl+0` is a registry command. Do not touch `settings.json` semantics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| First launch | no `workspace.json` | file created with `version: 1`, `viewport {x:0,y:0,zoom:1}`, empty collections; canvas at that viewport; empty-state hint visible | write failure → banner `workspace.write`, in-memory default used |
| Pan / zoom | middle-drag, right-drag, space+left-drag, wheel | canvas moves; on gesture end the viewport is persisted (file mtime changes within 500 ms) | — |
| Relaunch | file with `viewport {x:-120,y:40,zoom:1.5}` | canvas opens at exactly that viewport | — |
| Fit view | `ctrl+0` or palette "Fit view" | with no nodes: viewport resets to `{0,0,1}`; persisted | — |
| Broken file | invalid JSON | banner `workspace.parse` with `workspace.json:line:col`, defaults in memory, file **not** overwritten until the next viewport write | — |
| Newer schema | `version: 2` | loads tolerant, banner `workspace.version` | — |
| No-op move | gesture ends at the same viewport (±0.5 px, ±0.001 zoom) | no write | — |
| Panes over canvas | settings pane open, palette open | canvas does not receive wheel/drag through the pane or palette backdrop | — |

</frozen-after-approval>

## Code Map

- `src-tauri/src/settings/store.rs:101-131` -- `write_atomic` + `load_or_init` + `parse` (BOM strip, `ParseError{line,col,msg}`) → generalise into `src-tauri/src/persist.rs` (`read_json<T: DeserializeOwned + Default>`, `write_atomic_json<T: Serialize>`, shared `ParseError`); keep `settings::store`'s public API and tests green.
- `src-tauri/src/settings/mod.rs:292-316` -- `AppState { settings, watcher, detect_generation }`; add `workspace: RwLock<WorkspaceState>`. `paths.rs` -- `config_dir()`; add `workspace_path()` (`workspace.json`). Banner type lives in `settings::Banner` — reuse it; the workspace banners are included in the settings snapshot's `banners` for now? **No**: give `WorkspaceSnapshot` its own `banners` and have `Banners.tsx` concatenate both stores (keeps modules independent).
- `src-tauri/src/lib.rs:12-21` -- `with_commands` registers commands; `builder().setup` calls `settings::initialise`; add `graph::initialise(app.handle())` after it. Tests pattern: `mock_app()` + `invoke()` for wire names.
- `src-tauri/src/ipc/mod.rs` -- thin command pattern; add `workspace_get() -> WorkspaceSnapshot`, `workspace_set_viewport(viewport: Viewport) -> WorkspaceSnapshot`.
- `src/App.tsx:87-107` -- replace `<main className="content">…</main>` with `<Canvas/>`; keep Banners/SettingsPane/Palette. The `app_info` display goes (Epic 1's proof); `appInfo` IPC stays for later use in the settings pane.
- `src/ipc/index.ts` -- `Commands` map, `call()`, `onSettingsChanged` listen helper → add `Workspace`, `Viewport`, `WorkspaceSnapshot` types, `workspaceGet`, `workspaceSetViewport`, `onWorkspaceChanged`.
- `src/state/settings.ts` -- store pattern (snapshot/applySnapshot/loadError) to copy for `src/state/workspace.ts`; `src/components/Banners.tsx` + `selectBanners` -- extend to merge workspace banners.
- `src/commands/builtins.ts` + `builtins.test.ts` -- add `canvas.fitView` ("Fit view", `ctrl+0`, `when: canvas ready`); update the visible-commands test.
- `src/components/shell.css`, `src/theme/tokens.css` -- `.content` rules become `.canvas` rules; dot colour from `--border`.
- `package.json` -- add `@xyflow/react` `12.12.0` (exact pin like the others).

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/persist.rs`, `src-tauri/src/settings/store.rs` -- generic atomic JSON read/write + `ParseError`; settings store delegates; tests move/stay green -- shared persistence
- [x] `src-tauri/src/graph/mod.rs`, `src-tauri/src/graph/store.rs` -- `Workspace` v1 (`Viewport{x,y,zoom}`, `Project`, `BranchNode`, `SessionRef`, `Edge`, `NodeRef`, `LaunchDefaults` per architecture §5.1, all `serde(default)`), `WorkspaceState { path, workspace, banners }`, `WorkspaceSnapshot`, `initialise_at(app, path)`, `set_viewport(app, vp) -> Snapshot` (writes atomically, emits `workspace://changed`), `validate` (version banner); tests: first launch creates, existing applied, broken → parse banner + untouched, BOM, unknown keys, newer version banner, set_viewport writes + emits -- the model and persistence
- [x] `src-tauri/src/settings/paths.rs`, `src-tauri/src/settings/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` -- `workspace_path()`, `AppState.workspace`, two commands + wire-name tests, `graph::initialise` in setup -- wiring
- [x] `package.json` -- `@xyflow/react` 12.12.0 -- dependency
- [x] `src/ipc/index.ts`, `src/state/workspace.ts`, `src/state/workspace.test.ts`, `src/state/canvas.ts` -- types, commands, listen helper; workspace store; canvas store holding `fitView`/`setViewport` from the xyflow instance; `viewportDiffers(a, b)` pure fn with the 0.5 px / 0.001 thresholds + tests -- frontend state
- [x] `src/canvas/Canvas.tsx`, `src/canvas/canvas.css` -- `ReactFlowProvider` + `ReactFlow` with the pan/zoom config, `Background variant="dots"` coloured from tokens, `defaultViewport` from the store (render only once the snapshot is loaded), `onMoveEnd` → `workspaceSetViewport` when `viewportDiffers`, `onInit` → canvas store; empty-state hint "Add a project — ctrl+k" in muted text centred, pointer-events none -- the canvas
- [x] `src/commands/builtins.ts`, `src/commands/builtins.test.ts` -- `canvas.fitView` -- command
- [x] `src/components/Banners.tsx`, `src/state/settings.ts` or a new selector -- merged banners from both stores -- banners
- [x] `src/App.tsx`, `src/components/shell.css` -- mount `<Canvas/>` in place of the placeholder; subscribe-then-get for the workspace next to settings -- integration
- [x] `README.md` -- "Workspace" section: file location, what is persisted, pan/zoom keys, `ctrl+0` -- docs

**Acceptance Criteria:**
- Given no `workspace.json`, when the app starts, then the file exists with `version: 1` and the default viewport, the canvas shows the dot grid and the hint, and no banner.
- Given I pan with the middle button and zoom with the wheel, when I stop, then `workspace.json` is updated within 500 ms with the new viewport; when I relaunch, the canvas opens at exactly that viewport.
- Given `ctrl+0`, when there are no nodes, then the viewport returns to `{0,0,1}` and that is persisted.
- Given `cargo test` and `npm test`, then graph store, persist, workspace store and `viewportDiffers` tests pass with the existing suites; `clippy -D warnings` and `tsc` are clean.

## Implementation Notes

- Orchestrator GUI run (2026-10-17, foreground-guarded, real mouse/keyboard input): first launch wrote `workspace.json` (`version 1`, home viewport) and showed the dot grid + hint; a 200×120 px middle-button drag persisted as `x=200 y=120` **62 ms** after release; three wheel notches persisted `zoom≈1.516` with the pan adjusted; relaunch opened at exactly the saved viewport and did not rewrite the file; `ctrl+0` and palette "Fit view" both reset to `{0,0,1}` and persisted; a broken file showed `workspace.json:3:15 expected value` and was left untouched at startup; `ctrl+q` quit. One false alarm on the way: a first script picked WebView2's 16×16 helper window as the process's main window and sent `ctrl+0` to it — selecting by window title fixed the harness, not the app.

- **Bundle size delta** (`npm run tauri build -- --debug --no-bundle`, unminified debug build): `dist/assets/index-*.js` 603,711 B → 984,677 B (+381 KB; 208 KB gzip), `index-*.css` 6,611 B → 21,169 B (+14.5 KB, xyflow's `base.css`). `switchboard.exe` (debug) 15.4 MB. `@xyflow/react` pulls in its own `zustand@4` under `node_modules/@xyflow/react/node_modules`; the app stays on `zustand@5`.
- **`persist.rs` shape**: `parse_json`, `to_json`, `write_atomic_json`, `read_json -> Result<Option<T>, LoadError>` (`None` = no file; `NotADirectory` counts as missing so the write path reports it) and `load_or_init -> Loaded<T>`. `persist::LoadError`'s `Read`/`Write` carry the bare `io::Error`; `settings::store::LoadError` keeps its "cannot read/write settings:" messages via `From`, `settings::store::Loaded` is a type alias of `persist::Loaded<Settings>` with `into_settings()` kept. Temp files are `.<file name>-*.tmp` in the same dir.
- **`WorkspaceState`** holds `file_banner` + `validation_banners` (mirroring `SettingsState`) rather than one `banners` vec; `snapshot().banners` concatenates them. A successful viewport write clears the file banner (the file is good now); the version banner stays and the loaded `version` is written back unchanged, as settings does.
- **Fit view with no nodes**: xyflow 12.12's `fitView` returns early when there are no nodes, so `useCanvasStore.fitView` calls `setViewport({0,0,1})` in that case. Programmatic `setViewport` ends in a d3-zoom `end` event, which xyflow routes to `onMoveEnd`, so the same `viewportDiffers` → `workspace_set_viewport` path persists it; nothing writes from the command itself.
- **Right-click**: xyflow's pane calls `preventDefault` on `contextmenu` when `panOnDrag` includes button 2, so a right-drag pan does not pop the webview's native menu. `ctrl+0` relies on Tauri's default `zoomHotkeysEnabled: false` so WebView2 does not swallow it; GUI-only to confirm.
- **Review round 1 fixes**: `graph::MIN_ZOOM`/`MAX_ZOOM` (mirrored in `src/canvas/limits.ts`) and `Viewport::sanitised` — `set_viewport` ignores NaN/±∞ (no write, no event) and clamps zoom; `store::validate(&mut)` resets an unusable loaded viewport to home with banner `workspace.viewport` and silently upgrades `version < 1`; `WorkspaceState.read_only` after an unreadable file (`workspace.read`) or a newer `version` — the file is never written that session and both banners end with "; changes are kept in memory and not saved"; `workspace_set_viewport` is `async` and `set_viewport` writes with the lock released; `graph::announce` split out of `initialise` (tested); `persist::sweep_temp_files` removes `.<name>-*.tmp` orphans at both `initialise_at`s. Frontend: `persistViewport` + `mergeBanners` + a `workspace.load` banner for `loadError` live in `state/workspace.ts`; `Flow` tracks `lastSentRef`; `mirror` moved to `src/ipc/mirror.ts` (tested); canvas mounts at home when the read failed; `zoomOnDoubleClick={false}`; dead `state/app.ts` removed.
- **Not GUI-verified here** (orchestrator's manual checks): first-launch file + hint, mtime within 500 ms, relaunch viewport, `ctrl+0`, broken-file banner. CLI verification: `cargo test` 110 pass, `clippy -D warnings` clean, `npm test` 111 pass (10 files), `tsc --noEmit` clean, debug build OK.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-17) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- BH3 `set_viewport` accepts NaN/±∞ and `zoom ≤ 0`; `serde_json` writes non-finite as `null`, which the next launch cannot parse — **high** (self-inflicted broken file): patch — reject non-finite, clamp zoom to the canvas range (constants in Rust), test.
- BH4 loaded viewport never sanity-checked (`zoom: 0` renders nothing) — **medium**: patch — `validate` resets an invalid viewport to default with a `workspace.viewport` banner.
- EC5 a pan after `LoadError::Read` overwrites a possibly valid file with defaults + viewport — **medium**: patch — remember the read failure; `persist` refuses and the banner says changes are not saved.
- EC1 a newer-schema file is rewritten in v1 shape on the first pan, still labelled version N — **medium**: patch — same mechanism: never persist over a newer version; banner says so.
- BH5 `workspace_set_viewport` is sync: `create_dir_all` + fsync + rename on the main thread while holding the write lock, on every gesture end — **medium**: patch — `async` command; clone, write outside the lock, re-take to store the outcome.
- BH6 / EC3 a failed `workspace_get` leaves the canvas `aria-busy` for the session — **medium**: patch — mount at `HOME_VIEWPORT` when `loadError` is set; the error becomes a banner.
- EC4 a rejected `workspaceSetViewport` only `console.error`s — **low**: patch — surfaced through the same banner path.
- BH8 `persistViewport` compares with the last acknowledged viewport, so a gesture back to the start while a write is in flight is skipped and disk disagrees with the screen — **low** (one round-trip window): patch — compare with the last sent.
- BH9 / VG2 persist decision untested at the call site — **medium** (pre-verified): patch — `persistViewport(viewport, deps)` in the workspace store + tests.
- BH13 / VG5 `mirror` ordering and stale-read guard untested — **medium** (pre-verified): patch — `src/ipc/mirror.ts` + tests.
- VG6 TS argument contract (`{ viewport }`) unverified — **low**: patch — stub `__TAURI_INTERNALS__.invoke`, assert `(cmd, args)`.
- VG7 `workspace.read` branch untested — **low**: patch — directory at the file path.
- VG4 / BH11 `Banners` merge untested; three-way conditional buys nothing — **low**: patch — `mergeBanners` pure fn + test; component spreads.
- BH-last `graph::initialise` emission untested — **low**: patch — one `listen_any` test.
- EC2 `version < 1` neither flagged nor normalised — **low**: patch — normalise to `SCHEMA_VERSION` on load (v0 → v1 is a no-op upgrade).
- EC6 orphan `.workspace.json-*.tmp` after a crash mid-write — **low**: patch — sweep on initialise (persist helper + test).
- BH7 `zoomOnDoubleClick` left on, undocumented; 2.2 wants double-click — **low**: patch — off.
- BH2 / EC7 / VG-o `src/state/app.ts` + test are dead — **low**: patch — delete the store and its test; keep the `app_info` command and `appInfo()` wrapper (wire-tested; the settings pane shows the version in 2.5).
- BH12 README omits `workspace.read` and "never rewritten on load" — **low**: patch.
- BH1 lockfile change "missing from the diff" — **false**: `package-lock.json` is modified in the tree; the review diff excludes lockfiles by construction.
- BH10 `AppState`/`Banner` live in `settings` while `graph` depends on them (cycle) — **low**: rejected; compiles, and the neutral `state.rs` move is a refactor for the first Epic 3 story that adds a third module, not a defect in this one.
- VG1 restoring `defaultViewport` at mount untested (DOM) — **low**: rejected, same call as before; verified by the orchestrator's relaunch check.
- VG3 `graph::initialise` wiring in `builder().setup` untested — **low**: rejected; `Wry`-only, same accepted gap as `settings::initialise`.
- EC8 temp-file prefix changed from `.settings-` to `.settings.json-` — **false** as a behaviour change: nothing consumes the pattern; the sweep (EC6) is written against the new one.
- EC9 the hint reads `projects` ("no fields beyond viewport") — **low**: rejected; the hint is deliberately projects-based and 2.2 renders the nodes.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: all pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds; note the bundle size delta from `@xyflow/react` in Implementation Notes

**Manual checks (if no CLI):**
- Orchestrator runs these (foreground-guarded): first launch → file + hint; middle-drag + wheel → file mtime changes within 500 ms; relaunch → same viewport; `ctrl+0` → reset; broken file → `workspace.parse` banner.
