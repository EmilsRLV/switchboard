---
title: 'Story 9.1: Installers and first-run'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '45db84c8e1639c18a10730c207ae150be5ada807'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** CI already builds NSIS/MSI and AppImage/.deb packages, but they are bare. They have no publisher or description and no WebView2 policy, the .deb has no runtime dependencies, and there are no install instructions. A first run on a clean machine has never been checked. Edge cases such as a missing `~/.claude`, or Windows `claude` installed only as the npm `claude.cmd` shim, give confusing results.

**Approach:**
- **Packaging.** Fill in the bundle configuration and add an end-user Install section to the README.
- **First run.** Harden it on a clean machine: no settings, no workspace, no `~/.claude`, `claude` absent or present only as a shim. Each case must start cleanly, with the right banner or hint.
- **Verification.** Simulate a clean first run locally. Leave a real installer test on a clean machine to Emils, and a CI build to when Actions resumes.

**Decisions** (taken by the orchestrator under Emils' standing authorisation while he is away; recorded for his review):
- **Bundle metadata** (`tauri.conf.json`):
  - `publisher` and `copyright` `Emils Romanis`, `category` `DeveloperTool`, plus a short and a long description.
  - The version stays inherited from Cargo (0.1.0).
- **Windows:**
  - `webviewInstallMode: embedBootstrapper`: the installer carries the small WebView2 bootstrapper, which installs WebView2 only when it is missing. Windows 11 already has it.
  - NSIS `installMode: currentUser`, so no admin rights are needed.
  - The MSI stays as built.
- **Linux:**
  - The `.deb` adds `xdg-utils` (used by the opener) to its dependencies, on top of Tauri's webkit and gtk set.
  - The AppImage keeps its defaults.
  - The tray's appindicator dependency is added in 9.2.
- **First run:**
  - **Missing files.** With no `settings.json` and no `workspace.json`, both are created. The canvas shows its empty-state hint (`Add a project — ctrl+o, drop a folder, or ctrl+k`), and detection fills in `claude` when it finds it.
  - **`claude` missing.** The 1.3 banner shows (`claude not found — searched: …`).
  - **Windows npm shim only.** When the only `claude` found is the shim (`claude.cmd`), the banner says `claude.cmd (npm shim) found — install the native claude.exe` instead of "not found".
  - **No `~/.claude`.** The app starts, and discovery shows no sessions, with no error banner. Nothing is created under `~/.claude`.
  - **`git` missing.** The existing `git.missing` banner shows, and the canvas still works.
- **Docs:**
  - **README "Install" section.**
    - Downloads: which CI artifact to get, and that artifacts are kept for 7 days.
    - Windows: the NSIS/MSI choice, the per-user install, the WebView2 note, and that `claude` must be the native `claude.exe`.
    - Linux: the runtime packages for the .deb, and running the AppImage with `chmod +x`.
    - Where settings and workspace live.
    - A short "Clean-machine checklist" for checking an installed build by hand.
  - **README fix.** Correct the "14 days" retention to 7.

## Boundaries & Constraints

**Always:**
- **Never touch `~/.claude`.** First-run code must not create or modify anything under it; tests use temp homes.
- **Tests and CI.** Tests never run the real `claude`. CI stays green once Actions resumes.

**Never:**
- Code signing, auto-update, a release workflow, or macOS.
- Installing anything on the dev machine during verification.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Fresh profile | no settings/workspace files | both written; empty canvas with hint | — |
| claude present | on PATH | detected, no banner | — |
| claude absent | not on PATH or ~/.local/bin | banner `claude not found — searched: …` | — |
| Windows shim only | only `claude.cmd` | banner names the shim and says to install claude.exe | — |
| No ~/.claude | home without `.claude` | starts, no sessions, no error | nothing created there |
| git absent | no git | `git.missing` banner, canvas works | — |

</frozen-after-approval>

## Code Map

- `src-tauri/tauri.conf.json` (bundle :28-38): the metadata, `windows.webviewInstallMode`, `windows.nsis.installMode` and `linux.deb.depends`.
- `src-tauri/src/settings/detect.rs`:
  - missing banner :268-270 and `configured_missing` :303;
  - add shim detection when locating `claude` on Windows; the existing `.cmd` refusal is documented in README :846-850.
- `src-tauri/src/settings/mod.rs`: `initialise_at` (:469-495) and `for_machine` (:172-185), the first-run flow.
- `graph/mod.rs` (:813-850): workspace defaults.
- `src-tauri/src/claude/mod.rs` (:23), `discover.rs` and `sessions.rs`: check that a missing claude home yields an empty list without a banner (tests exist for parts; add any gap).
- `src/canvas/Canvas.tsx` (:169, :186-190): the empty hint already exists.
- `README.md`: a new Install section near the top, and the retention fix (:62-63).

**Tests:**
- detect: a shim-only directory on Windows gives the shim banner, and an absent binary gives "not found".
- A fresh temp config dir writes both files with defaults.
- A missing claude home gives empty discovery.
- tauri.conf: a small Rust or vitest check that the bundle keys are present, parsing the JSON.

## Tasks & Acceptance

**Execution:**
- [x] `tauri.conf.json`: bundle metadata and the platform options.
- [x] `settings/detect.rs`, `claude/*` (+tests): the shim banner and missing-home checks.
- [x] `README.md`: the Install section, checklist and retention fix.

**Acceptance Criteria:**
- Given a fresh profile and `claude` on PATH, when the app starts, then it detects the binary and shows the empty canvas with the hint. With `claude` absent, it shows the 1.3 banner instead.
- Given `npm run tauri build` (full bundles) on Windows, when it runs, then the NSIS and MSI installers are produced with the new metadata. The orchestrator runs this check; nothing is installed.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Bundle config.** `tauri.conf.json` `bundle` gains `publisher` `Emils Romanis`, `copyright`
  `Copyright © 2026 Emils Romanis` (review fix), `category` `DeveloperTool`, short and long descriptions,
  `windows.webviewInstallMode {type: embedBootstrapper}`, `windows.nsis.installMode currentUser` and
  `linux.deb.depends ["xdg-utils"]`. No top-level `version`, so it stays Cargo's. Checked by `lib.rs` test
  `the_bundle_config_carries_the_installer_metadata` (parses the file via `include_str!`). `curl` was not
  added: hooks are Claude Code `http` hooks, nothing shells out to curl.
- **Shim detection** (`settings/detect.rs`, revised after review). Windows only (`resolve_for(.., windows)`;
  the public `detect`/`resolve`/`detect_configured` pass `cfg!(windows)`, so tests cover both platforms) and
  `claude` only (`SHIM_GUARDED`):
  - `Search::locate_native(name, windows)` accepts only `.exe`/`.com` on Windows (so a `.ps1` is not
    native); `locate_shim` finds `.cmd`/`.bat`. A native exe anywhere in PATH or `~/.local/bin` wins.
  - A batch file is never run (not even `--version`), whether searched, configured as a bare name, or
    configured as an absolute/`~/` path. Status `missing`, banner id `claude.shim` (`SHIM_BANNER`) with the
    file's full path: `<path> (npm shim) found — install the native claude.exe` for `claude.cmd`/`claude.bat`,
    `(a batch file)` for any other batch file.
  - `claude.path` naming a batch file while a native `claude.exe` is on the search:
    `claude.path names the npm shim; clear it to use claude.exe`.
  - `ipc::launch_program`: with no usable `claude` and a `claude.shim` banner, the launch is refused with the
    banner's text instead of `NO_CLAUDE` (asserted in `session_launch_refusals_start_nothing`).
  - `Settings::for_machine` uses `locate_native(.., cfg!(windows))`, so first launch never pins a shim.
    `launch::refuse_batch` reuses `is_batch`. `git` keeps the plain search.
- **First run / missing `~/.claude`.** No production change was needed: `list_projects` and `sessions::scan`
  already treat a missing `projects/` as empty. `settings::redetect` now delegates to
  `redetect_in(app, claude_search, git_search)` (and `detect_all` to `detect_all_in`) so the startup detection
  pass can be driven with an injected search. The `lib.rs` test
  `a_first_run_on_a_clean_profile_writes_both_files_and_reads_an_absent_claude_home_as_empty`: fresh config dir
  → both files written, no banners, empty canvas; `redetect_in` over an empty search → exactly
  `claude.missing` (`claude not found — searched: …`) and `git.missing`, stored in state; a project plus a
  non-existent `.claude` home → no children, no workspace banner, `claude_projects_list` `[]`, and `.claude`
  is not created. The canvas hint already existed (`Canvas.tsx`).
- **README.** New "Install" section after the intro: downloads + 7-day retention + building from source when
  no artefact is available; Windows NSIS/MSI (per-user vs per-machine, uninstall via Apps, reinstalling the
  same version, installing both = two installs), WebView2, native `claude.exe`; Linux "the downloaded `.deb`"
  (+ `sudo apt remove switchboard`) and AppImage `chmod +x` + FUSE (delete the file to uninstall); where the
  files live; an 8-step clean-machine checklist. The Settings → binary-detection paragraph describes the shim
  rules exactly. "14 days" → "7 days".
- **Verified locally (2026-10-25).** `cargo test` (568 pass), `clippy --all-targets -D warnings` clean,
  `tsc --noEmit` clean, vitest 634/634, `tauri build --debug --no-bundle` ok, and one
  `tauri build --bundles nsis,msi` produced `Switchboard_0.1.0_x64-setup.exe` (4.5 MiB) and
  `Switchboard_0.1.0_x64_en-US.msi` (5.8 MiB). It downloaded NSIS 3.13, nsis_tauri_utils, WiX 3.14 and the
  WebView2 bootstrapper into the Tauri tool cache. Nothing was installed or launched. Still open: the manual
  foreground-guarded launch checks, Emils' clean-machine install with the README checklist, and Linux/CI
  bundles when Actions resumes.

- 2026-10-25 GUI first-run pass (orchestrator, debug build). The real config dir was moved aside and removed, and a stub `claude.exe` was put first on PATH.
  - The app wrote `settings.json`, with `claude.path` set to the stub, `external_editor` set to `code -g {file}:{line}` (code found on PATH) and `shell` set to `powershell`, and wrote `workspace.json`.
  - The canvas showed `Add a project - ctrl+o, drop a folder, or ctrl+k`, with no banner.
  - The "claude absent" first run was **not** checked on screen. The app always searches `~/.local/bin`, which holds Emils' real `claude.exe`, and the pass never runs or renames the real binary. The `lib.rs` first-run test covers that case (empty search, banner `claude not found — searched: …`).

- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away):
  - cargo test (572), clippy, tsc, vitest (634) and the debug build all passed;
  - one first-run GUI pass, not repeated, because review round 1 changed only detection, launch refusals and docs;
  - the local `--bundles nsis,msi` build earlier produced both installers, which still carry the pre-review copyright string.
  
  **Pending:**
  - Emils' clean-machine install with the README checklist, including the claude-absent banner;
  - the Linux `.deb`/AppImage and Windows bundles from CI once Actions resumes.

