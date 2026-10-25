# Epic 8 Context: Review

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let the operator review what a node's sessions produced without opening VS Code. This means read-only diffs and file browsing for any project, branch or session node, with one keystroke to jump to the external editor at a file and line. Review is the last step of the operator's loop: start, watch, connect, then review. It is the reason the app can replace a VS Code window per repo. This epic also turns the minimal Review pane from Story 7.4 into the real one, and closes the loop back to the agent: line comments are delivered to the session, and the files a session touched are highlighted.

## Stories

- Story 8.1: Working-tree diff pane
- Story 8.2: Branch and commit diffs
- Story 8.3: File browser and external open
- Story 8.4: Session-touched files and line comments

## Requirements & Constraints

- **Diff sources** for any project, branch or session node:
  - the working tree vs HEAD, with a staged/unstaged toggle;
  - a branch vs its base (`git diff <merge-base main branch>..branch`), with the base selectable;
  - the branch's commit list, where selecting a commit shows its diff.
- **Diff view.** Side-by-side and unified views, switched by a toggle. Syntax highlighting, word-level intra-line diff, and unchanged regions collapsed.
- **Changed-files tree** with +/− counts per file.
- **Performance.** A 3 000-line file with 40 hunks renders in under 300 ms once the diff is computed.
- **Files mode.** A lazy, read-only tree of the whole repo with gitignored entries dimmed. Files open in a read-only viewer.
- **External open.** Pressing `o` on a diff line runs the configured editor command with the file and line. The default is `code -g {file}:{line}` when `code` is on PATH; otherwise the operator is prompted to set the command in settings. The command lives in the settings file (external editor command).
- **Session-touched files** (should-have). On a session node, files that appear in its transcript's Edit/Write/MultiEdit tool calls are marked in the tree.
- **Line comments** (should-have). Comment on a diff line, then press ctrl+Enter. The session receives `Review comment on <file>:<line>: <comment>` through the inbox and nudge (or injection when idle), and the comment shows as sent.
- **Read-only.** No editing, staging or committing in v1. Stage/commit from the pane is deferred.
- **Unchanged constraints:**
  - Nothing is written under `~/.claude`; transcripts are only read.
  - No network calls beyond localhost.
  - Everything shown to the human has a JSON twin through MCP.
  - Every new action is registered in the command palette and is bindable.
  - The Windows and Linux CI runners stay green.
  - Keep the bundle small: lazy-load the review code and the language packs.

## Technical Decisions

- **Git through the `git` CLI** as subprocesses (the Rust `git/` module), parsed into typed structs:
  - `status --porcelain=v2`
  - `diff`, both with `--numstat` (counts) and raw
  - `merge-base`
  - `show`
  - This uses the user's own git config. Do not add `git2` or `gix` for this.
- **CodeMirror 6, not Monaco.** Use `MergeView` for side-by-side and `unifiedMergeView` from `@codemirror/merge`. Load language packs lazily by file extension. Use the same CodeMirror stack for the read-only file viewer.
- **Rust owns the data.** Rust owns diffs, file lists, path checks and the touched-file set; the React `review/` area renders them. Tauri commands stay thin and delegate to the modules. UI state lives in Zustand stores.
- **External open** goes through a Tauri command that runs the configured command (`tauri-plugin-opener` or the configured argv). Editor detection is part of the settings binary detection.
- **Touched files** come from parsing the session's transcript JSONL (Edit/Write/MultiEdit `tool_use` inputs). Parsing must be tolerant: unknown record types are skipped. Hooks could also supply a `PreToolUse` signal as an option.
- **Comment delivery** reuses Epic 7's inbox and nudge, and the shared injection rules: wait for `idle`, write one plain line plus `\r`, expect `busy` within 3 s, never write multi-line text, and never inject over an operator draft. Clean the comment text the way peer values and review summaries are cleaned (strip control characters and U+2028/U+2029).
- **Path safety.** Paths requested by an agent are already limited to the session's folders, with containment checked on canonicalised paths. Keep that guarantee when Epic 8 opens their contents.

## UX & Interaction Patterns

- The pane slides in from the right like the terminal pane and closes with Esc. The canvas stays the home screen.
- Keep chrome low: 1-px borders, monochrome icons, one accent colour, dark by default. Use plain-text +/− counts and marks.
- Keyboard first: `o` opens externally, ctrl+Enter sends a comment, and every pane mode and toggle is a palette command.
- The pane has three modes: changes (working tree, with the staged/unstaged filter), vs base / commits (branch nodes), and Files.

## Cross-Story Dependencies

- 8.1 builds the pane, the changed-files tree and the CodeMirror diff view. 8.2–8.4 extend it.
- 8.2 needs Epic 5's branch and worktree nodes to supply the branch, the worktree cwd and the base.
- 8.3's `o` key works on the diff lines from 8.1 and 8.2.
- 8.4 needs Epic 3's transcript discovery for touched files, and Epic 7.3's inbox, nudge and injection slot for comments.
- **Story 7.4 already built a minimal Review pane** (summary plus requested paths, flag, toast, palette "Open review request"). Epic 8 replaces its list with the diff and file views. Opening a review request should select the requested paths, with `missing` paths still shown.
- `open_in_review(path|diff spec)` (should-have) would let a session open this pane directly.
- **Deferred viewer.** Story 7.3 deferred a viewer for peer message text, which currently lives only in memory, to Epic 8 or 9. This epic is one candidate home for it.
