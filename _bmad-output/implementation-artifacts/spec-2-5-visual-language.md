---
title: 'Story 2.5: Visual language'
type: 'feature'
created: '2026-10-17'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '6846f3634239999da8dbbed6829f519b28e14c2d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The UI was styled story by story. Colours already come from six tokens, but the accent leaks into states that are not attention (focus rings, the palette's selected row, text selection). Font sizes and radii are literal values (eight sizes, three radii). Two rows use inset box-shadows as indicators. The app still ships Tauri's placeholder icons, and nothing written says what the rules are or stops them eroding.

**Approach:** Write `docs/DESIGN.md` as the single statement of the visual system: the tokens, the rules (1-px borders, one accent reserved for attention, no gradients or shadows, monochrome icons, motion), the type scale, node anatomy and status colours. Extend `src/theme/tokens.css` to match. Apply it retroactively to every stylesheet: palette, panes, banners, menu, canvas and nodes. Replace the placeholder app icons with a monochrome Switchboard mark. Add a **design lint** test that fails CI when a stylesheet breaks the rules.

**Decisions (recorded):**

- **Tokens.**
  - **Surfaces:** `--bg` (canvas, page), `--bg-raised` (cards, panes, banners, palette, menu), `--bg-hover`, a new subtle step for hovered and selected rows.
  - **Text:** `--fg`, `--fg-muted`, plus `--fg-faint` for the dot grid and disabled text.
  - **Lines and accent:** `--border` and `--accent`, both unchanged.
  - **Focus and selection:** `--focus` and `--selection` (`--fg` and `--fg-muted` in value). Focus rings and the node selection outline use `--focus`; text selection uses `--selection` on `--bg`.
  - **Type scale:** `--text-xs` 11px, `--text-sm` 12px, `--text-md` 13px, `--text-base` 14px (body), `--text-lg` 16px (pane titles). Every `font-size` is one of these.
  - **Radii:** `--radius-sm` 3px for badges and keys, `--radius-md` 4px for cards, panes, palette and menu.
  - **Line width:** `--line` 1px. Spacing stays literal rem values; it is not tokenised.
- **Accent rule.** The accent appears only on attention states: banners (border and mark), error text (`.pane-error`, `.attention`), and, from Epic 3, the `waiting` and `finished` session states.
  - Focus, selection, hover and the active palette or menu row never use it.
  - The palette and menu row indicator becomes a 2-px left border in `--fg-muted`.
  - No `box-shadow`, `drop-shadow`, `text-shadow` or gradient remains anywhere.
- **Status colours** are monochrome steps, with the accent reserved for attention.
  - **Git line:** facts in `--fg`; not-applicable states (`not a git repo`, `folder missing`, `git unavailable`) in `--fg-muted`; `git error` in `--fg-muted`, with its message on hover.
  - **Session states, documented now for Epic 3:** busy `--fg` with a 1-px pulse; idle and exited `--fg-muted`; waiting and finished `--accent`.
- **Motion.** Only the duplicate-add flash, the 150 ms reveal pan and the palette's 100 ms fade-in remain. All honour `prefers-reduced-motion`.
- **Banners.** The strip has a maximum height of 30vh and scrolls beyond that. Long text (the PATH list from Story 1.3) wraps.
  - The **transient notice** no longer sits in the strip's flow. It becomes a single muted row laid over the top edge of the canvas, so its arrival and its 3-s exit never resize the canvas.
  - This amends Story 2.4's placement; the text and timing stay.
- **Node layering.** A node that is selected or being dragged draws above its siblings (xyflow `zIndex`), so a dragged child is never hidden under its column (the Story 2.3 note).
- **Icons.**
  - **App icon:** one source SVG, `src-tauri/icons/source.svg`, at 1024 × 1024. It shows three 1-px-outlined node squares joined by two lines, in `--fg` on a `--bg` rounded square, with no accent and no gradient. Every file in `src-tauri/icons/` is regenerated from it with `npx tauri icon`.
  - **In-app glyphs:** they stay text (`▸ ▾ ·`), drawn in `currentColor`.
