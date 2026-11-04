---
title: 'Sprint change proposal — Epic 11: Learn by looking'
status: 'proposed'
created: '2026-11-04'
author: 'Claude (Fable 5.1) for Emils'
mode: 'batch'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture.md
  - docs/DESIGN.md
  - _bmad-output/implementation-artifacts/spec-10-3-getting-started-checklist.md
  - _bmad-output/implementation-artifacts/deferred-work.md
---

# Sprint change proposal: Epic 11, "Learn by looking"

Produced with the `bmad-correct-course` flow in batch mode (the operator answered the trigger questions up
front; the checklist was worked through against the code and the planning docs rather than interactively).
Nothing here is applied to code. The PRD, `docs/DESIGN.md` and `epics.md` edits listed in §4 are made
alongside this proposal; approval of this document approves them.

## 1. Issue summary

**Trigger.** All ten epics (44 stories) are done and on `master`. Using the app, Emils finds it hard to learn
and hard to read at a glance, and Epic 10's help is text where a picture or a visible control would do:

| Pain point | What the code does today (verified 2026-11-04) |
|---|---|
| Empty canvas / first run: not knowing what to do first | `src/canvas/Canvas.tsx` shows one centred mono line (`Add a project — ctrl+o, drop a folder, or ctrl+k · F1 help`). The Getting started card (Story 10.3, `src/components/ChecklistCard.tsx`) is a six-row text list. Nothing shows *where* things happen. |
| Hidden actions: too much is reachable only through the palette or a key | Cards carry three visible controls in all: the chevron, the `branches` chip (`ProjectNode.tsx`) and the `review` flag (`ChildNode.tsx`). Everything else (`New session…`, `Plain terminal…`, `Link to…`, `Review changes`, `Resume`, `Fork`, `Stop`, worktrees) sits behind a right-click (`rightClickNode` in `src/commands/nodes.ts`) or a key. The context menu (`src/components/ContextMenu.tsx`) renders `item.title` only: no keys. A right-click on the canvas background opens nothing (`rightClickTarget` returns `null` off a node). Tooltips are ad hoc (`title="Close (Esc)"`, `title="Drag to link"`), not derived from the registry, so a rebind in `keybindings.json` leaves them wrong. |
| Edges and handles: how to draw them, what handles do, what the kinds mean | The handle (`src/canvas/LinkHandles.tsx`, `.link-handle` in `nodes.css`) is a 7-px dot invisible until hover or selection. The kinds are told apart by a dashed vs a double line (`DESIGN.md` → Edges). `docs/help/edges.md` explains all of it in 43 lines of prose. |
| Status and state: reading glow colours, card states and badges at a glance | Seven state words (`starting`, `busy`, `idle`, `waiting`, `finished`, `stopping`, `exited`, plus whatever the poll reports), the attention colour on the card and the project glow, the `N live`, count, `N new` and `review` badges. Their meanings live in `DESIGN.md` → Status colours and in the help pages' "What you can see" sections, never on the thing itself. |

**Category.** New requirement from the stakeholder (the operator), after use. Not a technical limitation and
not a failed approach: Epic 10's pane, renderer, checklist and `state.json` all work and are reused.

**Evidence.** Emils's answers (2026-11-04): all four pain points apply; all four visual helps are wanted:
inline hints on the canvas that fade once used; visible controls (hover toolbars, context menus, tooltips
that show the shortcut); animated help pages in place of text-heavy ones; a short, skippable first-run
guided tour with spotlights.

