---
title: 'Story 8.1: Working-tree diff pane'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '288bb8eba44bb61840ea1ab30dfe22bb3c5073e1'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The canvas shows that a project or branch has changed files, but not what changed. The operator still opens VS Code per repo to review, which defeats the app's purpose.

**Approach:** Review becomes a real diff pane:
- Rust lists the changed files of a node's working tree (with git) and returns each file's old and new text.
- The frontend shows a changed-files tree with +/− counts. A selected file opens in a CodeMirror 6 merge view, side by side or unified.
- 7.4's review-request pane becomes this pane, opened on the session's folder.

**Decisions:**
- **Targets.**
  - A project node reviews its folder.
  - A branch node reviews its worktree. A branch without a worktree is refused (`no worktree`), and so is the checked-out branch, because that is the project's folder. Both are resolved as in 5.3 and never as a path from the UI.
  - A session node reviews its cwd's working tree.
  - Opening is by key `r` on a selected node, palette "Review changes", and the node menu.
- **Wide right pane (Emils' decision).** The Review pane is a draggable right pane, like the terminal pane, with a default width of `min(1100px, 85vw)`. The canvas stays visible beside it, and Esc closes it. DESIGN.md records it as the second wide pane.
- **File list (Rust):**
  - From `git status --porcelain=v2 -z` and `git diff --numstat -z`, for HEAD vs index and index vs working tree.
  - Each file has a path, a status (modified / added / deleted / renamed with the old path / untracked / conflicted) and +/− counts.
  - Untracked files count all their lines as added.
  - Linked worktrees inside the repo are excluded, as in the status poll.
- **Filter.** A three-way toggle, default All:
  - **All** compares HEAD with the working tree.
  - **Staged** compares HEAD with the index.
  - **Unstaged** compares the index with the working tree.
  The tree and the counts follow the filter.
- **File text (Rust):**
  - The old side is `git show <rev>:<path>` (HEAD, or `:path` for the index); the new side is the index or the file on disk.
  - Paths must stay inside the reviewed folder (7.4's canonical check).
  - **Not shown:**
    - A binary file (it holds NUL bytes or `--numstat` reports `-`) shows `binary file` with no text.
    - A side over 2 MB or over 50,000 lines shows `too large to show` with its counts.
    - Text that is not valid UTF-8 is shown lossily, with a `not UTF-8` mark.
- **View:**
  - **Merge view.** CodeMirror 6 with `@codemirror/merge`, read-only.
    - Side by side by default; a toggle switches to unified.
    - Word-level highlighting, and unchanged regions collapsed with a margin of 3 lines.
    - Syntax highlighting from language packs loaded on demand by file extension: JS/TS/JSX/TSX, Rust, Python, JSON, CSS, HTML, Markdown and YAML. Anything else is plain text.
    - The review code itself is lazy-loaded.
  - **Colours.** Diff colours come from new tokens in `tokens.css` (`--diff-add-bg`, `--diff-del-bg`, `--diff-add-word`, `--diff-del-word`) and are documented in DESIGN.md as diff content, like terminal content. Never the accent.
  - **Speed.** A 3,000-line file with 40 hunks renders in under 300 ms after its text arrives. The last render time shows in Diagnostics (`last diff render: N ms`).
- **Review requests (from 7.4).** Opening a session's review request opens this pane on the session's folder. The request's summary and time sit at the top, and the requested paths are listed first in the tree and selected in turn. A requested path that is not changed is shown as `unchanged`, and one that does not exist as `missing`.
- **Freshness.** The list is read when the pane opens, with a Refresh button. The list also re-reads when the node's status poll shows a change while the pane is open.
- **Rows carry their place.** Each row in the view carries its file and line, so 8.3 (`o` to open in the editor) and 8.4 (line comments) can build on it.

## Boundaries & Constraints

**Always:**
- **Rust owns the diff data.** It runs git, checks paths and reads files; the UI never builds a path or calls git.
- **Read-only.** Nothing is staged, committed or written.
- **Tests and CI.** No `~/.claude` writes, and tests never run the real `claude`. Tests use temp repos only. CI stays green on both runners once Actions resumes.

**Never:**
- Branch-vs-base and commit diffs (8.2).
- The Files mode and external open (8.3).
- Touched files and line comments (8.4).
- Stage or commit.
- Monaco.
- A git library crate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Dirty project | 2 modified, 1 untracked | tree lists 3 files with +/−; select → side-by-side diff, collapsed unchanged | — |
| Filter | 1 staged, 1 unstaged | Staged shows 1, Unstaged 1, All both | — |
| Unified | toggle | same file in unified view | — |
| Rename | `git mv a.ts b.ts` + edit | `b.ts` with `renamed from a.ts`, diff old a vs new b | — |
| Binary | changed `.png` | row with `binary file`, no text | — |
| Huge | 3 MB file | `too large to show`, counts shown | — |
| Branch | branch with a worktree | diff of that worktree | no worktree → `no worktree` |
| Clean | no changes | `No changes` | — |
| Review request | session requested `src/a.ts` | pane on its cwd, summary on top, `src/a.ts` first and selected | not changed → `unchanged` |
| Perf | 3,000 lines, 40 hunks | render < 300 ms, shown in Diagnostics | — |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- **New `git/diff.rs`.**
  - Parse `git status --porcelain=v2 -z` records `1`/`2`/`u`/`?`. The format is documented at `status.rs` :11-14; `parse_porcelain_v2` (:48-93) only counts today. Also parse `--numstat -z`, and read the file text through `git show`.
  - Use the env conventions of `status.rs` :130-133, `git::poll::git_binary` (poll.rs :349) and the excludes from `exclude_pathspec` (status.rs :112, poll.rs :296).
  - `process::run` (process.rs :93) decodes lossily. Add a bytes variant for blob reads, so binary detection works and the size cap is applied before anything is decoded.
- **Targets.** Resolve a branch with `claude::launch::resolve_branch` (launch.rs :196), as used at ipc :1366-1393. Resolve a session's cwd from the live map or its ref. Check paths with 7.4's canonical containment check in `review/mod.rs`.
- **IPC.** `review_list(target, filter)` and `review_file(target, path, filter)`, run on `blocking` (ipc :917) and registered in lib.rs :27-51.
- **Diagnostics.** `last diff render` is recorded from the UI through a small command, or kept in the frontend store; the implementer chooses.

**Frontend (`src/`):**
- Add `@codemirror/state`, `@codemirror/view`, `@codemirror/merge`, `@codemirror/language`, `@lezer/highlight` and the language packs to `package.json`. Lazy-load them with `import()`.
- **Store and command.** Generalise `state/review.ts` (:20, `openId` is a session id today) to a target (project, branch or session) with filter, layout and selected file. `commands/review.ts` `openReview` (:76-94) uses the new target.
- **Pane.** Rewrite `components/ReviewPane.tsx` (:12-56) as the tree plus merge view. Render it in `App.tsx` (:245) and handle it in `panes.ts` (:44). Width follows the terminal-pane model (`shell.css` :800-830, `ui.ts` :36-90).
- **Palette.** `commands/builtins.ts` gains "Review changes" with key `r`, gated on `noSurfaceOpen` (:105), for projects (:110-120), branches (:500-530, `selectedBranch`) and sessions.
- **Theme and docs.** `theme/tokens.css` gets the diff tokens. `docs/DESIGN.md` covers the review pane, diff colours and the width. `theme/design.test.ts` stays green.

**Tests:**
- Rust parsers with string fixtures (`status.rs` :148-257).
- Temp repos with modified, staged, renamed, untracked, binary and large files (`status.rs` :263-292).
- Vitest for pure helpers: tree building, the filter, language picking and the request ordering.

## Tasks & Acceptance

**Execution:**
- [x] `git/diff.rs`, `process.rs`, `review/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests): the file list, file text, targets, limits and containment.
- [x] `package.json`, `state/review.ts`, `commands/review.ts`, `ReviewPane.tsx` (+ the lazy diff view), `builtins.ts`, `App.tsx`, `panes.ts`, `tokens.css`, CSS (+vitest): the tree, merge view, toggles, request mode and palette.
- [x] `README.md`, `docs/DESIGN.md`: document the review pane, its keys and limits, and the diff colours.

**Acceptance Criteria:**
- Given a project with a dirty working tree, when I press `r`, then a changed-files tree with +/− counts appears, and selecting a file shows a side-by-side merge view with syntax highlighting, word-level diff and collapsed unchanged regions. The unified toggle and the staged/unstaged filter work.
- Given a 3,000-line file with 40 hunks, when it opens, then Diagnostics shows a render time under 300 ms.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- Implementation (by the implementer; see its report): `git/diff.rs` (porcelain v2 `-z` and numstat `-z` parsers, the filters, `file_text` with binary / too-large / not-UTF-8 handling), `process::run_bytes`, `review::ReviewTarget`, and the IPC commands `review_list`/`review_file`. Frontend:
  - `src/review/` (model, DiffView, languages, lineDiff);
  - the rewritten `ReviewPane`, a wide draggable pane;
  - "Review changes" on `r`, plus `j`/`k` file stepping;
  - the four `--diff-*` tokens;
  - the "last diff render" row in Diagnostics.

  Two deviations:
  - `review/lineDiff.ts` replaces `@codemirror/merge`'s default diff, because the default merged 40 spread-out hunks into one chunk.
  - `r` is enabled while the palette or menu is open, so it still appears there.

  The review code loads lazily: ReviewPane is 12 kB, DiffView 34 kB, and the CodeMirror core about 271 kB as its own chunk, so the main chunk grew by about 8 kB.
- 2026-10-25 GUI pass 1 (orchestrator; scratch repo `reviewdemo81` with modified, staged, untracked, renamed, binary and 3,000-line/40-change files):
  - `r` opened the wide pane with the six files and their counts (`renamed from src/old_name.ts`, `binary file`, untracked `U`).
  - Side by side showed word-level marks and collapsed regions.
  - **Clicking Unified blanked the whole app**, and TypeScript showed no syntax colours. Cause: npm `overrides` had nested duplicate `@lezer/common` copies (8 in the bundle), so tags did not match the highlighter, and an editor built inside React threw with no error boundary.
  - Fix: the overrides were replaced by exact direct dependencies, giving one copy of each package. Error boundaries now wrap the pane and the diff view, and editor construction sits in try/catch. A test fails on any nested `@codemirror`/`@lezer` copy.
- 2026-10-25 GUI pass 2 (after the fix, same repo):
  - Unified on `big.ts` rendered with syntax colours (keywords, strings, numbers) and word-level marks.
  - Staged showed 2 files: the staged rename `+0 -0` and `notes.md +1 -0`.
  - Settings → Diagnostics showed `last diff render 21 ms` after `big.ts` (3,000 lines, 40 hunks) side by side.

- 2026-10-25 GUI pass 3, after review round 1 (same repo): `r` opened the pane with the same six files. Unified on `big.ts` showed syntax colours and word marks. Unstaged showed 5 files (`notes.md`, staged only, gone; `new_name.ts` with its unstaged `+1 -0`). Esc closed the pane.
- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away, as for 6.4 and 7.1–7.4): cargo test (522), clippy, tsc, vitest (597), the debug build and three GUI passes. **Linux CI is pending:** GitHub Actions is suspended. Emils' check is still open: review a real repository.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V). Emils is away, so I triaged under his standing authorisation; no finding needed a change to the frozen text.

**Patch:**
- P1 (high; B, E) On Windows, with `core.autocrlf=true` or eol attributes, the old side comes from the blob with LF endings and the new side from disk with CRLF, so every line shows as changed. Normalise line endings on both text sides before sending them (CRLF to LF), and pass `--no-textconv` to `git show`. Do not run smudge filters, which could fetch LFS over the network. Test with `core.autocrlf=true`.
- P2 (medium; B, E) Refresh does not re-read the selected file when the list comes back unchanged in JSON. Key the file effect on `refreshSeq` as well.
- P3 (medium; B, E, V) A branch target, or a session in a linked worktree, never refreshes by itself: the project status poll leaves linked worktrees out. While the pane is open on a target outside the project folder, re-read its list every `poll.git_ms`, and replace it only when it changed.
- P4 (low; B, E) After a layout toggle, `last diff render` counts from when the text first arrived. Measure a re-render from the start of the effect.
- P5 (medium; B, E) Speed of large reads:
  - `file_text` re-runs the whole list, including counting the untracked files, on every click.
  - `count_untracked` reads untracked files of any size in full.

  Fixes: look up only the selected entry and skip counting in `file_text`; stop counting an untracked file past `MAX_SIDE_BYTES` (mark it `too large`); cap a list at 5,000 rows, with `N more files not shown`.
- P6 (low; B, E) A submodule (status sub field `S…`) leads to a git error. Show it as `submodule` with no text.
- P7 (low; B, E) `status` follows the user's rename config while `numstat` forces `-M`. Pass the same rename setting to both, so their rows and counts agree.
- P8 (low; E) Status edge cases:
  - an intent-to-add file (`.A`) is shown as Added;
  - a conflicted file added on either side (`AA`, `AU`, `UA`) has no HEAD side;
  - `git rm --cached` (both `D.` and `?`) becomes one row, `deleted from index, still on disk`;
  - a path that is not valid UTF-8 is listed as `unreadable name`, with no text;
  - index reads use the explicit `:0:<path>` form.
- P9 (low; B) Request paths are matched as literal text: an absolute add-dir path, `./a`, or a Windows `a` never matches. Rust maps requested paths to keys relative to the list, and a path outside the reviewed folder gets the mark `outside this folder`.
- P10 (low; B) `j`/`k` skip the requested `unchanged`/`missing` rows and jump away from them. Include those rows in the stepping order.
- P11 (low; E) `lineDiff` can freeze the UI on two near-50,000-line sides. Lower the edit budget for large inputs, falling back to a coarse block diff.
- P12 (low; E) In the unified view, deleted lines carry no file and line (the frozen text says each row does). Tag the deleted lines with `data-side=old` and their old line number.
- P13 (low; B) Screen readers do not announce the status word. Put it in each row button's accessible name. Make the `ErrorBoundary` log label a prop.
- P14 (low; V) `FileState.key` leaves out the target. Include it.
- P15 (medium; V, B) Tests:
  - a session target resolves to its cwd, and an unknown cwd gives `NO_FOLDER`;
  - pin the `binary` and `too_large` wire tags;
  - a staged rename then deleted from disk (`R` + `D`);
  - `read_disk`: symlink text, and a path outside refused;
  - the store's `refreshSeq` after a repeat request;
  - temp-repo cases: a deleted file, a conflicted file, an untracked binary, a HEAD side that is not UTF-8, a file too large by line count only, autocrlf, intent-to-add and a submodule if it can be built offline.

**Defer:**
- (low; B, V) A DOM render test of the 300 ms target and of the Diagnostics wiring. There is no DOM test environment; the GUI pass measured 21 ms.
- (low; B) Tree semantics (`role=tree`, arrow keys, folder levels) beyond the accessible names in P13.

**Reject:**
- (B) The first measurement includes the lazy chunk load: that is the operator's real wait the first time. Later renders measure the view alone (P4).

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator, foreground-guarded, scratch repo:** with modified, staged, untracked, renamed, binary and 3,000-line files:
  - `r` opens the tree;
  - side by side, then unified;
  - the filter;
  - the render time in Diagnostics.
- **Emils:** review a real repo.
