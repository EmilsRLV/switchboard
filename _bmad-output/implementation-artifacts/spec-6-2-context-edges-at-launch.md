---
title: 'Story 6.2: Context edges at launch'
type: 'feature'
created: '2026-10-21'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'd593fe2ecba64fb31d92c125631917f03b336d6f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Context edges (Story 6.1) are only drawn. A session started on a project with a context edge to `B:\projects\ui` still cannot see that folder, and a resumed session loses the folders its edges grant. Linking is supposed to be how the operator grants directory access.

**Approach:** Rust turns context edges into `--add-dir` paths:
- **New sessions.** The project's edges prefill the launch sheet's add-dirs.
- **Resume and fork.** The session's own edges plus its project's are passed directly.
- **Unusable targets** are skipped with a visible note.

**Decisions:**
- **Edge → folder (Rust, one resolver):**
  - **Project end.** A context edge's `to` is a project: that project's folder.
  - **Branch end.** The `to` is a branch (`<projectId>:<name>`):
    - a branch with a linked worktree gives the worktree path (from the live list, as Story 5.3 resolves it);
    - the checked-out branch gives the project's folder;
    - a branch with no worktree is not usable (`no worktree`).
  - **Missing folder.** A folder that no longer exists is not usable (`folder missing`).
  - **Normalisation.** Paths are canonical, duplicates are dropped, and a path equal to the session's own cwd is dropped, as add-dirs are today.
- **New session (launch sheet):**
  - `launch_defaults` returns `addDirs` from the project's outgoing context edges. That covers both the project sheet and the branch sheet (Story 5.3) on that project.
  - The sheet prefills its add-dirs rows with them. Each prefilled row is marked `via edge → <target label>`, and the operator can remove it for this launch only.
  - The edge stays.
  - Argv carries `--add-dir <path>` for each path, as the 4.2 sheet does.
- **Resume and fork:**
  - The add-dirs are the resumed session's own context edges plus its project's, resolved against the resume cwd.
  - `build_args` passes `--add-dir` for Resume and Fork too. A prompt stays New-only.
- **Unusable targets (skip with a note):**
  - **On the sheet.** They are not prefilled. A muted line under the add-dirs lists them (`not added: feat (no worktree)`, `not added: ui (folder missing)`), and Start is not blocked.
  - **On resume or fork.** They are skipped, and a notice names them (`resumed without: feat (no worktree)`).
- **Not remembered.** Edge-derived add-dirs are recomputed at each launch, never stored in the project's launch defaults.

## Boundaries & Constraints

**Always:**
- **Rust resolves the paths.** The UI never derives an edge path itself.
- **No `~/.claude` writes, and the real `claude` never runs in tests.** Tests use stubs.
- **CI and lint.** Both CI runners stay green, and the design lint passes.

**Never:**
- Folder targets: edges to arbitrary folders that are not canvas nodes. They are deferred.
- Live sessions, which are Story 6.3.
- Cooperate edges, which are Story 6.4.
- Storing edge add-dirs in launch defaults.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Project edge | project `api` → context → project `ui` (`B:\projects\ui`); `n` on `api` | sheet add-dirs: `B:\projects\ui` (via edge → ui); argv `--add-dir B:\projects\ui` | — |
| Branch edge | `api` → branch `ui:feat` with worktree | add-dir = that worktree | — |
| No worktree | `api` → branch `ui:old` without one | not prefilled; note `not added: old (no worktree)` | Start allowed |
| Folder gone | target project folder deleted | note `not added: ui (folder missing)` | — |
| Resume | historic session `s` → context → `ui`; its project `api` → `docs` | resume argv has `--add-dir <ui>` and `--add-dir <docs>` | unusable → notice, resume proceeds |
| Fork | same as resume | fork argv has the same add-dirs | — |
| Own folder | edge target = the session's cwd | dropped | — |
| Removed on sheet | operator removes the prefilled row | not passed this time; edge unchanged | — |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/graph/mod.rs`:**
  - A new resolver `context_dirs(ws_state, from: &[NodeRef]) -> (Vec<String>, Vec<Skipped{label, reason}>)` over `Workspace.edges` (:62, `EdgeKind::Context`).
  - Project path lookup, and branch names from `<projectId>:<name>` (`branch_child_id` :277), reusing `launch::resolve_branch` (launch.rs:173) on `WorkspaceState.branches` (:726). `known_worktrees` (:731) is the fallback.
  - The `REFUSE_FOLDER` text (:1496) changes to say folder targets come later.
- **`src-tauri/src/claude/launch.rs`:**
  - `LaunchPrefill` (:105) gains `add_dirs: Vec<EdgeDir{path, via}>` and `skipped: Vec<…>`; `prefill` is at :531.
  - `build_args` (:381) drops the New-only gate for add-dirs (:404-410).
  - Update the test `resume_and_fork_change_only_the_head_and_never_pass_add_dirs_or_a_prompt` (:937).
  - `normalise_add_dirs` (:316) is reused.
- **`src-tauri/src/ipc/mod.rs`:**
  - `launch_defaults` (:911-987) fills `add_dirs` once `target_path` is known.
  - `resume_session` (:1348) and `fork_session` (:1373) set `request.add_dirs` from the session's and the project's edges (`sheetless_request` :1317), normalised against `resume_cwd`. They return the skipped ones so the UI can notify.
- **Frontend:**
  - `src/commands/launch.ts` `formFromPrefill` (:128-144, `addDirs: []` at :137) takes the prefill.
  - `src/state/launch.ts` keeps the `via` labels and the skipped note.
  - `LaunchPane.tsx` add-dirs rows (:211-243): a `via edge → X` muted suffix and the `not added:` line.
  - `src/commands/sessions.ts` resume and fork show the skipped notice (`notify`).
  - `src/ipc/index.ts` types (:461).
- **Tests:** Rust unit tests for the resolver (project, branch worktree, head, no worktree, missing folder, dedupe, own cwd), `build_args` for Resume and Fork, an IPC test (`launch_defaults` prefill; resume argv with the stub program, as in the 4.4 tests); vitest for the prefill and the notes.

## Tasks & Acceptance

**Execution:**
- [x] `graph/mod.rs`, `claude/launch.rs`, `ipc/mod.rs`, `lib.rs` (+tests) -- resolver, prefill, resume and fork add-dirs
- [x] `src/commands/launch.ts`, `src/commands/sessions.ts`, `src/state/launch.ts`, `LaunchPane.tsx`, `src/ipc/index.ts` (+vitest) -- prefill rows, notes, notices
- [x] `README.md`, `docs/DESIGN.md`, `deferred-work.md` (folder targets deferred) -- docs

**Acceptance Criteria:**
- Given a project node with a context edge to `B:\projects\ui`, when I start a session on it, then the launch sheet's add-dirs is prefilled with `B:\projects\ui` and argv contains `--add-dir B:\projects\ui`.
- Given a historic session node with a context edge, when I resume it, then the same `--add-dir` is applied.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- `graph::context_dirs(st, from, heads, own_cwd) -> (Vec<EdgeDir{path, via}>, Vec<SkippedEdge{label, reason}>)`: it takes the checked-out branch per project (`heads`, from the status poll) for a branch end when no branch list is loaded, and the session's cwd so canonicalising, dedupe and own-folder dropping happen in one place. Fallback order with no list: `known_worktrees`, then `heads`, else `no worktree`.
- A third skip reason, `not found`, covers a target project or branch that is gone (a listed branch list without the branch, an edge to a removed project).
- `LaunchPrefill` gains `addDirs`/`skipped`; `LaunchResult` gains `skipped` (empty for sheet launches).
- The resume/fork notice puts the skipped edges first so the one-line notice never cuts them: `resumed without: feat (no worktree) · resumed with model …`.
- `REFUSE_FOLDER` is now `can't link a folder yet: folder targets come later` (Rust and `src/canvas/edges.ts`).

