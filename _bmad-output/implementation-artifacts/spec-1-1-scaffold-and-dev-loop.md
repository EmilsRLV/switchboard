---
title: 'Story 1.1: Scaffold and dev loop'
type: 'chore'
created: '2026-10-16'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'e7a6154484356e4ff416692b0dae3cd02bd83947'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repo holds only planning docs. Nothing builds, so no later story has a place to land, and Linux support (Story 1.2) cannot be wired until a tree exists that compiles and tests on one platform.

**Approach:** Scaffold a Tauri 2 app — Rust core, React 19 + TypeScript + Vite UI — laid out exactly as `architecture.md` §8 prescribes, with `npm run tauri dev` opening a dark, menu-less window titled "Switchboard" and `cargo test` / `npx vitest run` each passing one real placeholder test. Generate the baseline (icons, `tauri.conf.json`, capabilities) with `create-tauri-app`, then reshape it to our layout rather than hand-rolling Tauri boilerplate.

**Decisions (recorded, not for debate):** npm as package manager; TypeScript pinned to 5.9.x (7.0 is out but ecosystem plugins lag); Tauri crates on stable `2.x` (3.0 is alpha); app identifier `dev.switchboard.app`, product name `Switchboard`; native window decorations for now; default Tauri placeholder icons until Story 2.5's visual pass; no ESLint/Prettier yet (added when there is code worth linting); only the Rust modules this story needs (`ipc/`) exist — empty stubs for `graph/`, `claude/`, `pty/`, `git/`, `mcp/`, `approvals/`, `settings/` are **not** created, each arrives with its first story.

## Boundaries & Constraints

**Always:** Layout per `architecture.md` §8 (`src/`, `src-tauri/`, root `package.json`/`vite.config.ts`/`tsconfig.json`/`index.html`). Rust is the source of truth: the one IPC command (`app_info`) lives in `src-tauri/src/ipc/` and is thin. Dark background set in both `tauri.conf.json` (`backgroundColor`) and CSS so there is no white flash. `.gitattributes` forces LF in the working copy (global `core.autocrlf=true` would otherwise CRLF every file). Keep the dependency list to what is listed in Tasks — no component library, no router, no CSS framework.

**Never:** No product features (canvas, terminal, settings pane, palette, single-instance) — those are Stories 1.3/1.4 and Epic 2. No CI (Story 1.2). No Playwright. Do not open devtools on launch. Do not add a menu. Do not write anything under `~/.claude`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Dev run | `npm run tauri dev` on Windows 11, deps installed | Window "Switchboard", 1280×800, min 800×500, dark (`#0f1115`), shows app name + version from `app_info`; no menu bar; devtools closed | — |
| Rust tests | `cargo test` in `src-tauri/` | ≥1 test passes (`app_info` returns the Cargo package name/version) | — |
| Frontend tests | `npx vitest run` | ≥1 test passes (Zustand store default state + one action) | — |
| Typecheck | `npx tsc --noEmit` | Clean | — |
| IPC unavailable | UI loaded in a plain browser (`npm run dev`) | Shows "no Tauri runtime" placeholder instead of throwing | Caught at the call site |

</frozen-after-approval>

## Code Map

Repo is empty apart from planning docs; nothing to reuse. External facts that shape the scaffold:

- Toolchain verified 2026-10-16: `rustc 1.94.0 x86_64-pc-windows-msvc`, VS 2022 Community (MSVC), WebView2 155, Node 25.8, npm. `link.exe` on PATH is Git's coreutils one — rustc locates MSVC via vswhere, so a successful `cargo build` is the check.
- Versions to pin (latest stable at spec time): `@tauri-apps/cli` 2.12.3, `@tauri-apps/api` 2.12.4, `react`/`react-dom` 19.3.1, `@types/react` 19.3.0, `vite` 8.3.4, `@vitejs/plugin-react` 6.1.2, `typescript` 5.9.3, `zustand` 5.0.15, `vitest` 5.0.5; crates `tauri = "2"`, `tauri-build = "2"`, `serde`, `serde_json`. `create-tauri-app` 4.7.5 (`--template react-ts --manager npm`).
- `B:\projects\ide\.gitignore` -- already ignores `node_modules/`, `dist/`, `src-tauri/target/`, `src-tauri/gen/schemas/`; extend only if the template adds more.
- `README.md` -- update the "Starting implementation" block to the real dev commands once they work.

