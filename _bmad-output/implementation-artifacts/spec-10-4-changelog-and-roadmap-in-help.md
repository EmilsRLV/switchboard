---
title: 'Story 10.4: Changelog and roadmap in Help'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cfd10d43bb456cc074e0ab8832ca4d9e2da3f30f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The operator can't see what changed in Switchboard or what's coming without opening the repo. Help also doesn't say which version is running or where its files live. (FR-HELP-6, epics.md Story 10.4)

**Approach:** Hand-write `CHANGELOG.md` and `ROADMAP.md` at the repo root. Bundle them as two more Help pages, rendered by the Story 10.1 renderer, and reachable from Contents and two new commands. Contents gains `Switchboard <version>`, with the config folder under it. A test ties the newest changelog heading to the version in `package.json` and `Cargo.toml`.

## Boundaries & Constraints

**Always:**
- **CHANGELOG.md** follows the Keep a Changelog shape: `# Changelog`, then `## Unreleased`, then `## 0.1.0 — 2026-10-31`, newest first.
  - Under each release, bullets are grouped by `###` area: Canvas, Projects, Sessions, Terminals, Branches and worktrees, Edges, The app as a tool for Claude, Review, Settings and platform, Keyboard.
  - The bullets summarise Epics 1–9 as a user sees them.
  - **Decision (Emils, 2026-10-31):** `0.1.0` covers only Epics 1–9, which is what the installed 0.1.0 has. The Help work goes under `## Unreleased` as bullets under a `### Help` area: the Help pane and guide pages, F1 from where you are, the Getting started checklist, and the changelog and roadmap in Help. A later version bump moves them under the new heading. This story does not bump.
- **ROADMAP.md** has `## Next`, `## Later`, `## Known limitations` and `## Not planned`. It is seeded from:
  - the PRD's Later rows;
  - the open questions Q2 (`/add-dir` injection reliability) and Q3 (native peer messaging);
  - the epics.md Deferred list;
  - the user-facing rows of `deferred-work.md`, which must include at least: a viewer for peer message text; resume and fork with the session's own model and permission mode; remembering a pop-out window's size and place; folder targets for context edges; following `/clear` to the new session id; the false `finished` when the operator's own Stop hook blocks; the memory budget with full scrollback; typing latency p95; Linux checks still owed.
  - PRD §5 goes under Not planned.
- **Wording in both files:**
  - Plain words in the Terms page's vocabulary.
  - No story ids, FR/NFR ids, Q-numbers, epic numbers, file names or code paths.
  - No raw HTML, no images.
  - Any key in a code span must be a registered default, by the Story 10.2 rule.
- **Help pages:**
  - Contents order: the guide pages, Getting started, Changelog, Roadmap.
  - Both pages go through `renderMarkdown` and the existing content test: no HTML, links resolve, keys are real.
- **Commands:**
  - `help.changelog` ("Help: changelog") and `help.roadmap` ("Help: roadmap").
  - Both are in the palette and bindable, with no default key. They open the Help pane on that page, routed like `help.gettingStarted`.
