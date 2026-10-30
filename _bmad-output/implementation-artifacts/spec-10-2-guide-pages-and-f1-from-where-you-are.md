---
title: 'Story 10.2: Guide pages and F1 from where you are'
type: 'feature'
created: '2026-10-30'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '69ca5f6f5a6240120e9104663aa3898225d6103d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-10-1-help-pane-and-guide-renderer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Help has only two pages (Story 10.1), and F1 always opens Contents, so it rarely answers the question the operator has at that moment.

**Approach:** Write the remaining guide pages, plus a Terms page, in the app's own words. A test keeps the pages honest: every page is listed, there is no raw HTML, links resolve, and every key named is a real default. F1 and "Help" open the page matching the open pane or the selection. The empty-canvas hint gains `F1 help`.

**Decision (Emils, 2026-10-30, "Return to it"):** when Help opens over another pane, that pane keeps its state (launch form, worktree forms, review target). Esc, Close or F1 in Help brings it back as it was left. Opening any other pane from Help drops it as usual.

## Boundaries & Constraints

**Always:**
- **Pages, in Contents order:** Canvas & navigation, Projects, Sessions & launch sheet, Terminals, tabs & pop-outs, Edges, Branches & worktrees, Review, The app as a tool for Claude, Settings & diagnostics, Keyboard & palette, Terms.
- **Each page:**
  - 150–400 words;
  - opens with what the thing is, then how to do it (keys and palette titles exactly as the app shows them), then the states one can see;
  - names the app's parts only with the Terms page's vocabulary.
- **Facts come from the code, never from planning documents.** If a feature is not in the code, leave it out (e.g. there is no "adopt").

**Never:**
- No Getting started, Changelog, Roadmap or What's new pages (Stories 10.3–10.5).
- No change to how any pane behaves apart from Help's return.
- No new dependency.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| From a pane | F1 or "Help" with the launch sheet / terminal pane / edge inspector / Review / import / settings / worktree or remove-worktree sheet open | Help opens on Sessions & launch sheet / Terminals, tabs & pop-outs / Edges / Review / Projects / Settings & diagnostics / Branches & worktrees | — |
| From a selection | No pane; a project / session / branch node or an edge selected | Projects / Sessions & launch sheet / Branches & worktrees / Edges | — |
| Otherwise | Nothing open or selected | The page last read this run, else Contents | — |
| Return | Help opened over the launch sheet with a typed form; then Esc, Close or F1 | The launch sheet is back with the form as typed | The edge inspector comes back only while an edge is still selected |
| Leave elsewhere | Help over a pane; another pane opens (palette, keys) | The new pane opens; the remembered pane is reset as today | — |
| Help to canvas | Help opened with no pane; Esc | Canvas, as today | — |
| Key drift | A page names `` `ctrl+x` `` that is no command's default | The help-content test fails | — |

</frozen-after-approval>

## Code Map

- `src/commands/help.ts` (`showHelpPage`) and `src/commands/builtins.ts:245-271` (`help.open`, `help.toggle`): compute the context page before `openPane` runs, because `leave()` resets during it.
- `src/commands/panes.ts:33-47` (`openPane`, `togglePane`, `closeOpenPane`, `leave`):
  - Help remembers the pane it replaced (`helpReturn` in the ui store) and skips that pane's `leave()`.
  - Closing Help (`pane.close`, Close, F1) reopens it.
  - Any other `openPane` from Help runs the deferred `leave(helpReturn)` and clears it.
- `src/state/ui.ts`:
  - `selection: CanvasTarget | null` (line 141); `CanvasTarget`/`NodeKind` are in `src/canvas/nodes.ts:102-133` and `src/ipc/index.ts:495`. Branch on `selection.kind`: project, session, branch, edge, more.
  - The subscriber at lines 397-403 closes the `edge` pane when the selection stops being an edge.
  - Add the last-read page per run (in-memory).
- Facts for the pages. **Strings:** palette titles in `src/commands/builtins.ts`; state words in `src/state/live.ts:40` and `src/canvas/ChildNode.tsx:21-44`.
- Facts for the pages. **Per area:**
  - Panes: `LaunchPane`, `TerminalPane`, `EdgePane`, `WorktreePane`, `RemoveWorktreePane`, `ReviewPane`, `ImportPane`, `SettingsPane`.
  - Edge states: `src/state/edgesLive.ts:40-80`.
  - Review modes: `src/review/model.ts:10-28`.
  - Approval toasts: `src/components/ApprovalToasts.tsx`.
  - MCP tools: `src-tauri/src/mcp/mod.rs:81`.
  - Diagnostics rows: `src/components/diagnostics.ts`.