## Tasks & Acceptance

**Execution:**
- [x] scratchpad -- run `npm create tauri-app@4.7.5 switchboard -- --template react-ts --manager npm --identifier dev.switchboard.app --yes`; copy `src-tauri/icons/`, `src-tauri/capabilities/default.json`, `src-tauri/build.rs` into the repo -- reuse Tauri's generated baseline instead of hand-writing it
- [x] `package.json` -- name `switchboard`, `private`, scripts `dev`, `build`, `preview`, `tauri`, `test` (`vitest run`), `typecheck` (`tsc --noEmit`); pinned deps from Code Map -- the dev loop entry points
- [x] `tsconfig.json`, `vite.config.ts`, `index.html` -- strict TS, React plugin, Vite `clearScreen:false`, `server.port 1420`, `strictPort`, `envPrefix ['VITE_','TAURI_ENV_*']`; vitest `environment: 'node'` in the same config -- Tauri-compatible Vite setup
- [x] `.gitattributes` -- `* text=auto eol=lf`, binaries (`*.png *.ico *.icns`) `binary` -- stop CRLF churn
- [x] `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json` -- crate `switchboard`, lib `switchboard_lib`; `productName "Switchboard"`, `identifier dev.switchboard.app`, window `title "Switchboard"`, 1280×800, min 800×500, `backgroundColor "#0f1115"`, `theme "Dark"`, `devtools` not set; `build.beforeDevCommand "npm run dev"`, `devUrl http://localhost:1420`, `frontendDist ../dist`; bundle targets `all` -- app shell config
- [x] `src-tauri/src/main.rs`, `src-tauri/src/lib.rs` -- `run()` builds the Tauri app, registers `ipc::app_info` -- entry point
- [x] `src-tauri/src/ipc/mod.rs` -- `#[tauri::command] fn app_info() -> AppInfo { name, version }` from `env!("CARGO_PKG_*")` + unit test -- first thin command, first Rust test
- [x] `src/main.tsx`, `src/App.tsx` -- mount React, call `app_info` via `src/ipc/index.ts`, render name + version centred; placeholder text when `window.__TAURI_INTERNALS__` is absent -- proves the IPC round trip
- [x] `src/ipc/index.ts` -- `invoke` wrapper typed per command, guards the non-Tauri case -- the one place IPC is called
- [x] `src/state/app.ts`, `src/state/app.test.ts` -- Zustand store `{ appInfo, setAppInfo }` + vitest test -- first frontend test
- [x] `src/theme/tokens.css`, `src/theme/base.css` -- CSS variables (`--bg #0f1115`, `--fg`, `--border`, `--accent`), system UI sans + monospace, dark `body` background -- the start of the visual system Story 2.5 extends
- [x] `README.md` -- replace the scaffold commands with the working dev loop (`npm install`, `npm run tauri dev`, `npm test`, `cargo test` in `src-tauri`) -- keep the index honest

**Acceptance Criteria:**
- Given a fresh clone on Windows 11 with Rust 1.94 and Node 25, when I run `npm install` then `npm run tauri dev`, then a window titled "Switchboard" opens dark with no menu bar and no devtools, showing "Switchboard 0.1.0" from the Rust side.
- Given the repo, when I run `cargo test` in `src-tauri` and `npm test` at the root, then each reports at least one passing test and zero failures.
- Given the repo, when I compare its tree to `architecture.md` §8, then every listed top-level path exists except the Rust/frontend modules this story explicitly defers, and `_bmad/` is installed with `project_name = switchboard`.

## Implementation Notes

