---
title: 'Story 11.4: Figures in Help'
type: 'feature'
created: '2026-11-04'
status: 'done'
baseline_commit: '69fd462c83ef99abf340549d41cd102f78cc281c'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
  - '{project-root}/docs/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The help pages describe in prose what is quicker to see: how an edge is drawn, what a card's rows are, how a session's state moves, where panes come in.

**Approach:** A help page can hold a figure as a fenced block with the info string `figure <name>`, whose text is the alt text. The Help pane draws it as a small CSS-animated diagram built from the app's own card, handle and edge classes. Five figures ship. The prose beside each is cut to what the picture does not say.

## Boundaries & Constraints

**Always:**
- **Renderer** (`src/help/markdown.ts`): a `FencedCode` whose `CodeInfo` is `figure <name>` yields `{ type: "figure"; name: string; alt: string }`.
  - `alt` is the block's text, trimmed and collapsed to one line.
  - Info `figure` with no name, or any other info string, renders as today (`codeBlock`).
  - The name is matched exactly. Odd characters are never interpreted.
- **Help pane** (`HelpPane.tsx` `Block`): a `figure` node draws `FIGURES[name]`, the typed table in a new `src/help/figures/index.ts`. A name missing from the table draws the alt text as a code block, so a typo shows and is never markup.
- **Every figure:**
  - built from the app's own classes (`project-node`, `child-node`, `session-state`, `session-dot`, `link-handle`, `link-line`, `link-context`, `link-cooperate`, `pane`, and the xyflow wrapper classes those selectors need), wrapped in a `help-figure` box in DESIGN.md's **Help figures** look: page-wide, at most 160 px tall, `--bg-raised`, 1-px `--border`, `--radius-sm`, labels in mono `--text-xs` `--fg-muted`
  - moves by CSS only (`opacity`, `transform`, `stroke-dashoffset`), with keyframes in a new `src/help/figures.css`
  - loops every 4–8 s, with a pause at the end of each loop
  - shows its end frame still under `prefers-reduced-motion: reduce`
  - has `role="img"` and `aria-label` set to the alt text
  - uses the attention accent only through the existing allow-listed classes
  - has no inline style carrying a colour
  - scales the cards down with `transform: scale(…)` if needed to fit 160 px; never resized boxes
- **The five figures:**
  - `draw-edge` (Edges): a project card and a session card. The handle appears on the hovered card, a dashed line is pulled to the other card and settles as a context edge. Then two session cards are joined by a cooperate edge's double line.
  - `edge-kinds` (Edges, still): five short edges side by side with mono labels: context, cooperate, pending, failed, selected.
  - `node-anatomy` (Projects, still): a project card with its parts named by leader labels: chevron and count, label, `N live`, path, git line, `branches` chip, handle.
  - `session-states` (Sessions): a session card under its project card, stepping `starting → busy → waiting → busy → finished → idle → exited`. The project glows on the attention states.
  - `panes` (Canvas): a miniature canvas. A pane slides in from the right, then the palette appears over the dimmed view.
- **Bundle:** figures are imported only from the lazily loaded Help pane path (`HelpPane.tsx` and/or `pages.ts`, both lazy today), so the main bundle gains nothing. The design lint reads `figures.css` like every CSS under `src/`.

**Never:**
- No image, SVG file, video or animation-library dependency.
- No JavaScript timers driving animation.
- No figure outside the Help pane in this story (11.6 reuses them).
- No new accent use.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Figure block | ```` ```figure draw-edge ```` + "Drag the handle…" | `{type:"figure", name:"draw-edge", alt:"Drag the handle…"}` | N/A |
| No name | ```` ```figure ```` | a codeBlock, as today | N/A |
| Odd name | ```` ```figure <b>x</b> ```` | figure node with a literal name; the pane draws the alt as a code block | never markup |
| Unknown name | `figure nope` | the alt text drawn as a code block | N/A |
| Other fence | ```` ```json ```` | a codeBlock, as today | N/A |
| Reduced motion | `prefers-reduced-motion: reduce` | the end frame, still | N/A |

</frozen-after-approval>

## Code Map

- `src/help/markdown.ts`:
  - `HelpNode` (~20): add a `figure` variant.
  - The `FencedCode`/`CodeBlock` case (~130): read the `CodeInfo` child for `figure …`.
  - `MARKS` (~75): skips `CodeInfo`. Keep it skipped everywhere else.
  - Tests go in `markdown.test.ts`.