**The reversal.** Epic 10 decided, and the PRD recorded (FR-HELP-1, UX principle 1, the Epic 10 intro and
Story 10.3's "no wizard, no overlay, no modal"): *no welcome page, no overlay tour, no coach marks, no
wizard*. Emils now deliberately reverses the **tour** part: a first-run guided tour with spotlights is
wanted. The rest of that decision stands: no welcome page, the canvas is the home screen, the Getting started
card stays a card, nothing is a modal that blocks the app without a one-key way out. This proposal records the
reversal explicitly here, in the PRD (FR-HELP-1 revised, FR-HELP-16 added, UX principle 6 added, Q9) and in
`epics.md` (Epic 10 intro note, Epic 11 intro).

## 2. Impact analysis

### 2.1 Epics

- **Epic 10 (done).** Nothing is rolled back. Its surfaces are extended: the Help pane gains figures and a
  page; the checklist's latched steps become the signal that hides inline hints; `state.json` gains two
  fields (schema 3). The "no overlay tour" sentence in its intro is annotated as reversed by Epic 11.
- **Epics 2, 6 (done).** The cards (`ProjectNode.tsx`, `ChildNode.tsx`), the canvas (`Canvas.tsx`) and the
  menu (`ContextMenu.tsx`, `commands/nodes.ts`) gain a toolbar, hints, a background menu and keys in rows.
  The fixed card sizes (240 × 80, 208 × 40) that `nodes.ts` geometry depends on are **not** changed: the
  toolbar and hints sit outside the card box.
- **Epic 9 (done).** Story 9.4's command audit (`src/commands/audit.test.ts`) applies to every new button:
  each is one `runCommand` call or an allow-listed item-level handler. Story 9.3's performance budget applies:
  a toolbar that is in the DOM only while its card is hovered or selected, hints capped at three, figures only
  inside the lazily loaded Help pane.
- **New epic.** Epic 11, six stories, appended after Epic 10. No resequencing: every earlier epic is done.

### 2.2 Artifacts

| Artifact | Conflict | Change |
|---|---|---|
| `prd.md` | FR-HELP-1 says "no overlay tour, no coach marks, no modal"; UX principle 1 says "no welcome page" (kept); nothing covers visible controls, hints, figures, a legend. | Revise FR-HELP-1; add FR-HELP-12 … FR-HELP-16; add UX principle 6; add open questions Q9 … Q14. |
| `docs/DESIGN.md` | No rules for a node toolbar, keys in the menu, tooltips, inline hints and the ghost card, help figures, a status legend, a tour spotlight. The Motion table says "only six motions exist". | New Layout pieces entries; a Node anatomy note on the toolbar; Motion table extended (three new motions, every one static under reduced motion); the accent allow-list is **not** extended (no new piece uses the accent). |
| `epics.md` | "Ten epics"; no Epic 11. | Overview, Epic List, Epic 10 intro note, Epic 11 with Stories 11.1 … 11.6. |
| `architecture.md` | None. A7 (React + xyflow + plain CSS) covers everything; no new dependency, no new process, no new file beyond fields in `state.json`. | No edit. §4's table could later name `help/figures/`; left for the story that creates it. |
| `docs/help/*.md`, `CHANGELOG.md`, `ROADMAP.md` | Pages get figures and a new `legend.md`; the changelog's `Unreleased` gets the epic's entries. | Story deliverables, not planning edits. |
| `README.md` "Where things live" | `state.json` description names the checklist and the seen version only. | Story 11.3 / 11.6 add `hints` and `tour` to the sentence. |
| `sprint-status.yaml` | Not present in `implementation-artifacts/` (the repo tracks stories by spec files and commits). | N/A. |

### 2.3 Technical

- **Frontend only.** Rust changes are limited to `src-tauri/src/appstate.rs` (schema 3: `hints.hidden`,
  `tour.done`) and its IPC (`state_get` gains the fields; two small setters), on the Story 10.3 / 10.5 pattern
  (an older file upgrades silently; a newer one is read-only).
- **No new dependency** (NFR-8, and the Story 10.1 rule). Figures are React components with CSS keyframes;
  the tour's dim layer reuses the palette backdrop's `color-mix(in srgb, var(--bg) 55%, transparent)`; the
  node toolbar may use xyflow's `NodeToolbar` (already in `@xyflow/react` 12) or a plain element positioned
  outside the card box.
- **Design lint.** New CSS goes under `src/`, so the lint covers it. The tour's cut-out must be four dim
  rectangles, never a `box-shadow` spread (rule 2). Hints use `--fg-muted` text, never the accent.
- **Reduced motion.** Three new motions (hint fade-out, tour cut-out move, figure loops) and every figure
  honour `prefers-reduced-motion: reduce` like the six existing ones.

## 3. Recommended approach

**Direct adjustment: add Epic 11 (six stories).** No rollback (nothing from Epic 10 is wrong, only
incomplete for this goal) and no MVP review (the PRD's v1 scope is shipped; this is v1.x polish of the
learning curve).

Effort: medium (six stories sized like Epic 10's; the largest are the figures and the tour). Risk: low to
medium; the risks are visual, not structural: a toolbar that makes the canvas busy, hints that nag, a tour
that annoys. Each story carries its own escape hatch (`hints.hide`, Skip, toolbar on hover/selection only)
and the DESIGN.md rules keep every piece inside the tokens.

### 3.1 Animated help: the options weighed

| Option | For | Against | Verdict |
|---|---|---|---|
| A. Hand-recorded clips (GIF / WebM / APNG) bundled as assets | Shows the real thing | Hand-recorded, so it drifts from the app with every visual change; large (`data:` or assets through the bundler); a dark-only recording still differs from the live theme; cannot honour reduced motion; the renderer would need an image/video node, breaking the "never markup" rule's simplicity | Rejected |
| B. An animation library (Lottie, Rive, Framer Motion) | Rich motion | A runtime dependency (Story 10.1's "no new dependency" rule, bundle creep risk in architecture §10); artwork lives outside the app's CSS, so it drifts from the tokens | Rejected |
| C. **CSS/SVG-animated figures rendered from React components built from the app's own classes** (`project-node`, `child-node`, `session-state`, `link-handle`, `link-line`) | Always the app's look by construction (a token or card change moves the figures with it); the design lint covers the CSS; keyframes on opacity, transform and `stroke-dashoffset` are cheap; static end frame under reduced motion; testable in node with `react-dom/server`; a `figure <name>` fenced block keeps the renderer safe (an unknown name falls back to today's literal text) | Each figure is hand-built; motion must be kept small (a few seconds, looping) to match "little motion" | **Chosen** |

Figures land through the Markdown pages, so pages stay the single source and the renderer's safety story
(no HTML, no images) is unchanged: the info string of a fenced block names a figure, the block's text is the
alt text, and the Help pane maps the name to a component from a typed table (`src/help/figures/`).

### 3.2 Story order (each ships value on its own)

1. **11.1 Keys where the action is** — keys in the context menu, a canvas background menu, tooltips from the
   registry. Smallest, touches every later story's buttons.
2. **11.2 The node toolbar** — hover/selection toolbar on project, session and branch cards; `⋯` opens the menu.
3. **11.3 The ghost card and inline hints** — empty-state ghost project card; hints tied to the checklist's
   steps that fade once the step is done; `hints.hide` / `hints.show`; `state.json` schema 3 (first field).
4. **11.4 Figures in Help** — the `figure` block, the figure table, the first five figures.
5. **11.5 Status at a glance** — state meanings in tooltips on cards, glow, badges and edges; a **What you
   see** page with the state and edge figures; `help.legend`.
6. **11.6 The first-run tour** — six stops with spotlights, reusing the ghost card, the toolbar and the
   figures; `tour.start` / `tour.next` / `tour.back` / `tour.skip`; `tour.done` in `state.json`.

## 4. Detailed change proposals

### 4.1 PRD (`prd.md`)

**FR-HELP-1**, Level Must.

OLD: `… It opens on a Contents list of short guide pages. No welcome page, no overlay tour, no coach marks, no modal.`

NEW: `… It opens on a Contents list of short guide pages. No welcome page and no modal that blocks the app. (The "no overlay tour, no coach marks" part of this requirement was reversed on 2026-11-04 for Epic 11: see FR-HELP-16 and UX principle 6.)`

Rationale: the reversal must be visible where the original decision was written, so it is not re-argued.

**New rows** FR-HELP-12 … FR-HELP-16 (all Must), after FR-HELP-11: visible controls (toolbar, menu keys,
tooltips, canvas menu); inline hints and the ghost card; figures in help; status at a glance (meanings on
the thing, a legend page); the first-run tour. Full text in the PRD.

**UX principles**: new principle 6, **Show before telling**, with the reversal recorded in it. Principle 3
(low chrome) gains one sentence: visible controls appear on hover or selection and never as permanent chrome.

**Open questions**: Q9 … Q14 (§6 below) with proposed answers.

### 4.2 DESIGN.md

New Layout pieces entries: **The node toolbar**, **Keys in the context menu and tooltips**, **The canvas
menu**, **The ghost card and inline hints**, **Help figures**, **The What you see page**, **The tour**. The
**context menu** entry gains the key column. **The canvas** entry's empty state changes from the hint line to
the ghost card. **Motion** gains three rows and its intro changes from "six" to "nine". The accent
allow-list is unchanged: hints, the toolbar, the tour card and the cut-out outline never use the accent
(figures show the attention states through the existing allow-listed classes). Full text in DESIGN.md.

### 4.3 epics.md

Overview: "Ten epics" → "Eleven epics", with Epic 11's one-line purpose. Epic List: `11. Learn by looking`.
Epic 10 intro: one sentence noting the reversal. New **Epic 11** section with Stories 11.1 … 11.6 in the
Given/When/Then style, each citing its FRs and naming the files it touches. Full text in epics.md.

### 4.4 architecture.md

No change. A7 holds; no new crate, package, process or file. Recorded here so it is not re-checked.

## 5. Implementation handoff

**Scope: moderate.** A new epic in the existing plan; no re-plan of goals or architecture. Route: the
operator approves this proposal, then `bmad-build` picks up Story 11.1 and the stories become
`spec-11-<n>-*.md` as before (the Code Map in each spec names the files listed in the stories).

Success criteria for the epic:

- A new operator on a fresh profile reaches a running session, a drawn edge and an opened review without
  reading a help page, guided by the ghost card, the hints, the toolbar and the tour.
- Every state word, glow and badge explains itself on hover, and the What you see page shows the states moving.
- Every new action is a registry command (palette + bindable); `audit.test.ts` passes with no new
  allow-list entry that is not item-level.
- The design lint passes; no new dependency; no network; `state.json` holds the new persistent flags and
  `settings.json` / `workspace.json` are untouched.
- Pan with 50 nodes stays smooth with the toolbar code in place (the Story 9.3 measure).

## 6. Questions for Emils (decided 2026-11-04: all as recommended)

| # | Question | Recommended answer |
|---|---|---|
| Q9 | Does the tour start on its own on a fresh profile, or is it only offered? And what about the Getting started card, which also shows on a fresh profile? | **Start on its own**, once, after the canvas's first frame, Skip one `esc` away; the Getting started card appears when the tour ends or is skipped, so the first run shows one thing at a time. Existing profiles never auto-start it; they get **Take the tour** in the palette and on the Getting started page. **Decided (Emils, 2026-11-04): as recommended.** |
| Q10 | Toolbar buttons: short words (`new`, `term`, `link`, `review`) or glyphs? | **Short words** in mono `--text-xs`. DESIGN.md rule 5 has no icon set, and a word needs no legend. At most four, then `⋯`. **Decided (Emils, 2026-11-04): as recommended.** |
| Q11 | When does the toolbar show: on hover only, or on hover and while the card is selected? | **Both.** Selection is how keyboard users land on a card; a selected card already shows its handle (Story 6.1), so the toolbar follows the same rule. Never permanently. **Decided (Emils, 2026-11-04): as recommended.** |
| Q12 | What makes an inline hint go away: its checklist step (latched, persisted), or a hover/use counter of its own? | **The checklist step.** The detection and persistence exist (`detectSteps`, `state.json`); a hint is the step's shadow on the canvas. One global `hints.hide` / `hints.show` pair; hints show only while the Getting started card shows (fresh profile, not dismissed) or after `hints.show`. **Decided (Emils, 2026-11-04): as recommended.** |
| Q13 | How many figures in 11.4, and which pages? | **Five**: `draw-edge` (Edges), `edge-kinds` (Edges, reused on What you see), `node-anatomy` (Projects), `session-states` (Sessions, reused on What you see and in the tour), `panes` (Canvas). More can follow page by page once the mechanism is in. **Decided (Emils, 2026-11-04): as recommended.** |
| Q14 | Where does the status legend live: a section on the Sessions page, or its own page? | **Its own short page, "What you see"** (`legend.md`, after Canvas in Contents), reachable by `help.legend`, so one page answers "what does this colour mean" for sessions, projects, badges and edges at once; the Sessions and Edges pages link to it rather than repeating. **Decided (Emils, 2026-11-04): as recommended.** |
| Q15 | May the tour's dim layer be clicked through to the spotlit target (so stop 2 can be *done* by dropping a folder), or is the tour read-only until Finish/Skip? | **Read-only.** Each stop says the key; the operator does it after. Click-through makes the stops' targets move under the cut-out and doubles the test surface. Can be revisited after one run with real users (Emils). **Decided (Emils, 2026-11-04): as recommended.** |

## 7. Checklist record (bmad-correct-course)

| Item | Status | Note |
|---|---|---|
| 1.1 Triggering story | [x] | None: a post-Epic-10 review by the operator. |
| 1.2 Problem statement | [x] | §1. New stakeholder requirement. |
| 1.3 Evidence | [x] | §1 table (code verified) and the operator's answers. |
| 2.1 Current epic completable | [N/A] | All epics done. |
| 2.2 Epic-level changes | [x] | Add Epic 11; annotate Epic 10. |
| 2.3 Remaining epics | [N/A] | None remaining. |
| 2.4 Invalidated / new epics | [x] | One new epic; none invalidated. |
| 2.5 Order / priority | [x] | Appended; stories ordered §3.2. |
| 3.1 PRD | [x] | §4.1. |
| 3.2 Architecture | [x] | No change, §4.4. |
| 3.3 UX (DESIGN.md) | [x] | §4.2. |
| 3.4 Other artifacts | [x] | README sentence, help pages, changelog: story deliverables. |
| 4.1 Direct adjustment | [x] Viable | Chosen. Effort medium, risk low–medium. |
| 4.2 Rollback | [ ] Not viable | Nothing to roll back. |
| 4.3 MVP review | [ ] Not viable | MVP shipped; this is v1.x. |
| 4.4 Selected path | [x] | Option 1. |
| 5.1–5.5 Proposal components | [x] | §§1–5. |
| 6.1–6.2 Review | [x] | This document. |
| 6.3 User approval | [x] | **Approved by Emils, 2026-11-04: Q9–Q15 as recommended.** |
| 6.4 sprint-status.yaml | [N/A] | Not used in this repo. |
| 6.5 Handoff | [x] | §5. |