- Baseline generated with `create-tauri-app` 4.7.5 in the scratchpad; `src-tauri/icons/`, `build.rs`, `capabilities/default.json` and `src/vite-env.d.ts` were copied over. `tauri-plugin-opener` (which the template adds) was dropped from `Cargo.toml`, `package.json` and the capability's permissions because it is not in this story's dependency list; it returns with the story that needs it.
- `tsconfig.json` is a single file (`include: ["src", "vite.config.ts"]`, `types: ["vite/client"]`) rather than the template's `tsconfig.json` + `tsconfig.node.json` pair, so `tsc --noEmit` covers the Vite config too without project references.
- `index.html` carries an inline `background: #0f1115` on `html, body` in addition to `tauri.conf.json` `backgroundColor` and `src/theme/base.css`, so the very first paint before the CSS bundle loads is dark too.
- `cargo test` works without a built `dist/` (tauri-build only warns); `npm run tauri build` runs `npm run build` itself.
- `src-tauri/build.rs` is not the template's one-liner: once `lib.rs` grew a `tauri::test` IPC test, the lib's unit-test executable imported `comctl32!TaskDialogIndirect` (via tauri-runtime-wry's dialog) and died at load with `STATUS_ENTRYPOINT_NOT_FOUND`, because tauri-build embeds the Common Controls v6 manifest into the app binary only (`rustc-link-arg-bins`; `rustc-link-arg-tests` covers integration tests, which this crate has none of). `build.rs` now calls `tauri_build::try_build` with `WindowsAttributes::new_without_app_manifest()` and embeds the same manifest itself via `cargo:rustc-link-arg=/MANIFEST:EMBED /MANIFESTINPUT:…` on Windows, so bin, cdylib and test harness each get it exactly once. Verified: `cargo test` 3 passed; removing the `generate_handler!` registration makes `tests::app_info_is_registered_under_its_wire_name` fail with "Command app_info not found"; `switchboard.exe` carries FileVersion 0.1.0 (inherited from Cargo.toml after dropping `version` from `tauri.conf.json`) and the manifest at resource id 1; debug build ships unminified JS with a source map.
- Tauri CLI warns that the identifier `dev.switchboard.app` ends in `.app` (conflicts with macOS bundle extension). Kept as decided; macOS is not a target.
- Verified 2026-10-16: `npm install` clean (only an `EBADENGINE` warning from vitest 5.0.5, whose engine range skips odd Node 25); `npx tsc --noEmit` clean; `npm test` 1 file / 3 tests passed; `cargo test` 2 passed; `npm run tauri build -- --debug --no-bundle` produced `src-tauri/target/debug/switchboard.exe`; `npm run tauri dev` opened a window titled "Switchboard", outer 1296×839 (1280×800 client), `GetMenu` = 0, dark background showing "switchboard 0.1.0" from `app_info`.
- Audit (orchestrator, 2026-10-16): matrix row "IPC unavailable" had no covering test; added `src/ipc/index.test.ts` (4 tests: no `window`, plain window, Tauri internals present, `appInfo()` rejects with `NoTauriRuntimeError`). Re-ran: vitest 2 files / 7 passed, `tsc --noEmit` clean, `cargo test` 2 passed. Independently launched `npm run tauri dev`: window title `Switchboard`, `GetMenu()=0`, outer 1296×839, 25 MB RSS; stopped cleanly, port 1420 released.
- AC 3 verified in triage (2026-10-16): every `architecture.md` §8 top-level path exists (`package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/{ipc,state,theme}`, `src-tauri/{Cargo.toml,tauri.conf.json,capabilities,src/{main.rs,lib.rs,ipc}}`, `docs/`, `_bmad-output/{planning,implementation}-artifacts`, `_bmad/`); `_bmad/bmm/config.yaml` and `_bmad/config.toml` both carry `project_name = switchboard`.
- Review patch pass (2026-10-16): `lib.rs` split into `with_commands<R>()` / `builder()` / `run()` with a `tauri::test` mock-runtime test dispatching `"app_info"` by wire name (`[dev-dependencies] tauri = { features = ["test"] }`, `serde_json` moved to dev-deps); vitest glob widened to `*.test.{ts,tsx}`; Tauri `build` block (target/minify/sourcemap) added to `vite.config.ts`; `version` removed from `tauri.conf.json` (inherits Cargo); `user-select: none` dropped from `body`; README notes Linux prerequisites land with Story 1.2. Final verification: vitest 2 files / 7 passed, `tsc --noEmit` clean, `cargo test` 3 passed, `tauri build --debug --no-bundle` produced `switchboard.exe` (13.2 MB). Nothing deferred.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-16) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- VG1 `src-tauri/src/lib.rs:9` — `generate_handler![ipc::app_info]` registration and the `"app_info"` wire name have no automated test; removing the registration leaves all tests green — **medium** (pre-verified gap; AC 1 rests on a manual launch): patch — `builder()`/`run()` split + `tauri::test` mock dispatch test.
- VG2 `src/App.tsx:37-69` — status rendering (placeholder / name+version) untested — **low**: rejected; needs a DOM env + testing lib the story excludes, and `App.tsx` is a placeholder Epic 2 replaces. Revisit with the first real component test.
- VG3 / BH7 / EC5 `vite.config.ts:27` — `include: ["src/**/*.test.ts"]` silently skips future `*.test.tsx` — **low** (developer trap, green by not running): patch — widen glob.
- BH1 diff omits lockfiles/icons — **false**: `package-lock.json`, `Cargo.lock` and `icons/` are staged; the review diff excluded them deliberately (lockfiles 5 800 lines, icons binary). Adding them to Tasks is a spec edit.
- BH2 / EC7 AC says "Switchboard 0.1.0", UI renders "switchboard 0.1.0" (crate name) — **low**: rejected; frozen matrix row says "app name + version from `app_info`", which holds; capitalising via `package_info()` needs an `AppHandle` in unit tests for a cosmetic gain.
- BH3 Implementation Notes say 1 file / 3 tests — **false**: the audit note already records 2 files / 7 tests; the Verification section states a floor (`≥1`), not a count.
- BH4 Spec Change Log empty despite deviations — **false**: the template reserves the change log for review loopbacks; deviations are recorded in Implementation Notes as designed; status was advanced to `in-review` before review.
- BH5 third AC (layout + BMAD `project_name`) unverified — **low**: verified in triage (see Implementation Notes); no code change.
- BH6 `vite.config.ts` lacks Tauri's `build` block (`target` chrome105/safari13, debug-conditional `minify`/`sourcemap`) — **low** (`tauri build --debug` ships minified JS without maps; webkit target unpinned before Story 1.2): patch — add the block from the Tauri Vite guide.
- BH8 / EC6 `tauri.conf.json` repeats `version`; three sources can drift — **low**: patch — delete it so Tauri inherits Cargo's.
- BH9 `"csp": null` carried from the template without a recorded decision — **low**: rejected; template default, the webview loads only bundled assets, and a real CSP needs the xterm/CodeMirror surface known (Epic 9 ship pass). Recording it is a spec edit.
- BH10 README prerequisites omit Linux deps — **low**: patch — one line pointing at Story 1.2.
- BH11 no `rust-toolchain.toml` / `engines` — **low**: rejected; pinning policy belongs to Story 1.2 (CI) and `engines.node` would only add a warning on this machine's Node 25.
- BH12 `serde_json` in `[dependencies]` but used only in tests — **low**: patch — move to `[dev-dependencies]`.
- BH13 `user-select: none` on `body` makes `::selection` dead and the version string uncopyable — **low**: patch — drop it from `body`; chrome elements opt out later.
- EC1 `createRoot(getElementById("root") as HTMLElement)` null — **false**: `index.html` in the same diff defines `#root` and the entry is a module script (deferred).
- EC2 `lib.rs` `.expect` with `panic=abort` + `windows_subsystem` hides a release-build webview init failure — **low**: rejected; Tauri's Windows installers bundle the WebView2 bootstrapper, debug builds keep the console, and a dialog needs a new dependency. Revisit in Story 9.1 first-run.
- EC3 `app_info` never settles → "connecting…" forever — **low**: rejected; a sync Rust command either returns or errors through `invoke`; a timeout adds a branch to a placeholder.
- EC4 `status === "ready"` with `appInfo === null` — **false**: nothing calls `setAppInfo(null)` after load; `ready` is set only after `setAppInfo(result)`.
- EC8 `@types/react-dom` not in the Code Map pin list — **low**: rejected; required for `react-dom/client` types and pinned to the matching 19.3.0; the fix is a spec edit.

## Verification

**Commands:**
- `npm install` -- expected: no peer-dependency errors
- `npx tsc --noEmit` -- expected: clean
- `npm test` -- expected: 1 file, ≥1 test passed
- `cd src-tauri; cargo test` -- expected: ≥1 test passed
- `npm run tauri build -- --debug --no-bundle` -- expected: `src-tauri/target/debug/switchboard.exe` produced (proves the MSVC link step despite Git's `link.exe` on PATH)

**Manual checks (if no CLI):**
- `npm run tauri dev`: window title "Switchboard", dark background with no white flash, no menu bar, devtools closed; time from the Vite "ready" line to the window being interactive is under 1 s.