- **Contents footer:**
  - `Switchboard <version>`, taken from `app_info` (Cargo's version).
  - Under it, in mono, the config folder: the folder of the settings snapshot's `path`.
  - Before `app_info` answers, or when it fails, the line reads `Switchboard`. With no settings path, the folder line is omitted. Neither case shows an error.
- **Version test (vitest):**
  - `package.json` and `src-tauri/Cargo.toml` (the `[package]` version) are equal.
  - The first `## ` heading in CHANGELOG.md that is not `Unreleased` starts with that version.
- **Style:** DESIGN.md tokens only, no accent, no new motion.

**Never:**
- No fetching. No new dependency.
- Don't edit `tauri.conf.json`'s version. Don't bump the version.
- No "What's new" chip, and no `state.json` change: that is Story 10.5.
- No new Rust command: `app_info` and the settings snapshot already carry what's needed.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Version matches | package 0.1.0, Cargo 0.1.0, newest heading `## 0.1.0 — …` | test passes | N/A |
| Bump without entry | package 0.2.0, Cargo 0.2.0, newest `## 0.1.0` | test fails, naming both | N/A |
| Mismatched manifests | package 0.2.0, Cargo 0.1.0 | test fails | N/A |
| Unreleased only | CHANGELOG has `## Unreleased` and no release | test fails ("no released heading") | N/A |
| app_info fails / no Tauri | Contents shown | `Switchboard`, no version, no error | swallowed |
| No settings path | snapshot `path: null` | version line only | N/A |
| HTML in a root file | `<b>` in ROADMAP.md | content test fails | N/A |

</frozen-after-approval>

## Code Map

- `src/help/pages.ts` -- `HELP_PAGES`: the page table, with `?raw` imports and `pageIdOfFile`. Add `changelog` (`file: "CHANGELOG.md"`, imported from `../../CHANGELOG.md?raw`) and `roadmap` after `getting-started`. `file` stays the link name; a guide page may link `CHANGELOG.md`.
- `src/help/content.test.ts` -- this test reads `docs/help/` via `node:fs` (`HELP_DIR`) and asserts files ⇄ table. Keep the docs/help rule for guide pages. Treat root-file pages (CHANGELOG.md, ROADMAP.md) as listed, existing at the repo root. The no-HTML, link and key rules run over every page in `HELP_PAGES`.
- `src/components/HelpPane.tsx` -- the Contents `<nav>` maps `HELP_PAGES`. Add the version/folder footer below the list as a small component. Read `appInfo()` once, in a `useEffect` with a cancelled flag. Get the folder from `useSettingsStore(s => s.snapshot?.path)`, cut at the last `/` or `\`. The `help.gettingStarted` block shows the special-page pattern.
- `src/commands/help.ts` -- `GETTING_STARTED_PAGE` and the `help.gettingStarted` handler are the model. Add `CHANGELOG_PAGE`/`ROADMAP_PAGE` and their handlers.
- `src/commands/builtins.ts` ~l.275 -- the `help.gettingStarted` registration is the model for the two new commands.
- `src/ipc/index.ts:1045` -- `appInfo(): Promise<AppInfo>` returns `{name, version}`. The frontend doesn't use it yet; it rejects with `NoTauriRuntimeError` outside Tauri.
- `src/state/settings.ts` -- `snapshot.path`: the absolute `settings.json` path, or null.
- Version-test model: `content.test.ts` loads `node:fs` (`await import("node:fs" as string)`; no Node typings). Reuse that for `package.json`, `Cargo.toml` and `CHANGELOG.md`.
- Seed sources (read, don't edit):
  - `_bmad-output/planning-artifacts/prd.md`: Later rows; §5 at l.165; §6 Q2/Q3 at l.174–175.
  - `epics.md`: the "Deferred (recorded, not scheduled)" section, and Epics 1–9 for the changelog.
  - `_bmad-output/implementation-artifacts/deferred-work.md` (45 entries; pick the user-facing ones).
  - `docs/help/terms.md`: the vocabulary.
- Not to change: `src/help/markdown.ts` (the renderer is reused as is), Rust, `state.json`, `tauri.conf.json`.

## Tasks & Acceptance

**Execution:**
- [x] `CHANGELOG.md` -- write it as Boundaries says, about 50–90 bullets in total, each one plain line a user would recognise -- FR-HELP-6
- [x] `ROADMAP.md` -- write the four sections. Each item is one line saying what it is and, for limitations, what you see today -- FR-HELP-6
- [x] `src/help/pages.ts` -- add the two pages -- they appear in Contents
- [x] `src/commands/help.ts`, `src/commands/builtins.ts` -- add `help.changelog` and `help.roadmap` -- every Help action is a command
- [x] `src/components/HelpPane.tsx` (+ CSS in the stylesheet holding `.help-contents`) -- add the Contents footer: version, and the folder in `--font-mono` `--fg-muted` -- the Story 10.4 AC
- [x] `src/help/content.test.ts` -- cover the root-file pages -- they get the same rules as the guide pages
- [x] `src/help/version.test.ts` -- add the version test, with a pure helper (e.g. `newestReleased(changelog)`) unit-tested against the matrix rows -- a bump without an entry fails `npm test`
- [x] `src/components/HelpPane.test.tsx` -- add render tests: Contents lists Changelog and Roadmap last; the footer shows the version when given, and the folder; the folder is omitted when the path is null -- the AC
- [x] `docs/help/keyboard.md` or `canvas.md` (one line), `DESIGN.md` (Help pane entry: the footer), `README.md` (point at CHANGELOG/ROADMAP) -- keep the docs true

**Acceptance Criteria:**
- Given the palette, when I type "changelog" or "roadmap", then "Help: changelog" or "Help: roadmap" is listed, and running it shows that page in the Help pane, as clicking its Contents row does.
- Given Help Contents in the app, when it shows, then the last rows are Getting started, Changelog, Roadmap, and under the list is `Switchboard 0.1.0` with the config folder in mono.
- Given the commands audit and the design lint, when the tests run, then both pass.

## Implementation Notes

- **DESIGN.md lives at `docs/DESIGN.md`**, not the repo root as the frontmatter `context:` says. Read and updated there.
- **CHANGELOG.md:** 83 bullets (7 under Unreleased → Help, 76 under 0.1.0). Written from the guide pages and README
  (what actually shipped), not the epics' planned wording: e.g. **Attach in terminal** is still a stub, so it is not
  claimed in 0.1.0 and appears in the roadmap instead. No file names: the keybindings file and the settings file are
  described in words. Keys in code spans are only registered defaults already used by the guide pages.
- **ROADMAP.md overlaps between sources:** the epics' Deferred list puts macOS and cloud sessions under "recorded, not
  scheduled", while PRD §5 lists "macOS testing" and "cloud/remote sessions" as out of scope. Resolved as: Later holds
  the Deferred items (a macOS build; cloud sessions and Remote Control attach); Not planned keeps §5 worded as "Testing on
  macOS for each release (a Mac build is under Later)" and "Remote and cloud sessions beyond what Later lists". The
  structured chat view (Later) vs "re-implementing Claude Code's chat rendering" (Not planned) are kept apart by wording.
- **Q2/Q3** are under Known limitations (injection not always confirmed, Restart with flags always works; native
  messaging by name not yet confirmed, Switchboard's own peer messages always work). Added beyond the required list,
  all user-facing and true today: Attach in terminal stub, Windows notification-centre clicks, Linux tray without
  clicks/tooltip, unsigned installers. "What's new after an update" (Story 10.5) is the first Next item.
- **Footer:** `VersionFooter` (presentational, exported for the render test) plus `AppVersion` (reads `appInfo()` in a
  `useEffect` with a cancelled flag; rejection swallowed). The last good version is kept in a module variable so
  returning to Contents does not flash `Switchboard` before `app_info` answers again. `configFolder(path)` is exported
  and tested; `/settings.json` gives `/`, a bare file name gives `null` (folder line omitted). Footer look:
  `--text-sm` `--fg-muted` name, mono `--text-xs` `--fg-muted` folder, wrapping anywhere, selectable.
- **Tests touched beyond the Code Map:** `pages.test.ts` (expected table + the 150–400 word budget now skips the
  changelog and roadmap, which grow with the app), `help.test.ts` (pick list 12 → 14 pages; palette rows for "help";
  new test for the two commands: titles, no default key, listed for "changelog"/"roadmap", bindable, open their page),
  `builtins.test.ts` (id lists, the command count 100 → 102, the palette title lists). `HelpPane.test.tsx` mocks the
  settings store to read live state, like the existing ui-store mock.
- **content.test.ts:** root pages (`CHANGELOG.md`, `ROADMAP.md`) are excluded from the docs/help ⇄ table check and
  instead asserted to be listed, last after Getting started, and byte-equal to the repo-root files. A self-test plants
  `<b>` and an image to show the no-HTML rule fires (the matrix's "HTML in a root file" row).
- **version.test.ts:** helpers (`newestReleased`, `cargoVersion`, `versionProblem`) live in the test file, so nothing
  ships. A longer version that merely starts with the app's (`0.1.01`, `0.1.0-beta`) does not count as a match.
- **keyboard.md:** the Help paragraph names **Help: changelog** and **Help: roadmap**; reworded to stay at the
  400-word cap (exactly 400 now). The next edit to that page needs to cut words.
- **Surprise:** the Bash tool's heredoc collapsed backslashes in a Python edit script (`\\` → `\`); the affected test
  strings were fixed with the Edit tool. Several edited files were already CRLF in the working copy (git normalizes
  to LF via `.gitattributes`).
- `npm run build` rewrote `dist/` (a build output); CHANGELOG/ROADMAP text is only in the lazy `pages-*.js` chunk.

## Spec Change Log

## Review Triage Log

Pass 1 (blind-hunter BH, edge-case-hunter EC, verification-gap VG; 18 findings).

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| VG1 | `AppVersion`'s effect (appInfo → `Switchboard <version>`, `knownVersion` cache) is never exercised; tests cover only the fallback and the pure `VersionFooter` | medium | renderToStaticMarkup runs no effects (node env, no DOM harness); a regression to `info.name` or a dropped `setVersion` passes every test | patch: export a `loadAppVersion()` helper the effect uses, plus tests with a mocked `appInfo` (resolve / reject) and a cache reset hook |
| BH1 | Help listed under Unreleased while the build reports 0.1.0 | false | Emils' recorded decision (frozen block, 2026-10-31): 0.1.0 stays true to the installed build; the bump comes later | reject |
| BH2 | README calls the changelog "Keep a Changelog shape" but it groups by area and uses no brackets | low | README.md new paragraph; the file is area-grouped by design (spec), so the label misleads a contributor; direct wording fix | patch |
| BH3 | `package-lock.json` version not checked | low | `npm version` updates both; adding the check is a new guard for a rare hand edit | reject |
| BH4 / EC2 | `newestReleased` accepts any `## ` heading, or one inside a fence | low | the file is hand-written with neither; either case makes the test fail loudly, never pass wrongly — except a fenced heading equal to the version, which is contrived | reject |
| BH5 / EC4 | `configFolder("C:\\settings.json")` gives `C:` | false | the settings path is always `<config dir>\switchboard\settings.json` (`settings/paths.rs`); a drive-root settings file is unreachable | reject |
| BH6 | `help.test.ts` resets the binding override only when every assertion passes | low | a failure cascades into later tests; try/finally is a direct correction | patch |
| BH6b | module-level `knownVersion` never reset between tests | low | becomes real once VG1's test resolves it | patch (folded into VG1) |
| BH7 | `app_info` called again on each Contents visit | low | one local IPC call per visit; no user-visible cost | reject |
| BH8 | config folder has only a `title`, no visible label; no copy/reveal | low | matches the spec's look (path under the version in mono); a label/command is new surface beyond this story | reject |
| BH9 | Roadmap lists Attach in terminal and the `/clear` follow both in Next and Known limitations | false | deliberate: Next is the plan, Known limitations is what you see today, as the spec asks | reject |
| BH10 | No rule for outbound links in the root files | low | neither file has a link; the existing link test would fail any unresolved one | reject |
| BH11 | New lines in `keyboard.md` and `docs/DESIGN.md` are not wrapped like their neighbours; DESIGN credits Getting started to 10.4 | low | diff lines 272, 286–287; direct correction | patch |
| BH12 | Nothing points to the changelog after an update; no roadmap upkeep rule | false | the pointer is Story 10.5 (intent excludes it here) | reject |
| EC1 | Bracketed `## [0.1.0] - date` headings break the check | low | the file does not use brackets; switching would fail the test loudly | reject |
| EC3 | `version.workspace = true` / single quotes in Cargo.toml | low | Cargo.toml uses neither; a switch fails loudly with a clear message | reject |
| EC5 | Claim: root pages "get the same rules", yet the word budget is skipped | false | the spec's same rules are no-HTML, links and keys; the 150–400 budget is a guide-page rule (Story 10.2) | reject |
## Verification

**Commands:**
- `npx tsc --noEmit` -- clean
- `npx vitest run` -- all pass (800 + new)
- `cargo test --offline` in `src-tauri` -- unchanged pass count (no Rust change expected)
- `npm run build` -- succeeds; CHANGELOG/ROADMAP text sits in the lazy Help chunk, not in the main bundle

**Manual checks:**
- GUI pass (orchestrator): F1 → Contents shows the footer; open Changelog and Roadmap; "Help: roadmap" from the palette.

**Verification results (orchestrator, 2026-10-31):**
- `npx tsc --noEmit` clean; `npx vitest run` 818/818 (60 files); `cargo test --offline` 645 passed (no Rust change); `npm run build` OK, the changelog/roadmap text only in the lazy `pages` chunk; release `tauri build --no-bundle` OK.
- GUI pass (release exe, scratch config swapped in, existing profile): F1 → Contents ends Getting started, Changelog, Roadmap, then `Switchboard 0.1.0` with the config folder in mono; "Help: changelog" and "Help: roadmap" from the palette show the pages rendered (Unreleased → Help, 0.1.0 by area; Next/Later/Known limitations); Esc closes. The empty-canvas hint now reads "ctrl+k · F1 help" with its spaces (the Story 10.3 fix, confirmed). Real config restored; nothing left running.
- Review: 18 findings; 4 patched (VG1+BH6b, BH2, BH6, BH11), 14 rejected, none deferred. Linux CI pending (Actions suspended).