- **Design lint.** `src/theme/design.test.ts` reads every `.css` file under `src/` and every `style={…}` in `.tsx` files. It fails on any of the following:
  - a colour literal (hex, `rgb`, `hsl`, or a named colour other than `transparent`/`currentColor`) outside `tokens.css`;
  - a gradient, or any of the three shadow properties;
  - a `font-size` that is not `var(--text-*)`;
  - a `border-radius` that is not `var(--radius-*)`, `0` or `50%`;
  - `var(--accent)` in a rule whose selector is not on the attention allow-list (`.banner`, `.banner-mark`, `.attention`, `.pane-error`; the list lives in the test and is quoted in DESIGN.md).

## Boundaries & Constraints

**Always:** Tokens are CSS variables only (no component library, no CSS-in-JS). DESIGN.md and the lint describe the same rules, and when one changes the other changes with it. Dark only: `settings.theme` stays reserved. Visual changes keep every behaviour: keys, focus order, menu, drag, pane widths, card sizes (240 × 80, 208 × 40) and the column geometry the arrow search depends on. Both CI runners stay green.

**Never:** No light theme. No new fonts or font files. No icon library or SVG icon set in the UI. No layout redesign of panes, palette or cards beyond what the rules require. No new components except the notice overlay. No accent on hover, focus or selection.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Five projects | canvas with five cards (two repos, a non-git folder, a missing folder, one expanded with stubs) | every colour, size and radius comes from tokens; no accent anywhere on screen | — |
| Attention | settings banner (missing binary) present | the banner's left border and mark are the accent; nothing else is | — |
| Focus | Tab to a pane button / import checkbox | 1-px `--focus` outline, not the accent | — |
| Palette | `ctrl+k`, ↓ | the selected row shows `--bg-hover` with a 2-px `--fg-muted` left border, no shadow | — |
| Text selection | select text in a pane | `--selection` background, not the accent | — |
| Notice | New session… | the muted row appears over the top of the canvas; the canvas does not move or resize | — |
| Long banner | a banner text of 2,000 characters | it wraps; the strip stops at 30vh and scrolls | — |
| Dragged child | drag `session 3` up over `session 1` | the dragged card draws on top while dragging and while selected | — |
| App icon | taskbar, window title bar, installer | the new monochrome mark; no Tauri placeholder remains | — |
| Lint | a stylesheet gains `color: #fff` or `box-shadow` or `font-size: 15px` | `npm test` fails naming the file, line and rule | — |
| Reduced motion | OS reduced-motion on | the flash, the palette fade and the reveal pan are instant | — |

</frozen-after-approval>

## Code Map

- **`src/theme/tokens.css`** has the six colour tokens and two font stacks. Extend it with the surface, text, focus and selection tokens, the type scale, the radii and `--line`.
- **`src/theme/base.css`** sets the body to `font-size: 14px` and makes `::selection` the accent. Change both to tokens.
- **`src/components/shell.css` (445 lines)** holds the banners, `.attention`, pane, `.pane-error`, `.btn`, the import list, palette and context menu.
  - Accent leaks: `.btn:focus-visible` (~172), `.import-list:focus-visible` (~242), the checkbox `:focus-visible` (~270) and `.palette-row.is-selected` (inset box-shadow, ~385).
  - `.context-menu-item.is-selected` has an inset box-shadow (~437).
  - The notice styles (`.banner.is-notice`) are at ~62.
