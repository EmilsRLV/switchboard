---
title: 'Story 8.3: File browser and external open'
type: 'feature'
created: '2026-10-25'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '0877f08316d3194df736604fdcf8b25d68a85a6b'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Review pane shows only changed files. The operator cannot look at any other file of the repo, or jump from what they are reading to their own editor at the same line, so the last step still means hunting for the file by hand.

**Approach:**
- The Review pane gains a **Files** mode: a lazy tree of the node's folder, with gitignored entries dimmed, and a read-only CodeMirror view of the selected file.
- Pressing `o` runs the configured editor command at that file and line. It works on a diff line in any mode and on the Files viewer.
- When no editor is configured, `o` tells the operator and opens Settings.

**Decisions** (taken by the orchestrator under Emils' standing authorisation while he is away, recorded for his review):
- **Files mode.**
  - **Where it is offered:** wherever the pane has a folder: a project, a branch with a worktree, or a session.
  - **Tree:**
    - Each folder's children are read when it is first expanded (Rust `read_dir`).
    - Folders come first, then names sorted case-insensitively. Dotfiles are shown.
    - `.git` and linked worktrees inside the repo are left out.
    - Entries gitignored according to `git check-ignore --stdin -z` are listed dimmed.
    - At most 2,000 entries per folder, with `N more not shown`.
    - Symlinks are shown as links and are not followed.
    - Every path stays inside the folder (7.4's canonical `within`).
  - **Viewer:**
    - Read-only CodeMirror with the 8.1 language packs.
    - 8.1's limits apply: `binary file`, `too large to show` (over 2 MB or 50,000 lines), `not UTF-8`, and CRLF shown as LF.
    - Refresh re-reads the open folders and the open file.
- **`o` (Open in editor).**
  - **Triggers:** key `o` while the Review pane is open, and a palette command "Open in editor".
  - **Line:**
    - The line is the line at the cursor of the focused editor view, else the first visible line.
    - A line on the old side, or a deleted line, opens the new file at the nearest new line.
  - **File:**
    - In Changes and Files, the file is `<folder>/<path>`.
    - In vs base and Commits, it is the file in the branch's worktree. If the branch has no worktree, it is the project folder when that branch is checked out there.
    - Otherwise `o` is refused with `this branch is not checked out anywhere`.
    - A file that does not exist on disk is refused with `not on disk: <path>`.
  - **Command:**
    - The `external_editor` template is split into arguments (quotes respected), and `{file}` and `{line}` are replaced in each argument.
    - It is run detached through the existing editor-launch path, which resolves the program on PATH (including `.cmd` on Windows).
    - The default stays `code -g {file}:{line}`, set at first run when `code` is on PATH.
  - **Not configured:** the notice `No external editor set: add external_editor to settings`, and the Settings pane opens.
- **Never `o` outside the pane.** Typing in an input is unaffected, as for all bare keys.

## Boundaries & Constraints

**Always:**
- **Rust owns the data.** It lists folders, reads files, checks paths and builds the command. The UI sends the target, a relative path and a line.
- **Read-only.** The app itself never writes files.
- **Tests:**
  - no `~/.claude` writes, and the real `claude` never runs;
  - the editor launch is tested with the argv recorder, never a real editor;
  - temp folders only.

**Never:**
- Editing files in the app.
- Touched files or comments (8.4).
- Following symlinks out of the folder.
- Opening a path the UI sends unchecked.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Files tree | project with `src/`, `node_modules/` (ignored), `.git/` | `src/` normal, `node_modules/` dimmed, no `.git` | — |
| Expand | click `src/` | its children read now, not before | unreadable → error row |
| View | select `src/a.ts` | read-only, highlighted | binary/too large → line |
| `o` in diff | cursor on new line 42 of `a.ts` | editor argv `-g <folder>/a.ts:42` | — |
| `o` on deleted line | unified deleted line | opens new file at nearest line | file gone → `not on disk` |
| `o` vs base | branch with worktree | opens the worktree's file | no worktree, not checked out → refused |
| No editor | `external_editor: null` | notice + Settings pane opens | — |
| Quoted program | `"C:\Program Files\Ed\ed.exe" --line {line} {file}` | argv split right, placeholders filled | missing program → error notice |

</frozen-after-approval>

## Code Map

**Rust (`src-tauri/src/`):**
- **Editor launch** (`ipc/mod.rs`):
  - Reuse `project_open_editor` (:748-760): `editor_program` (:814), `resolve_program`/`locate_program` (:826/:843), `process::spawn_detached` (process.rs :189-201) and `NO_EDITOR` (:24-25).
  - `editor_command` (:857-861) passes only the folder today. Add a template builder that splits the template into argv and fills `{file}`/`{line}` in each argument.
  - Keep `project_open_editor`'s behaviour.
- **Files mode** (`git/diff.rs`, or a new `git/files.rs`):
  - `list_dir(git, folder, rel)` runs `read_dir` plus `git check-ignore --stdin -z`, leaving out `.git` and the linked worktrees (`Repo.excludes`, `repo()` :474-519).
  - `file_view(folder, rel)` reuses `read_disk` (:651-668) and `content_of` (:672-702).
  - Containment uses `review::within` (`review/mod.rs` :482).
  - The folder comes from `target_folder` (:426-450). For vs base and Commits, `branch_folder` (:416) gives the `o` resolution.
- **IPC.** Add `review_dir`, `review_view` and `review_open_editor(target, mode, path, line)`, and register them in `lib.rs`.
- **Settings.** `external_editor` (`settings/mod.rs` :59-60, default :172-185). Update the README row (:1321).

**Frontend (`src/`):**
- `review/model.ts`: `ReviewMode` (:19-29) gains `files`, and `modesFor` offers it.
- State and pane: `state/review.ts`, plus the `ReviewPane.tsx` tree and viewer. The viewer can reuse the `DiffView` CodeMirror setup in a single-view variant.
- `review/DiffView.tsx`: expose the focused view's cursor line and side (views at :201; `placeAttributes` :99-115; `deletedLinePlaces` :122-156). For old or deleted lines, map to the nearest new line from the chunks.
- `commands/review.ts` and `builtins.ts`: `review.openEditor` on key `o`, gated like `review.nextFile` (:696-710), plus the "Files" mode command. Update the tests in `builtins.test.ts` and `keybindings.test.ts`.
- **No-editor case.** Show the notice, then `openPane("settings")`, following `commands/navigation.ts` :219-222 and `builtins.ts` :194-197.
- **Docs.** README: Review Files mode, the `o` key, the editor template. DESIGN.md: dimmed entries and the viewer.

**Tests:**
- Rust: `list_dir` against a temp repo with ignored, dot, link and nested entries; `file_view` limits; the template split (quotes, placeholders); the `o` resolution per mode; the editor spawn through `process::fixtures::argv_recorder` (lib.rs :652-691).
- Vitest: Files mode model, `o` gating, and the cursor-to-line mapping as a pure helper.

## Tasks & Acceptance

**Execution:**
- [x] `git/files.rs` (or `diff.rs`), `review/mod.rs`, `ipc/mod.rs`, `lib.rs` (+tests): dir listing, file view, the editor template, and `o` resolution.
- [x] `review/model.ts`, `state/review.ts`, `ReviewPane.tsx`, `DiffView.tsx`, `commands/review.ts`, `builtins.ts`, `ipc/index.ts`, CSS (+vitest): Files mode, viewer, `o`.
- [x] `README.md`, `docs/DESIGN.md`: the docs above.

**Acceptance Criteria:**
- Given a node, when I switch the Review pane to Files, then a lazy tree of the folder appears with gitignored entries dimmed, and a selected file opens read-only.
- Given a diff line, when I press `o`, then the configured editor command runs with that file and line. With no editor configured, a notice appears and Settings opens.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass.

## Implementation Notes

- **Rust.** New `git/files.rs`: `list_dir` (`read_dir`, folders first then case-insensitive names, `.git` at any depth and linked worktrees left out, 2,000 cap with `more`, links/junctions as `link`, never followed) with one `git check-ignore --stdin -z` per folder over its entries plus the folder itself (everything under an ignored folder is ignored; each path is sent as `./<path>` because `GIT_LITERAL_PATHSPECS` is refused by check-ignore and a leading `:` would be pathspec magic); `file_view` reuses `read_disk` + `content_of`; `parts`/`resolve`/`on_disk` check UI paths (plain names only; `\` and `:` refused on Windows only) and containment via `review::within`. `process::run_bytes_with_input` added for stdin. `review/mod.rs`: `ReviewMode`, `NOT_CHECKED_OUT`, `branch_editor_folder` (worktree + the project's subfolder prefix, else the project folder when checked out there) and `editor_folder`. `git::range::prefix` is now `pub(crate)`. `ipc`: `review_dir`, `review_view`, `review_open_editor`, `split_template` (double quotes group; backslashes literal), `editor_args` (single-pass `{file}`/`{line}` fill), `NO_EDITOR_SET`; `project_open_editor` unchanged.
- **Small choices not fixed by the spec:** a template with no `{file}` gets the file appended as the last argument; line `0` is sent as `1`; the no-editor check runs before any path check; only double quotes group in the template (an apostrophe in a Windows path stays literal).
- **Frontend.** `ReviewMode` gains `files` (last in the toggle); `modesFor(target, hasFolder)` and `reviewModes`/`targetHasFolder` (a branch has a folder only with a non-missing worktree). Store keeps `filesOpen` (reset per target; closing a folder closes its subfolders). `FilesBody` in `ReviewPane.tsx` reads folders lazily (closed folders are forgotten, so reopening re-reads; Refresh re-reads every open folder and the open file; stale replies dropped by a per-folder read id). `review/place.ts` is a CodeMirror-free line-provider registry; `DiffView.tsx` registers one per mounted view (last clicked view's cursor; an old-side line or a unified deleted line is mapped through `lineChunk` + `oldToNewLine`; else the first visible new line) and exports `SourceView` (Files viewer, same chunk). `review.openEditor` (`o`, `when`: pane open and no context menu, so the palette lists it; bare keys never fire from inputs) and `review.modeFiles`. Ignored rows are `--fg-muted`; unreadable names a disabled `--fg-faint` row.
- **Review fixes.** The editor program may not contain `{file}`/`{line}` (refused). UI paths refuse `.git` (any case on Windows), Windows device/alias names and trailing dot/space, linked-worktree paths (`Scope`, one `git worktree list` per request) and any path through a link; control-character names are listed unreadable; unreadable entries count in `more`; check-ignore output is capped and runs inside a nested repository/submodule (its top never asked). A branch missing from the branch list is `NOT_CHECKED_OUT` for `o`. The argv recorder records every argument (Windows: delayed expansion). Store: `openTarget`/`setMode` take `hasFolder`; entering Files from Changes keeps a real file selection and opens its ancestors. DiffView tracks the cursor through an update listener (pointer downs only inside `contentDOM`; a deleted-line mapping survives only its own click) and picks the line with the pure `editorLine`; `foldersToRead` is the pure read decision. `openInEditor` checks the settings' editor first.
- **Verification.** `cargo test` (546 pass), `cargo clippy --all-targets -D warnings` clean, `npx tsc --noEmit` clean, `npx vitest run` (620 pass), `npm run tauri build -- --debug --no-bundle` builds. New Rust tests: files listing/ignore/worktree/cap/limits/links (the file-symlink case is skipped on this machine without the symlink privilege; the junction case ran), template split/fill, `o` folder resolution, and an IPC test running `o` through a new `argv_lines_recorder` fixture (quoted program path with a space, Changes/Files/vs base worktree/checked-out branch, refusals). No manual app run was done (not allowed in this environment): the orchestrator's manual checks remain.

- 2026-10-25 GUI pass (orchestrator; scratch repo `reviewdemo81` plus `.gitignore` `node_modules/`, `node_modules/pkg/index.js` and `src/deep/x.ts`):
  - **No editor.** With `external_editor` unset, `o` on a diff line showed `No external editor set: add external_editor to settings` and opened Settings.
  - **Recorder.** `external_editor` was then set, with a live reload, to a PowerShell recorder that writes `{file}|{line}` to a file. No real editor was used.
  - **`o` in Changes.** On `auth.ts`, after clicking new line 11, the recorder got `…\reviewdemo81\src\auth.ts|11`.
  - **Files tree.** It showed `node_modules/` dimmed, `src/`, `.gitignore`, `big.ts`, `logo.png` and `notes.md`, and no `.git`. Expanding `src/` showed `deep/`, `auth.ts`, `new_file.rs` and `new_name.ts`.
  - **Viewer and `o` in Files.** `auth.ts` opened read-only with syntax colours. Clicking line 8 and pressing `o` recorded `…\src\auth.ts|8`.

- 2026-10-25 GUI re-run after review round 1 (same repo and recorder):
  - `o` in Changes on `new_file.rs` recorded the cursor's last line, `|4`. The two Down presses could not move past it, so keyboard tracking is covered only by the `editorLine` tests.
  - Files mode expanded `src/` and `deep/`, and viewed `auth.ts` read-only.
- 2026-10-25 Closed on local Windows verification (orchestrator, under Emils' standing authorisation while he is away): cargo test (549), clippy, tsc, vitest (625), the debug build and two GUI passes. **Linux CI is pending.** Emils' check is still open: `o` with his real editor (`code -g`).

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter B, edge-case-hunter E, verification-gap V). Triaged by the orchestrator under Emils' standing authorisation; no change to frozen text.

**Patch:**
- P1 (high; B) A `{file}` or `{line}` in the template's program argument lets `o` run the reviewed file itself, for example a `.cmd` in the repo. Refuse such a template with `the editor program cannot contain {file} or {line}`. Test it.
- P2 (medium; B, E) Path rules are not enforced on the Rust side:
  - `.git` and the linked worktrees are hidden from the listing but reachable by path. Refuse them in `parts`/`resolve`.
  - On Windows, `.GIT`/`.Git` are not hidden. Match the name without regard to case.
  - Windows device and aliasing names (`CON`, `NUL`, `COM1`, `aux.txt`, a trailing dot or space) are allowed. Refuse them.
  - A link part-way along a path is followed. Refuse any path that passes through a link, as the spec says links are not followed.
  - A read_dir name with control characters is selectable and fails on use. Mark it as an unreadable name.

  Add negative tests for each.
- P3 (medium; B, E) Mode carry-over:
  - Switching to Files keeps a Changes selection, which may be a `req:` key or a file under closed folders. On entering Files, keep the selection only if it is a real path, and open its ancestor folders. Otherwise clear it.
  - Opening a branch without a usable worktree while in Files leaves the pane in Files. `openTarget`/`setMode` must respect the target's modes, through `hasFolder`.
- P4 (medium; B, E) The line `o` uses:
  - a cursor moved by keyboard is ignored;
  - a deleted line's mapping stays after the cursor moves;
  - a pointerdown on a scrollbar or gutter counts as a click.

  Track the selection through an update listener, clear the deleted-line mapping when the selection changes, and count only clicks inside `contentDOM`. Pull the line choice out into a pure helper and test it, covering an old-side line, a deleted line and the fallback.
- P5 (low; E, B) With no editor set and no file selected, the notice is `no file selected`, so the operator never learns the editor is missing. Check the editor first.
- P6 (low; B, V) The `NO_EDITOR_SET` text is matched as a string. Assert the literal text in the Rust IPC test, beside the TS constant.
- P7 (low; B, E) If one checked path is inside a submodule, `check-ignore` exits 128 and nothing is dimmed. Leave submodule and nested-repo paths out of the check, or retry without them. Document the `submodule` viewer line.
- P8 (low; B) The listing loses entries and repeats work:
  - entries that fail to read vanish; count them in `more`;
  - `git worktree list` runs once per folder; compute it once per request;
  - the `check-ignore` output has no cap; give it one.
- P9 (low; E, B) The `o` branch lookup:
  - a branch missing from a stale workspace list gives `branch not found` rather than the documented refusal; re-read the branch list, or map it to `NOT_CHECKED_OUT`;
  - the IPC test accepts either error and ignores the refresh; make it check `NOT_CHECKED_OUT` deterministically.
- P10 (low; B) Docs:
  - the README `o` section names the `no file selected` refusal;
  - it says that in vs base/Commits the line comes from the shown commit, while the file opened is the working copy, so the line can drift;
  - DESIGN.md adds the `submodule` and `unreadable name` viewer lines.
- P11 (low; B) The recorder fixture records only `%~1`–`%~4` on Windows. Make it record every argument on both systems, and add a `.cmd` editor test with a file path containing a space and `&`.
- P12 (low; V) Tests:
  - the `review_dir` wire format: the `kind` values and the `unreadableName` key;
  - `o` in vs base for a subfolder project with a branch worktree (`<worktree>/<sub>/<path>`);
  - the choice of which folders to read, pulled out of the component into a pure helper and tested for Refresh and reopen.

**Defer:**
- (low; B, V) Component render tests for `FilesBody`'s read ids and stale-reply dropping. There is no DOM test environment; P12 covers the decision logic.

**Reject:**
- None.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:**
- **Orchestrator** (foreground-guarded, scratch repo; `external_editor` set to a small recorder command that writes its arguments to a file, never a real editor):
  - Files tree: dimmed ignored entries, expanding a folder, viewing a file.
  - `o` on a diff line, then check the recorder's file.
  - `external_editor: null`, then `o`: the notice appears and Settings opens.
