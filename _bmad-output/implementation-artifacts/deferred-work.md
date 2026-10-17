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