- **`src/canvas/canvas.css`** has the dot grid (`Background color="var(--border)"` in `Canvas.tsx`, which becomes `--fg-faint`) and the attribution at `font-size: 0.65rem`.
- **`src/canvas/nodes.css` (194 lines)** has the cards, `.is-selected` and `.is-flash` outlines in `--fg`, the toggle, badge and child cards. Card sizes must stay 240 × 80 and 208 × 40, since `nodes.ts` constants and the arrow geometry depend on them.
- **`src/components/Banners.tsx`** renders the notice inside `.banners`. Move it to a sibling overlay. One option is `App.tsx` rendering `<Notice />` inside `.shell-body`, positioned over the canvas top; another is `Banners` keeping the notice but absolutely positioned. Pick one that keeps `role="status"` and `aria-live`.
- **`src/canvas/nodes.ts`** contains `toFlowNodes`. Set `zIndex` on the selected node and on dragged nodes (those with an override in `dragging`). Keep the node identity-reuse comparator (`sameNode`) aware of `zIndex`.
- **`src/canvas/ProjectNode.tsx`, `ChildNode.tsx`, `Palette.tsx`, `ContextMenu.tsx`, `SettingsPane.tsx`, `ImportPane.tsx`:** class names only; check for inline `style` colours (the lint covers this).
- **`src-tauri/icons/*`** are the Tauri defaults. **`src-tauri/tauri.conf.json`** `bundle.icon` lists `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` and `icon.ico`. Keep these names so `npx tauri icon src-tauri/icons/source.svg` overwrites them in place.
- **`vite.config.ts`** has vitest with `environment: "node"`, so the lint test uses `node:fs` over `src/` and needs no DOM.
- **`README.md`** needs a short "Design" pointer to `docs/DESIGN.md`. The Status line becomes Epic 2 complete.

## Tasks & Acceptance

**Execution:**
- [x] `docs/DESIGN.md` -- the tokens (name, value, use), the rules, the type scale, node anatomy (project card: label, path, status line, chevron/badge, branches affordance, live badge; child card), status colours (git, and session states for Epic 3), motion, icons, the accent allow-list -- the statement
- [x] `src/theme/tokens.css`, `src/theme/base.css` -- new tokens; body size and `::selection` from tokens -- the tokens
- [x] `src/components/shell.css`, `src/canvas/canvas.css`, `src/canvas/nodes.css`, `src/canvas/Canvas.tsx` -- every size/radius/colour through tokens; focus rings `--focus`; palette/menu indicator as a left border; no shadows; banner strip max-height + scroll; grid colour `--fg-faint` -- retro-application
- [x] `src/components/Banners.tsx` (+ `App.tsx` or a new `src/components/Notice.tsx`), `shell.css` -- notice as an overlay over the canvas top -- notice
- [x] `src/canvas/nodes.ts` (+test) -- `zIndex` for selected and dragged nodes -- layering
- [x] `src-tauri/icons/source.svg`, regenerated `src-tauri/icons/*` -- monochrome app icon -- icon
- [x] `src/theme/design.test.ts` -- the lint, with a self-test proving each rule fires on a planted bad snippet (inline strings, not files) -- guard
- [x] `README.md` -- Design pointer, status line -- docs

**Acceptance Criteria:**
- Given the canvas with five projects, when I look at it, then nothing on screen uses the accent, every card follows the anatomy in DESIGN.md, and the screenshot shows no gradient or shadow.
- Given a settings banner, the palette with a selected row, a focused pane button and selected text, when I look at each, then only the banner uses the accent.
- Given New session…, when the notice appears and goes, then the canvas does not move.
- Given `npm test`, when it runs, then the design lint passes on the tree and its self-tests prove each rule fires; `cargo test`, `clippy -D warnings` and `tsc --noEmit` stay green.

## Implementation Notes