- `src/help/pages.ts` + `pages.test.ts`: extend the table; replace the 10.1 two-page assertions.
- Key forms:
  - `src/commands/registry.ts:158` `listCommands()` gives `.defaultBinding`. `parseKeybinding` (`keybindings.ts:81`) normalises aliases (esc→escape, up→arrowup).
  - Pages write keys in `formatKeybinding` form (`esc`, `enter`, `delete`, `f1`, `` `ctrl+` ``).
- Empty-canvas hint: `src/canvas/Canvas.tsx:187-191` (`.canvas-hint`, `pointer-events: none`, so text only). Its README quote is at `README.md:78-79`.

## Tasks & Acceptance

**Execution:**
- [x] `docs/help/*.md` (9 new; revise `canvas.md`/`keyboard.md` only for links and terms). Write the content per the Boundaries.
  - The Terms page is a definition list of the vocabulary.
  - The tool page covers the MCP server, approvals and "Always for this edge", peer messages and the `N new` badge, and review requests.
  - Link pages to each other where useful.
- [x] `src/help/pages.ts`: the eleven pages in order.
- [x] `src/help/content.test.ts` (new): the help-content test.
  - Every `docs/help/*.md` is listed and every listed file exists (read the folder with `node:fs`).
  - No page contains raw HTML or images: no `HTMLBlock`, `HTMLTag` or `Image` in the parse.
  - Every page link and `#heading` resolves.
  - Every code span that is a key is the default binding of some registered command, compared after `parseKeybinding`. A key is a span containing `+`, or a single character, or one of `esc` `escape` `enter` `delete` `tab` `space` `up` `down` `left` `right` `pageup` `pagedown` `f1`–`f12`. Other code spans (file names, state words) are not keys.
- [x] `src/help/context.ts` + test: a pure `helpPageFor({ pane, selection, lastRead }) -> pageId | null` (null = Contents), covering every Matrix mapping row.
- [x] `src/commands/panes.ts`, `src/commands/help.ts`, `src/commands/builtins.ts`, `src/state/ui.ts` + tests: context page on F1/"Help"; return-to-pane; last-read page. Tests cover the Return, Leave elsewhere and Help to canvas rows.
- [x] `src/canvas/Canvas.tsx` + `README.md:78-79`: the hint ends with ` · <kbd>F1</kbd> help` in the same muted mono style, and the README quotes the new text.

**Acceptance Criteria:**
- Given the app, when Contents opens, then it lists the eleven pages in order and each renders.
- Given the suites, when they run, then the help-content, mapping, return and existing audit, design and builtins tests pass.

## Design Notes

**Return-to-pane:**
- `openPane("help")` while pane X (not help) is open stores `helpReturn = X` and does not call `leave(X)`.
- `closeOpenPane` / `togglePane("help")` while Help is open with a `helpReturn` reopens X, without `leave`.
- `openPane(Y)` from Help, with Y not equal to X, calls `leave(X)` and then proceeds.
- `openPane(X)` itself also clears `helpReturn` and keeps X's state.
- An `edge` return applies only if `selection?.kind === "edge"`; otherwise Help closes to the canvas.

The page-for-pane mapping is taken **before** the swap, so the launch sheet maps to Sessions & launch sheet even though Help replaces it.

## Verification

**Commands:**
- `npx tsc --noEmit`; `npx vitest run --root /b/projects/ide` -- expected: green
- `npm run tauri build -- --no-bundle` -- expected: builds

**Manual checks:**
- Orchestrator GUI pass (foreground-guarded; abort if any Switchboard is running; window chosen by process path):
  - F1 from the launch sheet with a typed name opens Sessions & launch sheet; Esc brings the sheet back with the name.
  - F1 on a selected project opens Projects.
  - Contents lists eleven pages.
  - The empty-canvas hint reads `… · F1 help`.

## Implementation Notes

