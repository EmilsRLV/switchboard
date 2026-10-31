- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-expand-collapse-drag-auto-layout.md`
  summary: No automated test proves the production `setup` reads `SWITCHBOARD_STUB_CHILDREN` before `graph::initialise` copies it; only the manual launch with the variable set shows the stubs.
  evidence: The Wry-only `setup` closure in `src-tauri/src/lib.rs` is never executed under `cargo test`; every test pre-sets `AppState.stub_children` itself. Closing it needs an injectable config path for `graph::initialise` so a mock-runtime test can assert `read_workspace().stub_children == n`.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-keyboard-navigation-and-project-actions.md`
  summary: No component test renders `Banners` (the notice row and its early return) or `ContextMenu` (group separators); reverting either keeps CI green.
  evidence: vitest runs with `environment: "node"`, there is no `.test.tsx` and no DOM library; the first component test should bring jsdom and render `Banners` with only a notice set and `ContextMenu` with a selected project.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-visual-language.md`
  summary: No test renders `Notice` (the overlay that replaced the banner-strip notice); deleting `<Notice />` from `App.tsx` keeps CI green.
  evidence: vitest runs in the node environment with no DOM library; `react-dom/server` `renderToStaticMarkup` (or jsdom with the 2.4 entry) could render `Notice` with a notice set and assert the text inside `role="status"`.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-visual-language.md`
  summary: The design lint does not check component colour props such as `<Background color="var(--fg-faint)">`; an accent or hex there would pass.
  evidence: `lintTsx` scans only `style={…}`; DESIGN.md records the omission; extend it to string-literal `color=` props when a second site appears.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-5-visual-language.md`
  summary: `Banners` mounts its `role="status"` live region only together with its first banner, which some screen readers do not announce (pre-existing since Story 1.3).
  evidence: `Banners` returns `null` when empty; `Notice` shows the fix (an always-present region with conditional rows).
- source_spec: `_bmad-output/implementation-artifacts/spec-3-1-historic-sessions-from-transcripts.md`
  summary: No test proves that `workspace_add_projects` (and `workspace_remove_project`) trigger an immediate sessions pass through the IPC path; deleting the spawn keeps CI green (the 5 s timer hides it).
  evidence: The IPC wire tests never set `claude_home`; add one that sets a temp home with a transcript, invokes the command and waits (bounded) for `workspace://changed` with the session child.
- source_spec: `_bmad-output/implementation-artifacts/spec-3-1-historic-sessions-from-transcripts.md`
  summary: `.session-aliases` in Claude project dirs is not read; the epic context calls it a list of linked dirs (unverified medium).
  evidence: On this machine each such file holds one short id-like line; settle its meaning (linked dirs, or a session alias) before feeding it into the dir → cwd match.
- source_spec: `_bmad-output/implementation-artifacts/spec-3-3-status-glow-and-notifications.md`
  summary: The "no toast while focused" check is not exercised end to end, because Tauri's mock runtime always reports an unfocused window.
  evidence: `MockRuntime::is_focused` returns `Ok(false)`; making the focus query injectable (like the notifier) would let a wiring test assert that a focused window suppresses the toast.

## From Story 4.1 (PTY terminal pane) review

- Watermark flow control: pause the PTY reader when xterm's write callbacks fall behind (high/low watermarks); 4.1 only caps the payload per event.
- A coalescing test that observes event spacing; needs the emitter loop separated from the PTY to be non-flaky.
- Keyboard-operable terminal pane resize handle (tabIndex, aria-valuenow/min/max, arrow keys).

## From Story 4.2 (launch sheet) review

- A `launch_session` test asserting the system prompt's branch line (present for an attached branch, absent when detached).
- A test of the app `setup` wiring: the session dir is set and the startup sweep runs.

## From Story 4.3 (hook-driven status) review