- **Token values.** `--bg-hover` `#1d2129` (between `--bg-raised` and `--border`), `--fg-faint` `#3d424b` (the dot grid is a little brighter than the old `--border` dots). Size mapping from the old rem literals (root 16px): 0.65/0.7rem → `--text-xs`, 0.75 → `--text-sm`, 0.8/0.85 → `--text-md`, 0.9 → `--text-base`, 1rem → `--text-lg`. Card heights are content-driven and stay at about 76 px, inside the 80 px the geometry assumes; widths unchanged. Every `1px solid` now reads `var(--line) solid`.
- **Motion.** The pane's 120 ms slide-in was removed (not on the three-motion list). The palette's entrance is now a pure opacity fade (the 6-px slide dropped). The reveal pan uses `duration: 0` when `matchMedia("(prefers-reduced-motion: reduce)")` matches (`navigation.ts`, with a test).
- **Notice.** New `src/components/Notice.tsx`, rendered by `App.tsx` inside `.shell-body` after the canvas. The always-present `.notice-region` (absolute, top, `z-index: 5`, `pointer-events: none`) is the `role="status"` / `aria-live="polite"` region and has no height while empty. Panes got `z-index: 10`, the palette backdrop `15`, and the menu keeps `20`. The notice reuses `.banner-text` for its text.
- **Layering.** `ELEVATED_Z = 1000` on the selected node and on any node with a drag override. `sameNode` compares `zIndex`. xyflow already lifts a child to parent z + 1, so an elevated project keeps its children above it.
- **Lint.** It reads sources with `node:fs` through a non-literal dynamic import (`"node:fs" as string`), because the project has no `@types/node`. `import.meta.glob` with `?raw` was tried first and dropped: vitest returns CSS as an empty string, so the lint would have passed without checking anything. A tree test now asserts the file contents are not empty. Named colours are matched as whole identifiers in values only, so selectors, comments and `white-space` don't trip the rule. In TSX, named colours are checked only inside string literals. A violation planted in `nodes.css` failed with `file:line rule` messages, as intended.
- **Icon.** The stroke width is 40 at 1024 (about 1.25 px at 32 px), so the "1-px outline" reads at small sizes. SVG comments can't contain `--`, so the source comment names the colours without the dashes. `npx tauri icon` also wrote `64x64.png`, which was kept, and `android/` and `ios/` folders, which were deleted (desktop only). `tauri.conf.json` was not changed.
- **Not run here:** `npm run tauri build -- --debug --no-bundle` and every manual or screenshot check (no GUI in this session). `npm run build` (tsc + vite) passes.
- Orchestrator (2026-10-17, review + GUI): three review layers on Opus triaged below; 8 patch items applied and re-verified (`cargo test` 207, vitest 271, clippy and `tsc` clean, debug build). The notice's `title` is unreachable while the overlay keeps `pointer-events: none` (the frozen pass-through rule wins); a long notice is cut with an ellipsis and has no hover. GUI pass (foreground-guarded, five planted projects, `SWITCHBOARD_STUB_CHILDREN=3`): canvas with two repos, a non-git folder, a missing folder and `ide` expanded, no accent anywhere; palette selected row in `--bg-hover` with the muted 2-px left bar; settings pane with "Reveal file" focused showing a light 1-px ring, not the accent; New session… notice laid over the canvas top with the cards at the same y as before it (label at y 130 in both shots); `session 3` dragged over `session 1` draws on top and keeps the selection outline. The first run still showed Tauri's placeholder in the title bar: the window icon is embedded by `generate_context!` when the library compiles and Cargo does not track the icon files, so the incremental build kept the old one; after `cargo clean -p switchboard` the title bar shows the new mark (recorded in DESIGN.md's Icons section; CI builds from scratch).

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-17, on Opus) — layers: blind-hunter (BH), edge-case-hunter (EC), verification-gap (VG).

