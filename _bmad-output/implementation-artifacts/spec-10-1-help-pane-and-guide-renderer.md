---
title: 'Story 10.1: Help pane and guide renderer'
type: 'feature'
created: '2026-10-30'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'aa8e69ff567082e40a585ac6a709445d59928efd'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-10-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Switchboard has no built-in help: a new user has nothing in the app that explains the canvas, the nodes or the keys.

**Approach:** Add a `help` pane, opened by F1 or "Help" in the palette, showing short guide pages written as Markdown in `docs/help/` and bundled at build time. A small safe renderer turns them into elements. The first two pages are **Canvas & navigation** and **Keyboard & palette**; the Keyboard page's command table is generated live from the command registry. (Emils approved Epic 10 on 2026-10-30: Help pane + checklist, Markdown in the repo, no overlay tour.)

## Boundaries & Constraints

**Always:**
- Every help action is a registry command (in the palette, bindable); the pane's buttons and links pass the Story 9.4 audit.
- Rendering never uses `innerHTML`; raw HTML and images show as literal text.
- Only `http://` and `https://` URLs are ever opened, only on a click, in the system browser.
- Follow DESIGN.md: tokens only, no accent, prose in `--font-sans`, code and keys in `--font-mono`, no new motion.
- Guide text uses the app's own terms (project node, session node, branch node, context edge, cooperate edge, handle, terminal pane, tabs, pop-out, plain terminal, launch sheet, command palette, …).

**Never:**
- No network fetch of help content, no new npm dependency, no new Tauri plugin or capability.
- No overlay, modal, tour or welcome page; the canvas stays the home screen.
- No Getting started, Changelog, Roadmap, What's new or context-aware F1 here (Stories 10.2–10.5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open | F1 on canvas, or palette "Help" | Help pane on **Contents** | — |
| Toggle | F1 with Help open | Pane closes | — |
| Terminal | F1 with focus in a terminal | Key goes to the terminal; `ctrl+shift+k` → "Help" opens the pane | — |
| Page link | `[x](keyboard.md#palette)` clicked | That page opens in the pane, scrolled to the heading | Unknown page → link text shown as plain text |
| Web link | `https://…` clicked | Opens in the system browser | Other schemes (`javascript:`, `file:`) render as text, never open |
| Raw HTML | `<script>`, `<img>`, `![a](b.png)` | Shown as literal text | — |
| Rebind | `keybindings.json` changes F1 or unbinds a command | Keyboard table shows the effective key or `—` | — |

</frozen-after-approval>

## Code Map

- `src/state/ui.ts:36` -- `Pane` union: add `"help"`; also hold the current help page (`helpPage: string | null`, null = Contents) and set it via store actions.
- `src/commands/panes.ts` -- `openPane`/`togglePane`/`leave()`: add a `leave("help")` branch that resets the page.
- `src/commands/builtins.ts` -- copy `settings.open` + `settings.toggle` (lines 236-242). New: `help.open` "Help"; `help.toggle` hidden, `keybinding: "f1"`; `help.page` "Help: open page…" (pick list); `help.contents` "Help: contents" (`when` a page is shown); one hidden command per page link target is not needed — see Design Notes. Bump the fixed counts in `builtins.test.ts:56` and `:228`.
- `src/commands/keybindings.ts:46` -- `EDITABLE_PASS_KEYS`: add `"f1"` so F1 works from inputs and the Review editor (F1 is never typed text). Terminals are unaffected (`src/terminal/keys.ts:29` pass-through list stays as is).
- `src/state/palette.ts:132` `openPick` + `src/commands/edges.ts:70-89` (`startLink`) -- the pick-list model for `help.page`.
- `src/commands/registry.ts` -- `listCommands({visibleOnly:true})`, `.binding` (effective), `subscribeBindings()`; `formatKeybinding()` in `keybindings.ts:122` for display (as `Palette.tsx:113`).
- `src/App.tsx:268-281` -- render `{pane === "help" && <HelpPane />}`, lazy like Review (line 66/274) so the page text stays out of the main bundle.
- `src/components/SettingsPane.tsx:26-48` -- header/Close/focus pattern to mirror (`<aside className="pane" aria-label="Help">`).
- `src/components/shell.css:110` -- `.pane` width (settings width); add help styles here with tokens only (`src/theme/design.test.ts` lints all CSS).
- `src/commands/audit.test.ts` -- handlers must be `() => runCommand("id")`, a one-`runCommand` local function, or allow-listed with a reason.
- `src-tauri/src/ipc/mod.rs:924` (`open_dir`, `try_state` opener pattern), `src-tauri/src/lib.rs:30` (`generate_handler!`), `src/ipc/index.ts:919` (`Commands` map) and `:1038` (wrapper next to `settingsReveal`) -- add `open_url`.
- `docs/DESIGN.md:165` -- "Layout pieces": add "The Help pane".
- `@lezer/markdown` 1.8.0 is already a dependency (unused directly); `vite/client` types already cover `?raw` imports.

