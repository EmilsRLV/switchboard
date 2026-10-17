- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-expand-collapse-drag-auto-layout.md`
  summary: No automated test proves the production `setup` reads `SWITCHBOARD_STUB_CHILDREN` before `graph::initialise` copies it; only the manual launch with the variable set shows the stubs.
  evidence: The Wry-only `setup` closure in `src-tauri/src/lib.rs` is never executed under `cargo test`; every test pre-sets `AppState.stub_children` itself. Closing it needs an injectable config path for `graph::initialise` so a mock-runtime test can assert `read_workspace().stub_children == n`.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-keyboard-navigation-and-project-actions.md`
  summary: No component test renders `Banners` (the notice row and its early return) or `ContextMenu` (group separators); reverting either keeps CI green.
  evidence: vitest runs with `environment: "node"`, there is no `.test.tsx` and no DOM library; the first component test should bring jsdom and render `Banners` with only a notice set and `ContextMenu` with a selected project.