- 2026-10-21 GUI pass (orchestrator, scratch folder projects `alpha` and `beta`, `claude.path` = the scratchpad stub that prints its argv): dragging alpha's handle to beta drew the dashed context edge; `n` on alpha opened the sheet with ADD-DIRS prefilled `C:\…\edgedemo\beta` marked `via edge → beta`; Start ran the stub with `--add-dir <…\edgedemo\beta>` in its argv and cwd alpha. Resume, fork and the `not added:` line were not driven in the GUI (the Rust IPC test and vitest cover them).

- 2026-10-21 GUI re-run after the patch round (orchestrator, same scratch projects, stub `claude`): the same result: the prefilled row `C:\…\edgedemo\beta` with `via edge → beta` (suffix laid out beside Remove), and the stub's argv carried `--add-dir <…\edgedemo\beta>`.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 (medium; V) The heads fallback through `edge_add_dirs` (status-poll HEAD, detached filtered out) and the branch sheet's own-folder choice are untested at the IPC level. Extend the Story 6.2 lib.rs test: an edge to `<project>:<head>` with branch lists off, detached, and a branch sheet with edges.
- P2 (medium; B) `context_dirs` canonicalises every target while holding the workspace read lock, so a slow drive stalls every writer. Resolve under the lock, canonicalise after it is released. Resume and fork resolve off the async runtime (`blocking`).
- P3 (low; B, E) Branch labels are the bare branch name: `via edge → feat` and `not added: main (no worktree)` don't say which project, and two different edges merge in the dedupe. Use `<project label>:<branch>`. `not found` shows raw ids: use a readable fallback (`a removed project` / `<project label>:<branch>` when the project is known).
- P4 (low; B, E, V) The Story 4.4 busy-stop doc comment now sits on the new `assert_add_dirs` helper: move it back.
- P5 (low; B) Docs:
  - the README lists the `not found` reason, the heads fallback and the fork notice (`forked without: …`);
  - a prefilled edge folder that disappears before Start is then refused as a missing add-dir, like any add-dir;
  - a fork's later Resume applies the fork's own edges, not the original's;
  - the `build_args` doc reflow and the README line-61 wrap are fixed.
- P6 (low; B) The negative argv check uses the raw text while the positive one flattens it: flatten both.
- P7 (low; B) A long project label in `.launch-dir-via` can push Remove out of a narrow pane: allow it to shrink with an ellipsis (full text in the title).

**Reject:**
- (low; B, E) A folder re-added by hand that equals an edge folder reads `via edge → …`: rare, and the path is the same.
- (low; B, E) The own-folder drop uses the project folder when the sheet may create a worktree or use `--worktree`: it only matters for an edge to the project's own checked-out branch, an unlikely edge.
- (low; E) An edge deleted while the sheet is open still passes its folder: the sheet is a snapshot, and the operator sees and can remove the row.
- (low; E) A branch created after the last list read is skipped as `not found` until the next refresh (watcher, under 2 s).
- (B) Implementation-note deviations not in the Spec Change Log: none changes the frozen intent.
- (B, V) UI rendering untested: already deferred (no DOM test environment).

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:** orchestrator, foreground-guarded, scratch projects, stub `claude` (prints its argv):
- Link `alpha` to `beta`, press `n` on `alpha`, and check the prefilled row and the stub's argv.
- Link a branch with no worktree, and check the `not added:` line.