## Tasks & Acceptance

**Execution:**
- [x] `src/help/markdown.ts` + `markdown.test.ts` -- pure `renderMarkdown(src) -> HelpNode[]` (plain tree: heading with slug id, paragraph, list/ordered list, item, emphasis/strong, inline code, code block, link {kind: page|web}, text). Everything else becomes text. Tests: each construct, raw HTML, an image, `javascript:`/`file:` links, a page link with `#heading`, an unknown page.
- [x] `docs/help/canvas.md`, `docs/help/keyboard.md` + `src/help/pages.ts` -- the two pages (150–400 words each, own terms, keys as `` `ctrl+k` ``), and one typed table `{ id, title, file, source (?raw) }`. The Keyboard page states F1 goes to a focused terminal and `ctrl+shift+k` → "Help" works there.
- [x] `src/components/HelpPane.tsx` (+ `shell.css`) -- header (title, **← Contents** when a page is shown, Close), Contents list, page view mapping `HelpNode` to React elements; Keyboard page appends a table of visible commands (title, effective key or `—`) that re-renders on `subscribeBindings`.
- [x] `src/state/ui.ts`, `src/commands/panes.ts`, `src/commands/builtins.ts` (+ tests), `src/commands/keybindings.ts`, `src/App.tsx` -- pane, page state, commands, F1, lazy render.
- [x] `src-tauri/src/ipc/mod.rs`, `lib.rs`, `src/ipc/index.ts` (+ tests) -- `open_url(url)`: refuse anything not starting with `http://` or `https://` (case-insensitive) with an error; open via the opener plugin (`try_state`, degrade like `open_dir`).
- [x] `docs/DESIGN.md` -- "The Help pane" under Layout pieces.

**Acceptance Criteria:**
- Given any pane or the palette in front, when F1 is pressed (outside a terminal), then Help toggles; Esc and Close run `pane.close`; opening another pane closes Help.
- Given the palette, when "help" is typed, then "Help", "Help: open page…" and (with a page shown) "Help: contents" are listed and run; the F1 carrier is hidden; all are bindable.
- Given the Story 9.4 audit and the design lint, when the suites run, then both pass without loosening existing rules.

## Design Notes

Contents rows and in-page links choose among a dynamic set of pages, so they are ITEM-level clicks: keep their handlers in `HelpPane.tsx`, calling one store/command helper (`showHelpPage(id, anchor?)`), and add an honest `ALLOW_LIST` entry in `audit.test.ts` — the same page is reachable by command through `help.page`. Web-link clicks call `openUrl` the same way. Close and ← Contents are plain `runCommand("pane.close")` / `runCommand("help.contents")`.

Parse with `@lezer/markdown` (CommonMark) and walk the syntax tree; map unsupported node types (HTMLBlock, HTMLTag, Image, …) to their source text.

## Verification

**Commands:**
- `npx tsc --noEmit`; `npx vitest run --root /b/projects/ide` -- expected: green, incl. renderer, commands, audit, design lint
- `cargo test`, `cargo clippy --all-targets -- -D warnings` (in `src-tauri`, `--offline`) -- expected: green
- `npm run tauri build -- --no-bundle` -- expected: builds

**Manual checks:**
- Orchestrator GUI pass (foreground-guarded, stub `claude`): F1 opens Contents, both pages render, page link navigates, ← Contents, Esc closes; screenshot reviewed. Web link click is not exercised (no browser opened in GUI passes).

## Implementation Notes

