---
title: 'Story 11.5: Status at a glance'
type: 'feature'
created: '2026-11-04'
status: 'done'
baseline_commit: 'ae22e366c74e460897dadc17acb732acffafa799'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-11-context.md'
  - '{project-root}/docs/DESIGN.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-11-4-figures-in-help.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** State words, the glow, the badges and the edges explain themselves only in the help pages. A new operator sees `waiting`, a glow or a dashed line without knowing what it means.

**Approach:** One table of meanings feeds the hover text of every card state, badge and glow. Every edge line also gets a hover title in the edge inspector's words. A new Help page, **What you see**, draws its rows from those same tables, under the session-states and edge-kinds figures.

## Boundaries & Constraints

**Always:**
- **One table:** `stateMeaning(kind)` in `src/canvas/nodes.ts` is exhaustive over `SessionState["kind"]` plus `"stopping"`. Its words are:
  - busy: `Claude is working`
  - waiting: `Claude needs an answer; enter opens its terminal`
  - finished: `the turn ended; look at what it did`
  - idle: `waiting for you`
  - starting: `launched, no output yet`
  - stopping: `being stopped`
  - exited: `the process ended`
  - other: `as the session reports it`

  The `enter` in the waiting text comes from the registry (`commandKey`), so a rebind shows.
- **Cards:**
  - `sessionCardTitle` leads with `<state> — <meaning>` while the poll has seen the session. While its terminal is stopping, it uses `stopping`.
  - The project glow title is `<session label> is <state>`, naming the first session needing attention (the same one `ctrl+j` would pick for that project).
  - The `N live` badge title is `N sessions running` (`1 session running`).
  - The collapsed count title is `N children, collapsed`. It goes on the count element, and the chevron keeps its 11.1 `commandHint`.
  - The unread badge text stays as it is.
  - The review flag title is `asks for review · click to open`.
  - The worktree chip path stays as it is.
  - Each element's `aria-label` carries the same words.
- **Edges:** each stored edge's line gets an SVG `<title>` from a pure `edgeHoverText(edge, live)` in `src/canvas/edges.ts`, using the inspector's state words:
  - `context edge · pending (waiting for idle)`, `context edge · applied`, `context edge · failed (not confirmed)`, or `context edge` with no live state.
  - A cooperate edge reads `cooperate edge` plus its sides' states. If both sides agree, it shows one (`cooperate edge · notified`). If they differ, it shows both as `<name>: <state>` joined with ` · `.
  - The edge label's own tooltip (the full label) stays.
- **The What you see page:** `docs/help/legend.md`, `id: "legend"`, second in `HELP_PAGES` after Canvas & navigation.
  - It is opened from Contents, from `help.legend` ("Help: what you see", in the palette and bindable, with no default key), and from a link in each "What you can see" section of Canvas, Sessions, Projects and Edges. Those sections shrink to one sentence plus the link.
  - Its rows are rendered by the pane from code, not copied in Markdown. A fenced block whose info is `table <name>` names a generated table, by the same mechanism as Story 11.4's figures (`TABLES` beside `FIGURES`; an unknown name draws its text as a code block).
  - It has two tables. `session-states` gives one row per state: the state word in its own canvas look, then `stateMeaning`. `edge-looks` gives one row per look (context, cooperate, pending, failed, selected) with words from `edges.ts`.
  - The page order is: the `session-states` figure, then its table, then prose on the attention colour, the glow, the badges and the Elsewhere chip, then the `edge-kinds` figure and its table.
  - `content.test.ts` vocabulary and the 150–400 word budget apply to the Markdown.
  - F1 routing (`src/help/context.ts`) is unchanged.
- **CHANGELOG** Unreleased gets the hover meanings and the page, under Help. `ROADMAP.md` is untouched.

