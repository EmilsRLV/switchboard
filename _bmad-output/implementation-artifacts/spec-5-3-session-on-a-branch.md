---
title: 'Story 5.3: Session on a branch'
type: 'feature'
created: '2026-10-20'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'df6c75edb42d3d99647816a066e9a868abf9ed78'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A new session always starts in the project folder. On a branch card, `n` does nothing, so the work cannot run in that branch's checkout. A session started by hand in a worktree also lands on the canvas only if the app happens to know that worktree's path.

**Approach:** `n` on a branch card opens the launch sheet (Story 4.2) aimed at that branch: its worktree, or the project folder for the checked-out branch. Rust resolves the folder and runs `claude` there. It records the branch's worktree path and the session's branch, so the new session card is drawn under its branch card. A branch without a worktree gets its worktree created from the same sheet, then the session starts in it. `claude --worktree` is offered on the project's launch sheet, because it always makes its own new branch.

**Decisions:**
- **Command:** `branch.newSession`, "New session…", key `n`, in the branch node menu (order 52) and the palette. It is enabled on a branch card that has a worktree chip that is not `missing`, or that is the checked-out (`*`) branch, or that has no worktree (then the sheet creates one).
- **The sheet:**
  - The launch sheet is reused.
  - Its subtitle says `Starts claude on <branch> in <folder>`, where the folder is the worktree path, or the project folder for `*`.
  - Every field, default and key stays as in Story 4.2.
  - Add-dirs equal to the target folder are dropped, as the project folder is today.
- **Rust owns the target:**
  - **The request.** `LaunchRequest` gains `branch: Option<String>`.
  - **Resolving the folder.** Rust looks the branch up in its latest branch list for the project: a linked worktree's path (it must exist), the project folder for the checked-out branch, or else a refusal shown in the sheet (`branch not found`, `worktree folder missing`). It never uses a path sent by the UI.
  - **The prompt.** The system prompt's branch is that branch.
- **Branch without a worktree ("Create worktree here"):**
  - **The section.** The launch sheet gains a "Worktree" section above the session fields: `Creates a worktree for <branch>`, and Rust's exact Story 5.2 plan for `{ mode: existing, branch }`, for example `git worktree add <repo>/.worktrees/<branch> <branch>`.
  - **One Start.** A single Start is the consent to both actions. It creates the worktree as `worktree_add` does (branch lock, `worktreePath` stored, branches on, re-read) and then starts `claude` in it.
  - **The add fails.** A refusal or git error shows in the sheet, and nothing starts.
  - **The add succeeds but the start fails.** The worktree stays, the card gets its chip, and the start error shows in the sheet, as a 4.2 start error does.
  - **No `--worktree` here.**
- **`claude --worktree` (project sheet only):**
  - **The option.** The project's launch sheet (`n` on a project) gains an option: "Let Claude make a worktree (`--worktree`)" with a "Worktree name" field. The name is prefilled from the session name, slugged, and the field states that Claude creates the new branch `worktree-<name>` from the repo's default branch in `<repo>/.claude/worktrees/<name>`.
  - **What runs.** `--worktree <name>` is added to the argv, and `claude` runs from the repo's top level.
  - **Validation.** The name must pass `git check-ref-format --branch worktree-<name>`.
  - **Mapping.** Before spawning, Rust stores a `BranchNode { name: worktree-<name>, worktreePath: <top>/.claude/worktrees/<name> }` and a `SessionRef { branchId }`. The ref keeps the node from being pruned until git lists the branch. The live cwd then maps to that branch.
  - **Other locations.** A Claude configured to put its worktrees elsewhere lands in the Elsewhere tray until Story 5.4.
- **Mapping:**
  - Before spawning, Rust upserts the branch's `BranchNode.worktreePath` (canonical) for a linked worktree, as Story 5.2 does. Pre-existing worktrees then map too.
  - It writes a `SessionRef { sessionId, projectId, branchId: <projectId>:<name> }`.
  - The live session's cwd then resolves to that project and branch.
- **Layout:**
  - While the project's branches are shown, a session whose `branchId` names a listed branch card is drawn directly under that branch card, indented by one `COLUMN_INDENT`, in the branch group. It does not count toward either group's limit.
  - Otherwise it stays in the session group.
  - Moving and selecting work as for any session card. Arrow keys follow the drawn order.

## Boundaries & Constraints

**Always:**
- **Never runs `claude` for real in tests.** Tests use the existing stub-program pattern.
- **No `~/.claude` writes.**
- **Git writes in tests only in temp repos.**
- **Rust owns cwd resolution and refs.**
- **CI and lint.** Both CI runners stay green, and the design lint passes.