- VG2 / EC1 / EC11 / BH4 the lint ignores the `font` shorthand, so `font: 500 15px var(--font-sans)` passes the type-scale rule — **medium** (the erosion the lint exists to stop): patch — check a size inside a non-keyword `font` value; self-test.
- EC3 / EC10 / BH3 the accent rule looks only at a selector's first class, so `.banner .palette-row { color: var(--accent) }` passes; `var(--accent, …)` escapes the regex — **low**: patch — judge the selector's last compound; match the fallback form; self-tests.
- EC2 `-webkit-box-shadow` escapes the shadow rule — **low**: patch — optional vendor prefix.
- EC6 `font-size: var(--text-md) !important` would fail spuriously — **low**: patch — strip `!important` before the size/radius checks.
- BH1 a selected node and a dragged node share `ELEVATED_Z`, so a selected sibling later in DOM order covers the dragged card — **low**: patch — a drag lifts above selection (`ELEVATED_Z + 1`); test the reverse case.
- EC9 a long notice (multi-line OS error) grows over the canvas instead of staying one row — **low**: patch — one line, ellipsis, full text on hover.
- BH10 the notice reuses `.banner-text`, so banner text styling leaks into it — **low**: patch — its own `.notice-text`.
- BH5 DESIGN.md says the document and the lint "describe the same rules", but line widths, weights and reduced-motion are not linted — **low**: patch — DESIGN.md states which rules the lint enforces and which are review rules.
- BH11 lines lengthened past the wrap width in README, `App.tsx` and `navigation.ts` — **low**: patch — re-wrap.
- VG1 / BH9 no test renders `Notice` (or `Banners`) — **low** (pre-verified, filed defer): defer — joins the component-test entry from 2.4; the GUI pass covers it.
- VG3 / BH4c component colour props (`<Background color=…>`) are not linted — **low** (pre-verified, filed defer): defer — one site today; DESIGN.md records it.
- BH7 `Banners` mounts its live region together with its first banner, which some screen readers miss — **low**, pre-existing (Story 1.3): defer.
- BH6 disabled text in `--fg-faint` is ~1.9:1 on `--bg` — **low**: rejected — the frozen token decision assigns `--fg-faint` to disabled text; noted for Emils to revisit if it reads too faint.
- BH2 the notice can cover a node the arrow keys just revealed at the top edge — **low**: rejected — only within the 3 s a notice shows; clicks pass through.
- EC4 inline styles via a variable or set in `.ts` escape the lint — **low**: rejected — no such site exists; the guard adds a parser for a hypothetical.
- EC5 declaration-only at-rules (`@font-face`, `@property`) are skipped — **low**: rejected — none exist and DESIGN.md forbids font files.
- EC8 a file name with `#`/`?` breaks the URL read — **low**: rejected — no such file and none expected.
- BH3' an accent alias via a custom property on an allow-listed rule — **low**: rejected — needs a deliberate workaround; review catches it.
- BH6' nothing keeps DESIGN.md's allow-list and token tables in sync with the code — **low**: rejected — a parser over prose tables for a three-place list.
- BH8 the README says "Epic 2 complete" before the manual checks — **false** at commit time: the GUI pass runs before the commit; the spec records it.
- BH9' no test pins the 150 ms pan when `matchMedia` returns false — **low**: rejected — the existing pan test asserts `{ duration: 150 }` with no `matchMedia`, the same path.

## Design Notes

- **Lint approach.** Strip `/* … */` comments, then walk the CSS rule by rule: a selector list, then `{ declarations }`, with `@media` blocks descended. A small hand parser is enough because the stylesheets are plain CSS with no nesting.
  - **Accent rule:** a declaration containing `var(--accent)` is allowed only when every selector in its rule starts with an allow-listed class.
  - **Inline styles in TSX:** check each `style={{ … }}` object literal's text for colour literals.
- **Notice overlay.** `position: absolute; top: 0; left: 0; right: 0` inside the canvas's positioned parent (`.shell-body` is the flex row holding the canvas). It uses the banner row's look (muted 2-px border, mark, mono text), takes `pointer-events: none`, and sits at a `z-index` below panes and the palette.

## Verification

**Commands:**
- `cd src-tauri; cargo test; cargo clippy --all-targets -- -D warnings` -- expected: pass, clean
- `npm test; npx tsc --noEmit` -- expected: pass (incl. the design lint), clean
- `npm run tauri build -- --debug --no-bundle` -- expected: builds with the new icon

**Manual checks (if no CLI):**
- Orchestrator (foreground-guarded): five planted projects (repo, repo, non-git, missing, one expanded with `SWITCHBOARD_STUB_CHILDREN=3`). Screenshots of:
  - the canvas;
  - the palette with a selected row;
  - the settings pane with a focused button (Tab);
  - the notice over the canvas (New session…), compared with the screenshot before it to confirm the canvas did not move;
  - a dragged child over its sibling;
  - the window's title-bar and taskbar icon.