- `src/components/HelpPane.tsx` -- `Block` (~168). Add the `figure` case.
- New `src/help/figures/index.ts` (`FIGURES: Readonly<Record<FigureName, ComponentType>>`) and one `src/help/figures/<name>.tsx` per figure, with shared bits as needed.
- New `src/help/figures.css`. Look at the existing reduced-motion pattern in `src/canvas/nodes.css` first, and check the design-lint rules (`src/theme/design.test.ts`, incl. the accent allow-list).
- `src/canvas/nodes.css` -- the real selectors for cards, handles and edges, e.g. `.react-flow__handle.link-handle` and the edge path classes. Figures must render under the same selectors. Read them before building markup.
- Tests:
  - `src/help/content.test.ts` (~70): add "every figure a page names exists in `FIGURES`, and every `FIGURES` entry is used".
  - New `src/help/figures/figures.test.tsx`: `renderToStaticMarkup` each figure, then assert:
    - the alt text is present
    - `role="img"` is present
    - no inline `style` carries a colour (a `#`, `rgb`, `hsl` or `var(--…)` colour token)
    - every class used is defined in `src/canvas/nodes.css`, `src/components/shell.css` or `src/help/figures.css`. Collect the class names from those files' selectors.
- Docs, within the 400-word page budget (`pages.test.ts`):
  - put each figure at the top of the section it illustrates in `docs/help/edges.md` (draw-edge, edge-kinds), `projects.md` (node-anatomy), `sessions.md` (session-states) and `canvas.md` (panes), and cut the prose under it to what the picture doesn't say
  - DESIGN.md "Help figures" (~455) and the Motion row (~661) are already there: keep them true
  - `CHANGELOG.md` Unreleased, under Help

## Tasks & Acceptance

**Execution:**
- [x] `src/help/markdown.ts` (+ test) -- the figure node and the matrix rows 1–3 and 5.
- [x] `src/help/figures/*.tsx`, `index.ts`, `src/help/figures.css` -- the five figures.
- [x] `src/components/HelpPane.tsx` (+ test) -- draw known figures; an unknown name renders as a code block.
- [x] `src/help/figures/figures.test.tsx`, `src/help/content.test.ts` -- the checks listed in the Code Map.
- [x] Docs, DESIGN.md, CHANGELOG.

**Acceptance Criteria:**
- Given the Help pane open on Edges, when it renders, then the draw-edge figure loops and the edge-kinds figure shows five labelled edges, both under the section heading.
- Given `npx vite build`, when it runs, then the main entry chunk contains no figure code. The figures sit in the Help pane's lazy chunk.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Facts cut from prose now live only in pictures; alt texts don't carry them (screen readers, fallback, `plainText`) | medium | edges/projects/sessions alt texts name parts, not looks | patch |
| 2 | sessions.md list regrouped badly: ctrl+j and Elsewhere inside the `stopping` bullet; states unexplained in text | medium | sessions.md | patch |
| 3 | canvas.md lost detail again ("opens a menu instead", "Right-click a node") | low | canvas.md vs 69fd462 | patch |
| 4 | DESIGN claims stages scale to fit; scales are fixed and two stages unscaled | low | figures.css; pane is min(440px, 90vw) | patch (make DESIGN accurate) |
| 5 | CHANGELOG says all figures move; two are still; "five edge looks" | low | CHANGELOG | patch |
| 6 | No test that every `help-anim-*` element also carries `help-anim` | medium | reduced-motion hook is the bare class | patch |
| 7 | draw-edge end frame shows both handles | low | reduced-motion users see a wrong resting look | patch |
| 8 | Empty figure body gives an unnamed `role="img"` | low | aria-label="" | patch (fall back to the name) |
| 9 | Narrow pane clips figures | low | needs width < ~470 px; container-query length division unsupported | reject (DESIGN made accurate, #4) |
| 10 | edge-kinds mixes kinds and states | false | the epic names exactly these five looks | reject |
| 11 | Class test doesn't check selector context | low | visual check done by screenshots | reject |
| 12 | `figure draw-edge extra` falls back to code | false | frozen: name matched exactly; visible fallback | reject |
| 13 | Palette shows `n` beside New session… | false | `project.newSession` is bound to `n`; the real palette shows it | reject |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass, including the design lint, `content.test.ts` and `pages.test.ts`
- `npx vite build` -- expected: success. A grep of the entry chunk for a figure's alt text or `help-figure` finds nothing.

**Manual checks (if no CLI):**
- In `npm run tauri dev`, press F1 and open Edges, Projects, Sessions and Canvas. Each figure reads clearly at the pane's width, loops with a pause, and holds still with reduced motion on in the OS.