**Never:**
- Discovering historic transcripts whose cwd is a worktree, or listing them under branches. That is Story 5.4: until then, a session started on a worktree branch shows while live, but its transcript is not listed after a restart.
- Remove worktree.
- Branch checkout in the project folder.
- Fetch.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Worktree branch | `n` on `feat` (chip `…/.worktrees/feat`) | sheet "on feat in …/.worktrees/feat"; Start runs `claude` with that cwd; card under `feat`, indented | — |
| Checked-out | `n` on `main *` | cwd = project folder; card under `main` | — |
| Pre-existing worktree | worktree made in a terminal, not by the app | same as worktree branch; `branches[]` gains its `worktreePath` | — |
| Missing | chip `missing` | `n` disabled | Rust refusal if raced: `worktree folder missing` |
| Branches off | session with `branchId`, toggle off | card in the session group | — |
| Branch gone | branch deleted after launch | card back in the session group | — |
| No worktree | `n` on `feat` (no chip) | sheet shows `git worktree add <repo>/.worktrees/feat feat`; Start creates it, then starts `claude` there; card under `feat` | add refused → sheet error, nothing starts |
| `--worktree` | project sheet, option on, name `spike` | argv has `--worktree spike`, cwd = repo top; card under `worktree-spike` once listed | bad name → inline error |

</frozen-after-approval>

## Code Map

- **`src-tauri/src/claude/launch.rs`:**
  - `LaunchRequest` (:79) gains `branch`.
  - `build_args` (:261) is unchanged.
  - `normalise_add_dirs` (:196) compares against the target cwd.
  - `system_prompt` (:223) takes the target branch.
- **`src-tauri/src/ipc/mod.rs`:**
  - `launch_session` (:853): resolve the cwd (`cwd: path` at :875) from the branch list (`WorkspaceState.branches`, the 5.1 `BranchInfo.worktree` chip; `head` gives the project path).
  - `prepare_launch` (:1056) takes the branch.
  - `run_launch` (:1079) registers with the resolved cwd (`map.launched` :1112). Write the ref and upsert the worktree path first.
- **`src-tauri/src/graph/mod.rs`:**
  - Reuse `upsert_created_branch` (5.2).
  - Add a `set_session_branch(session_id, project_id, branch_id)` that writes a `SessionRef`, modelled on `set_forked_from`.
  - `children_with_branches` (:358) already takes `branch_id` from `branch_for_cwd` or the ref (:395/:411/:441).
  - `project_for_cwd` (:510) already matches stored worktree paths.