- A false `finished` card and toast when the user's own `Stop` hook blocks the stop: Switchboard's `Stop` hook runs in parallel and cannot see that decision. Possible fix: hold `finished` briefly and cancel it on a following busy signal.
- Following `/clear` to the new session id (re-keying the token and the live entry); out of scope in 4.3.

## From Story 4.4 (resume, fork, stop) review

- An isolated test for `pty::allow_ctrl_c` with the test process set to ignore Ctrl+C (process-wide console state, so a separate test binary).
- Component tests for the fork edge and its handles, once a component test environment exists.
- Resume and Fork with the session's own last model and permission mode, read from its transcript, instead of the project's latest launch choices.

## From Story 4.5 (tabs and pop-outs) review

- Restrict the commands a `term-*` pop-out window may invoke to `term_*` through an app permission manifest (all commands then need permissions, main included).
- Remember pop-out window size and position (window-state currently skips `term-*`).
- A test for `on_run_event` routing of `ExitRequested` / `WindowEvent::Destroyed` (Tauri's event types are non-exhaustive; pull the routing into a pure function first).

## From Story 5.1 (branch children) review

- A test of the git poll loop's scheduling (status pass, 30 s branch fallback, watch re-sync); pull the loop body into a testable tick function first.
- Render tests for the project card's branches chip and the branch card, once a component test environment exists.

- source_spec: `_bmad-output/implementation-artifacts/spec-5-2-create-worktree-node.md`
  summary: A stored BranchNode `worktreePath` whose worktree was removed or pruned outside the app is never cleared, and Re-layout keeps such refs.
  evidence: Review round 1 of Story 5.2 (blind hunter); removal and sessions-follow-worktrees are Story 5.4.

- source_spec: `_bmad-output/implementation-artifacts/spec-5-4-sessions-follow-worktrees-remove-worktree.md`
  summary: A branch's worktree history keeps one path; a later worktree at a different path overwrites it and sessions from the older removed worktree lose their placement (needs a list of past paths).
  evidence: Story 5.4 review round 1 (blind hunter, edge-case hunter).
- source_spec: `_bmad-output/implementation-artifacts/spec-5-4-sessions-follow-worktrees-remove-worktree.md`
  summary: Test that a timed-out worktree listing in the status poll keeps the last known list (pull the error-to-update mapping into a testable helper).
  evidence: Story 5.4 review round 1 (verification gap).
- source_spec: `_bmad-output/implementation-artifacts/spec-5-4-sessions-follow-worktrees-remove-worktree.md`
  summary: Component tests for the remove-worktree sheet's safeguards (Enter swallowed on removing buttons, focus on Close, Discard not reusing the Force button).
  evidence: Story 5.4 review round 1; no DOM test environment yet.

- source_spec: `_bmad-output/implementation-artifacts/spec-6-1-draw-and-persist-edges.md`
  summary: Component tests for the canvas edge handlers (isValidConnection, onConnect, onConnectEnd, onEdgeClick) and the EdgePane (save on Enter and blur, the Delete skip).
  evidence: Story 6.1 review round 1; no DOM test environment yet.

- source_spec: `_bmad-output/implementation-artifacts/spec-6-2-context-edges-at-launch.md`
  summary: Folder targets (context edges to arbitrary folders that are not canvas nodes) are deferred; `edge_add` still refuses them (`can't link a folder yet: folder targets come later`) and the resolver skips a stored one as `not found`.
  evidence: Story 6.2 "Never" boundary; the epic's open decision 1 had planned them for 6.2.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-2-context-edges-at-launch.md`
  summary: No component test renders the launch sheet's `via edge → <target>` suffix or its `not added:` line; the rules behind them (`edgeVia`, `skippedNote`) and the store are tested.
  evidence: Story 6.2; no DOM test environment yet.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-3-context-edges-on-live-sessions.md`
  summary: Live `/add-dir` injection does not quote a path with spaces; whether Claude Code parses the rest of the line as one path is unverified.
  evidence: Reviewer edge case (unverified, would be medium). Settle by linking a live session to a folder with a space in its path, using the real `claude`.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-3-context-edges-on-live-sessions.md`
  summary: `live_edges::prune` on project removal and the failed edge's `.attention` accent in `Canvas.tsx` have no tests.
  evidence: The verification-gap review found no test that removes a project with live edge entries. There is no component test environment for Canvas.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-4-cooperation-edges.md`
  summary: Peers are told a name (live `--name`, else transcript title) that may not be the name `SendMessage` reaches for a resumed session, which passes no `--name`.
  evidence: Reviewer finding (unverified, medium if true). Settle with the native-messaging check using the real `claude`: resume a linked session and `SendMessage` it by the name in the peer block.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-4-cooperation-edges.md`
  summary: No component tests for the `CooperateEdge` accent on a failed side or for the inspector's per-side Now lines and Retry buttons.
  evidence: There is no DOM test environment in the repo. The 2026-10-22 GUI pass covered both by hand.
- source_spec: `_bmad-output/implementation-artifacts/spec-6-4-cooperation-edges.md`
  summary: Story 6.4 (`f796d37`) has not run on CI. It was closed on local Windows verification because GitHub Actions is suspended until the end of the month.
  evidence: The Linux build and tests have not run for 6.4. When Actions resumes, confirm the CI run on both runners for the latest commit.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-1-mcp-server-with-read-tools.md`
  summary: No render test for the Settings → Diagnostics MCP refusal list.
  evidence: There is no DOM test environment. The 2026-10-24 GUI pass showed the list; only the pure helpers are unit-tested.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-1-mcp-server-with-read-tools.md`
  summary: Story 7.1 (`c7590f8`) has not run on CI. It was closed on local Windows verification because GitHub Actions is suspended until the end of the month.
  evidence: The Linux build and tests have not run (Unix-only branches: the 0600 mode check, the argv check). When Actions resumes, confirm the latest commit on both runners.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-2-act-tools-with-approval.md`
  summary: Story 7.2 (`419d432`) has not run on CI. It was closed on local Windows verification because GitHub Actions is suspended until the end of the month.
  evidence: The Linux build and tests have not run. When Actions resumes, confirm the latest commit on both runners.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-3-peer-inbox-and-nudge.md`
  summary: The operator has no way to read peer message text, which lives only in memory and is gone once `inbox()` drains it.
  evidence: The review found that text one agent writes becomes another agent's input with no human-visible record. Emils deferred the viewer (Epic 8 or 9).
- source_spec: `_bmad-output/implementation-artifacts/spec-7-3-peer-inbox-and-nudge.md`
  summary: No render test for the session card's `N new` badge wiring (Canvas input, memo deps, ChildNode).
  evidence: There is no DOM test environment. The 2026-10-24 GUI pass showed the badge.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-3-peer-inbox-and-nudge.md`
  summary: Story 7.3 (`6bef4a8`) has not run on CI. It was closed on local Windows verification because GitHub Actions is suspended.
  evidence: The Linux build and tests have not run. When Actions resumes, confirm the latest commit on both runners.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-4-request-review.md`
  summary: No component tests for ReviewPane, ReviewToasts and the card's review flag, and no test of `notify::on_review` skipping a focused window.
  evidence: There is no DOM test environment and the mock app has no window. The 2026-10-25 GUI pass covered the UI.
- source_spec: `_bmad-output/implementation-artifacts/spec-7-4-request-review.md`
  summary: Story 7.4 (`4e90cd4`) has not run on CI. It was closed on local Windows verification because GitHub Actions is suspended.
  evidence: The Linux build and tests have not run, including the Unix symlink branch of the containment test. When Actions resumes, confirm the latest commit on both runners.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-1-working-tree-diff-pane.md`
  summary: No DOM render test for the Review pane: the 300 ms render target, the Diagnostics render-time wiring, and tree semantics (role=tree, arrow keys).
  evidence: Vitest runs in node with no DOM. The 2026-10-25 GUI pass measured 21 ms for 3,000 lines with 40 hunks.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-1-working-tree-diff-pane.md`
  summary: Story 8.1 has not run on CI. It was closed on local Windows verification while GitHub Actions is suspended.
  evidence: The Linux build and tests have not run, including the Unix symlink branch of `read_disk`, which skipped on Windows. When Actions resumes, confirm the latest commit on both runners.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-2-branch-and-commit-diffs.md`
  summary: Story 8.2 has not run on CI. It was closed on local Windows verification while GitHub Actions is suspended.
  evidence: The Linux build and tests have not run. When Actions resumes, confirm the latest commit on both runners.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-3-file-browser-and-external-open.md`
  summary: Story 8.3 has not run on CI, and FilesBody has no render tests. It was closed on local Windows verification while GitHub Actions is suspended.
  evidence: The Linux build and tests have not run, including the Unix file-symlink case, which skipped on Windows. There is no DOM test environment for FilesBody's read ids.
- source_spec: `_bmad-output/implementation-artifacts/spec-8-4-session-touched-files-and-line-comments.md`
  summary: Story 8.4 has not run on CI, and the touched marks have not been seen on screen. It was closed on local Windows verification while GitHub Actions is suspended.
  evidence: The GUI pass cannot write a transcript into the real `~/.claude`; the IPC test covers the marks with a temp claude home. Linux CI has not run.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-1-installers-and-first-run.md`
  summary: Installers have not been installed on a clean machine, and the Linux packages have not been built (CI suspended).
  evidence: Story 9.1 needs an install on a clean machine, following the README checklist and including the claude-absent banner. It also needs the CI bundle check on both runners, the actual `.deb` file name, and the MSI and NSIS reinstall behaviour.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-2-tray-and-close-to-tray.md`
  summary: It is unverified whether an OS logoff or shutdown close request is hidden to the tray instead of exiting cleanly (PTY children and temp settings files could be left behind).
  evidence: Edge-case review, maybe-false. Settle with a logoff test with close_to_tray on, on Windows and Linux.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-2-tray-and-close-to-tray.md`
  summary: Story 9.2's Linux code (the appindicator check, minimize on close) has never been compiled. There was no GUI re-run after review round 1.
  evidence: There is no Linux Rust target on the dev machine and CI is suspended. The GUI re-run was stopped twice by the foreground guard. Check by hand: the setting on and off, clicking the tray icon, the hint and its click, and Linux minimize.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-keybindings-and-palette-completeness.md`
  summary: There was no GUI pass for Story 9.4 (keybindings.json overrides, Diagnostics list, routed pane buttons), and Linux CI has not run.
  evidence: The machine was probably in use (the foreground guard stopped the 9.2 re-run twice). Check by hand: write keybindings.json with an override, a conflict and a bad key, then check the key and the Diagnostics list.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-performance-budget.md`
  summary: NFR-2 now counts the app's own share (Emils, 2026-10-25) and passes: 125 MB (switchboard.exe plus the renderer). The whole tree is 364 MB. Re-measured with 10 sessions (2026-10-27): the share is 138.7 MB, still a pass with 11 MB to spare, at about 2 MB per session, so around 15 to 16 sessions would reach the budget (estimate). The GPU process (not budgeted) reaches 236 MB private, about 14 MB per WebGL terminal.
  With full scrollback (10 sessions, 12,000 lines each, 2026-10-27) NFR-2 **misses**: the share is 375 MB at 10,000 lines and 282 MB at 5,000 (the default since d770c9f).
  - **Proposed fix:** keep xterm views only for visible terminals. Drop a hidden terminal's view on hide and rebuild it from Rust's 2 MiB `term_buffer` ring on show; the registry already replays it after a reload.
  - **Other lever:** a lower scrollback.
  evidence: |
    `docs/perf.md` Results. With 5 projects and no sessions the total is already 315 MB. `switchboard.exe` is 27 MB.
    Levers not tried:
    - WebView2 `MemoryUsageTargetLevel` low while the window is hidden or minimized (tray case only);
    - browser flags dropping optional services;
    - the renderer heap.
    Tried and reverted: WebGL only while shown (no gain; the addon's dispose does not free the context).
- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-performance-budget.md`
  summary: Typing p95 is over 16 ms (16.2 ms shipped, 20.0 ms on the trial build). The median is 15.4 ms, a pass, but with little to spare, and the app's own share is not separated from the shell echo and the frame wait.
  evidence: |
    One pass of 50 keys per build, so the p95 rests on about 3 samples. Still to do:
    - a Windows Terminal baseline with the same shell;
    - a longer pass;
    - a DevTools trace to confirm the rAF closes after xterm's render. The sample closes in rAF, before paint and composite.
    Untested: AltGr characters and characters beyond the BMP (never sampled), focus and DSR replies taken as the echo, pop-out samples in the last second lost on close, and typing on the DOM renderer.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-performance-budget.md`
  summary: The typing ring mixes all terminals and cannot be reset. `perf_ready` also fires when the workspace load failed.
  evidence: Edge-case review. Diagnostics shows the last 100 samples from every terminal (sessions, pop-outs, setup typing). A reset action or a per-terminal source would make a measuring pass cleaner.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-performance-budget.md`
  summary: Story 9.3 has no Linux figures (NFR-1 < 2 s on a cold Linux laptop), and Linux CI has not run.
  evidence: Left for Emils; `docs/perf.md` "Linux laptop" says how to measure. GitHub Actions is suspended until month end.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-visible-only-terminal-views.md`
  summary: NFR-2 with full scrollback still misses after Story 9.5: 150.3 MB with 3 sessions (on the line) and 183.5 MB with 10.
  evidence: `docs/perf.md`, Story 9.5 section. A forced garbage collection took about 27 MB off the 10-session figure, which V8 left uncollected even after 4 minutes idle. Further levers: (1) WebView2 `MemoryUsageTargetLevel` or a periodic low-memory hint; (2) feeding a hidden terminal's shadow only what it needs, so output is not parsed twice; (3) a measurement with real, slower session output instead of a 12,000-line burst.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-visible-only-terminal-views.md`
  summary: A query chunk the full view owned but had not parsed yet when it was disposed (hidden) loses its answer.
  evidence: Story 9.5 answer hand-over. The window is sub-millisecond (a query parsed in the same moment as a hide). It was recorded rather than fixed, as the Design Notes say.
- source_spec: `_bmad-output/implementation-artifacts/spec-9-6-low-memory-when-idle.md`
  summary: No automated check shows that `SetMemoryUsageTargetLevel` actually reaches WebView2.
  evidence: The applier is replaced by a recorder in tests. Only the measuring pass shows the effect (renderer working set dropped from 142 to 6.8 MB at idle). It needs a real WebView2 runtime in CI.
- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-getting-started-checklist.md`
  summary: The App.tsx startup wiring for the checklist (state_get → load, startChecklist) has no automated test.
  evidence: Verification-gap review. No App.tsx startup effect in the repo is tested (keybindings, live follow the same pattern); it needs a test harness for App effects. The GUI pass covers it by hand.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-whats-new-after-an-update.md`
  summary: A read-only state.json (newer schema after a downgrade, unreadable file, no config folder) brings the what's-new chip back every launch, and freezes the checklist the same way, because the UI cannot see that the file is read-only.
  evidence: appstate.rs keeps mark_version_seen / set_checklist in memory when read_only is set, and StateSnapshot carries no readOnly; a fix exposes it and lets the chip and checklist say why (or stay hidden). Found in the 10.5 review (EC3/BH2).