**Never:**
- No custom tooltip component (native `title` only).
- No second copy of the meanings in Markdown.
- No change to state detection, colours or edge drawing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Each state | `stateMeaning(k)` for all 8 | the words above (test per state) | N/A |
| Unknown poll state | `{kind:"other", raw:"thinking"}` | `thinking — as the session reports it` | N/A |
| Unseen session | historic, never polled | no state line in the title | N/A |
| Glow | project with waiting session "fix login" | title `fix login is waiting` | N/A |
| Badges | 1 live / 3 live; 5 children collapsed | `1 session running` / `3 sessions running`; `5 children, collapsed` | N/A |
| Context edge | pending, detail "waiting for idle" | `context edge · pending (waiting for idle)` | N/A |
| Context edge, no live | — | `context edge` | N/A |
| Cooperate, sides agree | both notified | `cooperate edge · notified` | N/A |
| Cooperate, sides differ | A notified, B pending | `cooperate edge · A: notified · B: pending` | N/A |
| Unknown table | ```` ```table nope ```` | its text drawn as a code block | never markup |

</frozen-after-approval>

## Code Map

- `src/canvas/nodes.ts` -- `sessionCardTitle` (~915) and `branchCardTitle` (~774). Add `stateMeaning` and pass `stopping` from the terminal store (`terminals` `stopping`).
- `src/state/live.ts` -- `stateWord` (~40) and the `SessionState` kinds in `src/ipc/index.ts` (~612).
- `src/canvas/ProjectNode.tsx` -- the glow title (~57), the `project-node-live` badge (~80) and the chevron count (~60-70). The flow-node data needs the first attention session's label and state: look at how `attention` is computed in `toFlowNodes` / `canGoToAttention` (`src/commands/attention.ts`) and reuse that pick.
- `src/canvas/ChildNode.tsx` -- the review flag (~93), which currently has `commandHint("review.open")`. Its new title is `asks for review · click to open`; keep the hint scan green by allow-listing it with its reason or composing it through `commandHint`'s label.
- `src/canvas/Canvas.tsx` -- the context and cooperate edges via `BaseEdge` (~120, ~136). Add the `<title>` as a child `<g>`/path title, or via a sibling element over the hit path. It must show on hover over the hit width.
- `src/state/edgesLive.ts` -- `stateText` (~56), `nowText`, `sideNowText`. Reuse `stateText` in `edgeHoverText`.
- `src/help/markdown.ts`, `src/components/HelpPane.tsx`, `src/help/figures/index.ts` -- the 11.4 figure mechanism. Add `table <name>` the same way (a new node type, `TABLES`). `CommandTable` (~292) is the precedent for a code-drawn table look.
- `src/help/pages.ts` (`HELP_PAGES` ~33) -- add `legend`. Update the `pages.test.ts` and `help.test.ts` counts.
- `src/commands/builtins.ts` -- `help.legend`, beside `help.roadmap` (~317).
- Docs:
  - `docs/help/legend.md` (new).
  - The "What you can see" sections in `canvas.md` (~42), `sessions.md` (~34), `projects.md` (~32) and `edges.md` (~34) shrink to one sentence plus the link. Keep each page ≥150 words. The figures already on those pages may stay.
  - `terms.md` if a new term appears.
  - DESIGN.md: one line for the legend tables' look.
  - `CHANGELOG.md`.

## Tasks & Acceptance

**Execution:**
- [x] `src/canvas/nodes.ts` (+ test) -- `stateMeaning`, plus the title and badge text helpers. Tests cover matrix rows 1–5.
- [x] `ProjectNode.tsx`, `ChildNode.tsx` -- titles and aria labels.
- [x] `src/canvas/edges.ts` (+ test), `Canvas.tsx` -- `edgeHoverText` and the `<title>`. Tests cover matrix rows 6–9.
- [x] `markdown.ts`, `HelpPane.tsx`, a tables module (+ tests) -- `table <name>`. Tests cover row 10 and both tables' rows matching `stateMeaning` and the edge looks.
- [x] `pages.ts`, `builtins.ts`, `legend.md`, the four pages, DESIGN.md, CHANGELOG -- the page, the command, the links, and the updated test counts.

**Acceptance Criteria:**
- Given a waiting session on the canvas, when I hover its card, then the tooltip's first line reads `waiting — Claude needs an answer; enter opens its terminal`.
- Given F1 with a session selected, when Help opens, then it shows Sessions, not What you see.
- Given the full suite, when it runs, then typecheck, `npm test` (audit, hints, content, pages and the design lint) and `npx vite build` pass.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Glow names an acknowledging session `ctrl+j` skips | low | `glowTextOf` omits the `acknowledging` filter `attentionQueue` uses | patch |
| 2 | Memoised cards keep the old `enter` after a rebind | low | no binding subscription on SessionNode/ChildCard | patch |
| 3 | Legend `other` row shows the literal word `other` | low | cards show the raw word | patch |
| 4 | `selected` edge meaning contradicts edges.md on Enter | low | wording | patch |
| 5 | Docs dropped facts: full-path hover, tray **Add folder**, "against the upstream", the session card's two lines, pending "(Retry when done)" | medium | projects/sessions/edges vs ae22e36 | patch |
| 6 | Docs overstate "the same words" for hovers | low | badges/edges give state, not the page's look meanings | patch |
| 7 | `aria-label` on a plain span ignored | low | `project-node-live` | patch |
| 8 | No render tests: EdgeTitle, ProjectNode attention/badges, review flag; `1 child`; cooperate no-live | medium | static data tests only | patch |
| 9 | `STATE_MEANING_KINDS` not compiler-checked | low | hand-written list | patch |
| 10 | CHANGELOG implies badge text changed; doesn't say sections moved to What you see | low | wording | patch |
| 11 | `table name ` with trailing space misses | low | trivial trim | patch |
| 12 | `enter opens its terminal` needs a selected card; `idle — waiting for you` collides with waiting | false | frozen words, chosen in the epic | reject |
| 13 | Edge hover with no live state shows only the kind | false | frozen matrix row: `context edge` | reject |
| 14 | Review flag lost key hint; awkward aria name | false | frozen: `asks for review · click to open`, aria same words | reject |
| 15 | Long accessible name | low | readable; trimming adds rules | reject |
| 16 | Unknown table with empty text renders empty `<pre>` | low | rare authoring error, content test covers shipped pages | reject |
| 17 | Non-context kinds treated as cooperate | low | only two kinds exist | reject |
| 18 | `stopping` label change | low | intended; stopping implies a live terminal | reject |
| 19 | Edge live states listed in edges.md and looks in code | false | different things (states vs looks) | reject |

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm test` -- expected: all pass
- `npx vite build` -- expected: success

**Manual checks (if no CLI):**
- In `npm run tauri dev`, hover a session card, a glowing project, the `N live` badge and an edge, and read each tooltip. Open Help → What you see: the figures sit over their tables.
