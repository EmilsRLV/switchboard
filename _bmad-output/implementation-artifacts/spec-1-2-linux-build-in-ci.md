---
title: 'Story 1.2: Linux build in CI'
type: 'chore'
created: '2026-10-16'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'ab5ced8090055a6e799f0246490797b8768250a7'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The scaffold builds and tests on Windows only. Linux is a stated target (FR-SYS-2) and nothing checks it, so every later story can silently break Linux until someone owns a Linux box.

**Approach:** One GitHub Actions workflow with a two-OS matrix — `ubuntu-24.04` and `windows-latest` — that on every push and pull request runs typecheck, vitest and `cargo test`, then `tauri build` producing AppImage + .deb on Linux and NSIS + MSI on Windows, and uploads the bundles as artefacts. Document the Linux prerequisites in the README so a Linux developer can run the dev loop too.

**Decisions (recorded):** runner `ubuntu-24.04` named explicitly (not `ubuntu-latest`) so the webkit2gtk-4.1 package set is stable; Node from `lts/*` with npm cache (vitest's engine range excludes the odd Node 25 used locally); Rust `stable` via `dtolnay/rust-toolchain` with `swatinem/rust-cache` — no `rust-toolchain.toml` pin, drift is what CI is for; apt set is Tauri's prerequisites list plus the pipeline extras (`libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils`); `concurrency` cancels superseded runs on the same ref; artefacts retained 14 days; no release/tagging and no `tauri-apps/tauri-action` (that is distribution, Epic 9). **Remote (decided by Emils 2026-10-16):** create a **private** GitHub repo `EmilsRLV/switchboard` with `gh repo create`, add it as `origin`, push `master`, and demonstrate the AC on that first CI run; the README gets a CI status badge. Remote operations (repo creation, push) are performed by the orchestrating session under this explicit authorisation, not by the implementation subagent.

## Boundaries & Constraints

**Always:** `npm ci` (lockfile is committed); tests run before the bundle step and a test failure fails the job; the `if:` on the apt step matches the matrix value exactly; cargo cache keyed on `./src-tauri -> target`; `fail-fast: false` so a Windows failure still shows the Linux result.

**Never:** No publishing, releases, signing or auto-update. No macOS job. No changes to app code to make CI pass — if Linux fails, the story records the failure and the fix becomes its own story unless it is a build-config one-liner. No secrets. **Amended by Emils (2026-10-16), on the first red run:** one-line fixes to tests or build config that make existing behaviour correct on Linux/CI are allowed inside this story. Applied under this amendment: the mock test's origin URL (`tauri://localhost` off Windows) and Vite 8's `minify` setting (boolean, not `"esbuild"`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Push to any branch | commit pushed | both matrix jobs run: typecheck, `vitest run`, `cargo test`, `tauri build --bundles …`; artefacts `switchboard-linux` (AppImage, .deb) and `switchboard-windows` (NSIS .exe, .msi) uploaded | job red on any failing step |
| Pull request | PR opened/updated | same jobs; checks appear on the PR | — |
| Second push to same branch while running | new commit | earlier run cancelled (`concurrency`) | — |
| Linux `cargo test` | mock-runtime test on headless Ubuntu | passes without a display | — |
| Workflow lint | `actionlint` or GitHub's parser | no errors | YAML error fails the run before any job |

</frozen-after-approval>

## Code Map

- `.github/` -- does not exist; create `.github/workflows/ci.yml`.
- `package.json` -- scripts already present: `typecheck`, `test` (`vitest run`), `tauri`; lockfile `package-lock.json` committed → `npm ci` works.
- `src-tauri/build.rs:19-28` -- Windows-only manifest embedding guarded by `CARGO_CFG_TARGET_OS == "windows"`; Linux skips it. Do not touch.
- `src-tauri/Cargo.toml` -- `[dev-dependencies] tauri = { features = ["test"] }`; the lib test `tests::app_info_is_registered_under_its_wire_name` uses `MockRuntime`, needs no display.
- `src-tauri/tauri.conf.json` -- `bundle.targets: "all"`; CI narrows with `--bundles appimage,deb` / `--bundles nsis,msi`. Bundle output lands in `src-tauri/target/release/bundle/<kind>/`.
- `README.md:22-23` -- prerequisites line + the Story 1.2 pointer sentence to replace with the actual Linux apt command.
- Action versions verified 2026-10-16 from Tauri's pipeline doc and GitHub: `actions/checkout@v7`, `actions/setup-node@v6`, `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2`, `actions/upload-artifact@v7`.

## Tasks & Acceptance

**Execution:**
- [x] `.github/workflows/ci.yml` -- `name: ci`; `on: push` (all branches), `pull_request`, `workflow_dispatch`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; job `build` with `strategy.fail-fast: false` and `matrix.include`: `{ os: ubuntu-24.04, name: linux, bundles: "appimage,deb" }`, `{ os: windows-latest, name: windows, bundles: "nsis,msi" }`; steps: checkout → apt (`if: matrix.os == 'ubuntu-24.04'`) → setup-node `lts/*` + `cache: npm` → rust stable → rust-cache `workspaces: ./src-tauri -> target` → `npm ci` → `npm run typecheck` → `npm test` → `cargo test` (`working-directory: src-tauri`) → `npm run tauri build -- --bundles ${{ matrix.bundles }}` → upload-artifact `name: switchboard-${{ matrix.name }}`, `path: src-tauri/target/release/bundle/`, `retention-days: 14`, `if-no-files-found: error` -- the whole story
- [x] `README.md` -- replace the Story 1.2 pointer sentence with a Linux prerequisites block (the apt command) and add the CI badge `![ci](https://github.com/EmilsRLV/switchboard/actions/workflows/ci.yml/badge.svg)` under the title -- keep the index honest
- [x] (orchestrator, after the files land) `gh repo create EmilsRLV/switchboard --private --source . --remote origin --push` -- so the AC can be demonstrated on the first run

**Acceptance Criteria:**
- Given the workflow file, when parsed by GitHub (or `actionlint`), then it has no syntax errors and both matrix entries resolve.
- Given a push to `master`, when CI finishes, then the `linux` job uploaded an artefact containing a `.AppImage` and a `.deb`, the `windows` job uploaded one containing a `-setup.exe` (NSIS) and a `.msi`, and both jobs ran typecheck, vitest and `cargo test` before bundling.
- Given the README, when a Linux developer follows the prerequisites block, then `npm run tauri dev` has what it needs on Ubuntu 24.04.

## Implementation Notes

- Orchestrator (2026-10-16): narrowed `upload-artifact` `path` from `src-tauri/target/release/bundle/` to the four installer globs (`appimage/*.AppImage`, `deb/*.deb`, `nsis/*.exe`, `msi/*.msi`) so Tauri's `Switchboard.AppDir/` staging directory is not uploaded; actionlint 1.7.7 clean. Committed `b5ba6f0`, repo `EmilsRLV/switchboard` created private, pushed; first run 38925464448 was red on both OSes (Linux: mock-test origin; Windows: Vite 8 minify) — see Review Triage Log.
- Orchestrator (2026-10-16): review patches committed `b6dd24b`, pushed; run 38927083356 green on both jobs (Linux 15:49→15:59, Windows →16:04). "Check bundles" reported `Switchboard_0.1.0_amd64.AppImage`, `Switchboard_0.1.0_amd64.deb`, `Switchboard_0.1.0_x64-setup.exe`, `Switchboard_0.1.0_x64_en-US.msi`; artefacts `switchboard-linux` 78.1 MB, `switchboard-windows` 3.1 MB. Nothing deferred.

- 2026-10-16: `.github/workflows/ci.yml` written exactly per the Execution task. One addition beyond the task list: `defaults.run.shell: bash` on the job, so both runners use the same shell (Git Bash on Windows) and `npm run tauri build -- --bundles …` passes `--` through identically on both; no app code touched.
- README: Linux prerequisites block (the apt command, Ubuntu 24.04) replaces the Story 1.2 pointer; CI badge added under the title; status line and a short CI paragraph reference the workflow.
- Local verification (Windows, pre-push): `python -c "import yaml…"` parses; `actionlint 1.7.7` (downloaded binary, shellcheck/pyflakes integrations off) exits 0 with no findings; `npm run typecheck`, `npm test` (7 tests) and `cargo test` (3 tests) pass. The Linux job itself is unverified until the first push; `upload-artifact` on `bundle/` will also include Tauri's `appimage/Switchboard.AppDir/` staging directory alongside the `.AppImage` (the spec fixes the path, so left as is).
- 2026-10-16 review fixes: `permissions: contents: read`; `timeout-minutes: 45`; concurrency group keyed on the branch name (PR head ref or `ref_name`) with `cancel-in-progress` only off master; apt `if:` keyed on `matrix.name == 'linux'`; new "Check bundles" step requiring an installer file per requested bundle kind (tauri-bundler skips kinds silently). Build-config one-liners outside the workflow: `vite.config.ts` `build.minify` is now a boolean (Vite 8 no longer ships esbuild, `"esbuild"` fails the production build); `lib.rs` test uses the platform's local origin (`tauri://localhost` off Windows) so the mock IPC call is not rejected as remote on Linux. README: Node 24 LTS line, badge pinned to `?branch=master`, pointer from the apt list to `ci.yml`.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-16) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG); plus the live first CI run 38925464448.

- VG-o1 `src-tauri/src/lib.rs:44` — Linux `cargo test` red: test hardcodes the Windows-only local origin `http://tauri.localhost`; on Linux the request is remote and the capability denies `app_info` — **high** (Linux target broken, CI red): intent_gap — frozen Never clause blocked the fix; Emils chose "fix in this story", clause amended; patch (`#[cfg]` origin).
- CI-Windows `vite.config.ts` — `minify: "esbuild"` needs esbuild installed separately on Vite 8; `npm run build` fails on CI (local debug builds had minify off) — **high** (Windows bundle never built): patch — boolean `minify`, under the same amendment.
- VG1 `ci.yml` upload — `if-no-files-found: error` fires only when all globs are empty; tauri-bundler skips unsupported kinds with a warning and exit 0, so a half-empty artefact is green — **medium** (pre-verified; AC contract unverified): patch — "Check bundles" step per kind.
- VG-o2 / BH1 / EC5 spec says `path: bundle/`, shipped file uses installer globs — **low**: orchestrator's change (excludes the `Switchboard.AppDir/` staging dir); recorded in Implementation Notes. EC5's "AppDir for debugging as spec implies" is **false** — the spec never promises the AppDir.
- VG-o3 / BH2 / EC4 README prerequisites say Node 25, outside vitest's engine range; CI uses `lts/*` — **low**: patch — README says Node 24 LTS.
- EC1 / BH6 push + pull_request double-build the same commit in different concurrency groups — **low** (2× cost on PR branches, Windows minutes ×2): patch — group on `pull_request.head.ref || ref_name`.
- BH7 `cancel-in-progress: true` also cancels superseded `master` runs (no artefacts for the first) — **low**: patch — `cancel-in-progress: ${{ github.ref != 'refs/heads/master' }}`.
- EC2 / BH5 no `timeout-minutes` (360-min default) — **low**: patch — 45 min.
- EC3 / BH8 apt `if:` repeats the runner literal — **low**: patch — `matrix.name == 'linux'` (still a matrix value, per the frozen Always).
- BH3 badge without `?branch=master` tracks any branch — **low**: patch.
- BH4 no `permissions` block — **low**: patch — `contents: read`.
- BH9 mutable action tags, no Dependabot — **low**: rejected; pin/update policy is a repo-wide chore for Epic 9, not this story's defect.
- BH10 actionlint not run in CI — **false**: the matrix row says "actionlint or GitHub's parser"; GitHub parses the workflow on every run and fails it on error.
- BH11 apt list duplicated in README — **low**: patch — cross-reference sentence.
- BH12 README states Linux works before the first green run — **low**: rejected; a green run on both jobs is this story's exit condition, so the sentence is true at completion.

## Verification

**Commands:**
- `npx actionlint` is not installed; use `gh workflow view ci --yaml` after the first push, or `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` locally -- expected: parses
- `gh run list --workflow ci --limit 1` then `gh run watch` -- expected: both jobs green
- `gh run download <id>` -- expected: `switchboard-linux/` holds `appimage/*.AppImage` and `deb/*.deb`; `switchboard-windows/` holds `nsis/*-setup.exe` and `msi/*.msi`

**Manual checks (if no CLI):**
- If no remote is created, none of the above can run; the story records that and stops at the YAML parse check.