## Spec Change Log

- 2026-10-25, review round 1 (blind-hunter: the epic context lists `curl` as a Linux requirement, but this story dropped it without a record). **Orchestrator decision, under Emils' standing authorisation while he is away:** `curl` is not a dependency. The hooks are Claude Code `http` hooks, so nothing in the app or its hooks calls `curl`. `epic-9-context.md` was updated to match. The "claude absent" on-screen check is deferred to Emils' clean-machine test: the dev machine's `~/.local/bin` holds the real `claude.exe`, which the app always searches.

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V: no gaps). Triaged by the orchestrator.

**Patch:**
- P1 (medium; E, B) A configured absolute path to a `.cmd`/`.bat` file, such as one pinned by an earlier first run, is still run for `--version` and shows Found. Every launch then fails with `BATCH_FILE`. Treat it like a shim found by searching: show the shim banner and never run it.
- P2 (low; E, B) The shim rule and its "install the native claude.exe" wording apply on every platform. Apply them on Windows only. Label only `claude.cmd` and `claude.bat` as "npm shim"; any other batch file is just "a batch file".
- P3 (low; E) If `claude.path` names the shim but a native `claude.exe` is also present, the banner says `claude.path names the npm shim; clear it to use claude.exe`.
- P4 (low; E) If `PATHEXT` includes `.PS1`, npm's `claude.ps1` counts as native. Accept only `.exe` and `.com` as native on Windows.
- P5 (low; E) With only the shim present, a launch says `claude not found; set claude.path`. Give the shim reason instead.
- P6 (low; B) The shim banner shows only the file name. Show its full path.
- P7 (low; B) Copyright becomes `Copyright © 2026 Emils Romanis`. Update the test.
- P8 (low; B, E) README Install section:
  - an upgrade of the same version needs the old install removed first (MSI) and may prompt (NSIS);
  - how to uninstall each package (MSI, .deb with `apt remove`, AppImage by deleting the file);
  - a warning that installing both NSIS and MSI gives two installs;
  - a pointer to building from source when no CI artifact is available;
  - name the .deb by "the downloaded `.deb`" (the exact file name is checked when CI runs again).
- P9 (low; B) The first-run test's doc comment says one thing and the test checks another, and the startup path that raises the banner is not covered. Make the comment match. Add a test through the startup (`redetect`) path with an empty search that asserts the missing-banner, and a `git.missing` case.

**Reject:**
- None. The `curl` decision is recorded in the Spec Change Log.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --bundles nsis,msi` -- expected: both installers built (not installed)

**Manual checks:**
- **Orchestrator, foreground-guarded:** launch the debug build with a fresh, empty config dir:
  - with `claude` on PATH: the hint, and no banner;
  - with PATH stripped of `claude`: the banner.
- **Emils:**
  - install the NSIS build on a clean Windows machine and the .deb/AppImage on Linux, then run the README checklist;
  - check that CI produces the bundles once Actions resumes.