- **Page count.** The Boundaries list (and "9 new" plus the two 10.1 pages) gives **eleven** pages; the Tasks/AC say "twelve". Built the eleven listed; tests assert eleven. Needs a human call if a twelfth page was meant.
- **Return guards.** Besides the edge inspector (only while an edge is selected), the terminal pane comes back only while it still has a tab (a terminal can be forgotten while Help covers it); otherwise Help closes to the canvas and the remembered pane is left.
- **Key spans.** Keys that are not any command's default (ctrl+Enter in the sheets, ctrl+shift+c/v, Space in the import pane) are written as plain text, not code spans, so the help-content test holds. `keyboard.md`'s `—` (a one-character code span) became plain "a dash (—)".
- **Docs.** DESIGN.md's Help pane entry now says where Help opens and that it returns; README's line 384 quote of the hint was updated with lines 78-79.
- **`help.open` with Help already open** changes nothing (no re-navigation).

## Spec Change Log

- **2026-10-30, orchestrator (count slip).** The Tasks, AC and manual check said "twelve" pages while the frozen page list names eleven. Corrected the non-frozen text to eleven; the frozen list stands and the implementation already matches it. No code change.

## Review Triage Log

Review pass 1 (blind-hunter, edge-case-hunter, verification-gap; diff 69ca5f6..working tree):

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind, edge (x2) | An edge click while Help covers a sheet opens the inspector and wipes the typed form | medium | `showEdge` (`edges.ts:159-165`) checks only `pane`, which is "help"; `openPane("edge")` then runs the deferred `leave`. patch: use `helpReturn` in the sheet check |
| 2 | vg, edge (x2) | A sheet whose submit finished while Help covered it comes back empty and invisible | medium | `closeSheet` / `submitWorktree` / `submitRemoveWorktree` reset the store when the pane is not theirs; `canReturnTo` returns true for sheets. patch: return only while the form or target exists |
| 3 | vg, blind | No test for `openPane(X)` while Help covers X | medium (pre-verified) | No test exercises the `back !== pane` branch. patch: add the case |
| 4 | blind | keyboard.md does not describe F1's page choice or the return | low | Direct text addition. patch |
| 5 | blind | DESIGN.md Help entry omits the return exceptions | low | Direct text addition. patch |
| 6 | blind | `helpReturn` not cleared when Help opens from the canvas | false | It can only go stale if Help is closed through the raw store; the only raw `closePane` (`ui.ts:420`) runs when the pane is "edge", never "help". Rejected |
| 7 | blind | A remembered sheet or Review for a project removed while Help was open | low | Needs "Remove from canvas" from the palette while Help covers that project's sheet; unlikely, and the fix adds guards. Rejected |
| 8 | edge | The edge inspector's unsaved Label draft is lost after F1 from the field | low | `useState` draft remounts; a guard needs new store state for a rare path. Rejected |
| 9 | edge | The import pane comes back with added rows still ticked | low | Only if Add selected finishes while Help covers it; unlikely. Rejected |
| 10 | blind | The empty-canvas hint hard-codes `F1` though it can be rebound | low | The hint already hard-codes `ctrl+o` and `ctrl+k` (Story 9.1 pattern). Rejected |
| 11 | blind | The key test accepts a key that is the default of a different command | low | The spec's rule is "the default of some command"; pairing keys with titles changes the spec. Rejected |
| 12 | blind | Word-count and title-heading rules are untested | false | `pages.test.ts` checks every page's first heading equals its title and that it has 150–400 words. Rejected |
| 13 | blind | Reference links and autolinks escape the link check | low | The renderer shows them as source text, never as links; no page uses one. Rejected |
| 14 | blind | Stale spec text (Implementation Notes "twelve", Code Map line numbers) | low | The fix edits this spec. Rejected |
| 15 | blind | `toHaveLength(11)` duplicated; one edge-test assertion missing; "last read" means last shown | low | Cosmetic, or by design (the page shown is the page read). Rejected |

**Orchestrator verification (2026-10-30).**
- **Checks.** `tsc` clean; vitest 771/771; release build built.
- **GUI pass** (foreground-guarded, stub config; aborts if any Switchboard runs, window chosen by process path):
  - F1 on a selected project opened Projects.
  - From the launch sheet with `zzname` typed in Name, F1 opened Sessions & launch sheet, and Esc brought the sheet back with `zzname`.
  - Contents lists the eleven pages.
- **Not checked.**
  - The empty-canvas hint (the test workspace has projects); it is static text, and README quotes it.
  - The fact accuracy of every page: the orchestrator spot-checked sessions.md and tool.md against the code; the rest relies on the implementer's code research.
  - Linux CI is pending.
