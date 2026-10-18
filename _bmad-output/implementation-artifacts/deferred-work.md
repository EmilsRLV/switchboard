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