- **Keyboard page tables.** Two tables: `Commands` (visible commands, effective key or `—`) and `Key-only commands` (hidden commands with a key), since the Rebind row needs a changed F1 to show and `help.toggle` is hidden.
- **"Help: open page…"** loads the page table on demand (main bundle stays free of page text), so from the palette it closes and reopens as the pick list.
- **F1 with the palette open** toggles Help behind it, as `ctrl+,` does for Settings.
- **Shared fallback.** `App.tsx` gained a shared `PaneFailed` for the lazily loaded panes (Review's output unchanged).

## Spec Change Log

## Review Triage Log

Review pass 1 (blind-hunter, edge-case-hunter, verification-gap; diff aa8e69f..working tree):

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | vg, blind | No test renders the pane or the Keyboard table (matrix row Rebind) | medium (pre-verified) | No test imports `HelpPane`; `Banners.test.tsx` shows `renderToStaticMarkup` works in node. patch: `HelpPane.test.tsx` |
| 2 | blind, edge | `Block` / `Inline` defaults call each other; an `item` node would recurse forever | low | Unreachable today (the list branch unwraps items), but the fix is a direct case. patch |
| 3 | blind | Focus falls to `<body>` after ← Contents, a Contents row or a page link | low | The clicked button unmounts; only the mount effect focuses, so keyboard users must Tab in again. patch: focus the target heading or page |
| 4 | blind, edge (x2) | The Key-only table filters on `defaultBinding`; a hidden command bound only in `keybindings.json` is missing | low | `HelpPane.tsx` filter. patch: binding or default binding |
| 5 | vg, blind | TS `isWebUrl` accepts C1 controls that Rust refuses | low | Rust is the gate; the mismatch only gives a refusal notice. Direct regex fix. patch |
| 6 | blind | canvas.md: right-drag pans vs right-click opens the menu reads as a contradiction | low | `Canvas.tsx` `rightClickTarget` decides at release. patch: page text |
| 7 | vg, blind | `.help-contents-row` has a leftover transparent `border-left` | low | Nothing colours it. patch: delete |
| 8 | blind, edge | "Help: open page…" fails silently if its chunk fails to load; a late pick list after the await | low | A bundled local chunk; unlikely, and the fix adds guards. Rejected |
| 9 | blind | "Help: contents" listed for an unknown page id | low | No route sets an unknown id (pick list and links come from the table). Rejected |
| 10 | blind, edge | An upper-case `#anchor` silently misses | false | `pages.test.ts` asserts every page link's anchor is a heading id on its page, so such a link fails the suite. Rejected |
| 11 | blind | Keys and titles named in the pages are not checked | low | Story 10.2's planned help-content test covers it (frozen Never: 10.2 work); the orchestrator checked every key named today against the registry. Rejected |
| 12 | blind | Pages re-parsed on every render | low | Two short pages; negligible. Rejected |
| 13 | blind | Header scrolls away on long pages | low | Same as the settings pane today. Rejected |
| 14 | blind | Web links look like page links | low | No page has a web link yet; the URL shows on hover. Rejected |
| 15 | blind | Only six named entities decoded | low | No page uses another; unlikely. Rejected |
| 16 | edge | An ordered list starting at 3 renders from 1 | low | No page does; unlikely. Rejected |
| 17 | edge | Slug collision with an earlier suffixed id | low | Needs headings `X 1`, `X`, `X`; unlikely. Rejected |
| 18 | edge | Backslash escapes or entities in a link URL are not decoded | low | No page has one; Rust still gates the scheme. Rejected |

**Orchestrator verification (2026-10-30).**
- **Checks.** `tsc` clean; vitest 752/752; `cargo test` 627 passed; clippy clean; release build built.
- **GUI pass** (foreground-guarded, stub config): F1 opens Contents; "Help: open page…" → Keyboard shows the page and its tables; a page link opens Canvas & navigation at "Selecting and acting" with focus on the heading; "Help: contents" returns; Esc closes. A first attempt drove the operator's installed Switchboard (window chosen by title only); the scripts now abort when any Switchboard runs and select the window by process path. No workspace change resulted.
- **Not checked.** A web-link click (no page has one yet; no browser opened in GUI passes). Linux CI pending.