- **Frontend:**
  - `src/commands/sessions.ts` `openLaunchSheet(projectId, branch?)` (:34) and `startLaunch` (:64).
  - `src/state/launch.ts` holds `branch` and `targetPath` (from `launch_defaults`'s reply, which Rust fills).
  - `src/commands/launch.ts` `launchRequest` (:119) and `withAddDir` (:152, compare against the target).
  - `LaunchPane.tsx` subtitle (:65).
  - `builtins.ts` adds `branch.newSession` on `n` (`project.newSession` is at :292; `selectedBranch` is in `navigation.ts:235`).
  - `src/canvas/nodes.ts`: `projectColumn` (:223), `groupOf` (:105), `columnSlot` (:154), `toFlowNodes` (:344), and the arrow-key order.
- **`--worktree` facts** come from https://code.claude.com/docs/en/worktrees.md and the CLI reference. How it combines with `--session-id` and `--settings` is **not documented**, so the session id may not survive. The manual check covers it with the real binary, run by Emils, not by agents.
- **Tests:** stub `claude` as in the 4.2 launch tests, and the temp-repo helpers in `git/branches.rs` tests.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/claude/launch.rs`, `ipc/mod.rs`, `graph/mod.rs`, `lib.rs` (+tests: cwd per branch kind, refusals, ref and worktree path written, live row mapped to the branch) -- target resolution and mapping
- [x] `src/commands/*`, `src/state/launch.ts`, `LaunchPane.tsx`, `src/canvas/nodes.ts`, `src/ipc/index.ts` (+vitest: command `when`, request, nested layout, limits, arrow order) -- UI
- [x] `README.md`, `docs/DESIGN.md` -- sessions on branches

**Acceptance Criteria:**
- Given a branch card with a worktree, when I press `n` and Start, then `claude` runs with cwd = the worktree path and its session card appears under the branch card.
- Given `cargo test`, `clippy -D warnings`, `npm test` and `tsc --noEmit`, when they run, then all pass on both platforms.

## Implementation Notes

- 2026-10-20 GUI pass (orchestrator, scratch demo repo `gitdemo53`: `main`, `feat` with a worktree made in a terminal, `nowt` with none; `claude.path` set to a stub exe in the scratchpad that prints its cwd and argv, so the real `claude` never ran): `n` on `feat` opened the sheet `Starts claude on feat in …\.worktrees\feat`; ctrl+Enter started the stub with cwd `…\gitdemo53\.worktrees\feat` and `Branch: feat` in the system prompt; its card sat indented under `feat`; `branches[]` gained `feat`'s `worktreePath` and `sessions[]` a ref with `branchId …:feat`. `n` on `nowt` showed the Worktree section with `git worktree add …\.worktrees\nowt nowt`; one Start created it (git lists it), `nowt` gained its chip and the stub ran in it, card under `nowt`; `main · 0 changed` throughout. App and stubs gone after cleanup. `--worktree` not driven in the GUI (stub tests cover the argv; the real-binary check is Emils').

- 2026-10-20 GUI re-run after the patch round (orchestrator, fresh `gitdemo53`, stub `claude`): same result as the first pass: `feat` session in `…\.worktreeseat` under `feat`; `nowt` worktree created by the one Start, its session under `nowt`; both refs carry their `branchId`; `main · 0 changed`; nothing left running after cleanup.

## Spec Change Log

## Review Triage Log

Round 1 (blind-hunter, edge-case-hunter, verification-gap):

**Patch:**
- P1 (medium; B, E) Nested sessions do not follow their branch card: a dragged branch card leaves them in the column slot, and a dragged card past the limit drops them. Draw them under the card's drawn position. Tests.
- P2 (medium; B) A nested session under a branch card cut by the limit is not drawn anywhere (a live or attention session vanishes; `attention.next` has no node). While its branch card is not drawn, the session falls back to the session group. Test.
- P3 (medium; B, E, V) Incomplete rollback on a failed start: a `BranchNode` upserted by this launch (notably `worktree-<name>` for `--worktree`) stays. Remove a node this launch created when the start fails. A pre-spawn `upsert_created_branch` failure is only logged and the spawn goes on unmapped: fail the launch instead (give the id back). Tests: a failed spawn on a branch launch and on a `--worktree` launch leave no ref and no new node, and the id can be retried.
- P4 (medium; V, B) "Worktree made, start fails" is untested, and the sheet then still shows the Worktree section and plan. Test it (folder and chip stay, `worktreePath` stored, no ref, retry starts). On that failure the UI re-reads `launch_defaults` so the sheet shows the new target.
- P5 (low; E) Resume of a session started on a worktree branch sends no branch, so its system prompt names the project's checked-out branch: resume and fork take the branch from the session ref's `branchId`.
- P6 (low; B, E) The TS worktree-name check differs from Rust: check `worktree-<name>` (not the bare name), refuse `<>"|` on Windows, and make the slug avoid a part ending in `.lock`.
- P7 (low; B, V) Dead `launch_session` (no callers, refuses `createWorktree`) removed. Stray blank line after `start_claimed` removed. README: Re-layout keeps a branch "with a stored worktree path" (not only app-created ones).

**Reject:**
- (false; B) Branch looked up by display label: a branch card's label is always the git name (`label: info.name.clone()`), as in 5.2.
- (false; E) `set_session_branch` rollback does not restore a previous `branchId`: the ref is written for a freshly proposed session id, so no previous ref exists.
- (low; B, E) `--worktree` with an existing `worktree-<name>` branch or folder: Claude's documented behaviour reopens it, and the mapping stays right.
- (B) Same folder in different groups (project sheet vs `main *` card): by design, the branch launch names its branch.
- (B) Thin ACs and `cargo fmt --check` missing from Verification: fixes edit this spec.
- (low; B) Windows skips the prompt-branch assertion, and the argv check accepts two forms: the GUI pass showed `Branch: feat` on Windows; low value.
- (low; V) An add-dir equal to the not-yet-created worktree fails as missing: unlikely, and the frontend already drops it.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npx vitest run; npx tsc --noEmit` -- expected: pass, clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds

**Manual checks:** orchestrator, foreground-guarded, scratch demo repo, with a stub `claude.path` (never the real binary):
- `n` on a worktree branch, then Start.
- `n` on a branch with no worktree: check the worktree preview, then Start.
- Screenshot the sheet subtitle and the session card nested under the branch.
- Emils, by hand with the real `claude`: a `--worktree` start from the project sheet. Check that the session card lands under `worktree-<name>` and that the transcript cwd is that worktree.
