# Epic 11 Context: Learn by looking

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

After all ten epics shipped, the operator found Switchboard hard to learn and hard to read at a glance: the first run is a blank canvas with one hint line, most actions hide behind a right-click or a key, nothing shows how to draw an edge, and the state words, attention colour, glow and badges explain themselves only in prose. This epic makes the app show what it can do: keys shown where actions are, a hover/selection toolbar on every card, a ghost card and fading inline hints for the first steps, CSS-animated figures in Help built from the app's own components, meanings on every state, badge and edge plus a "What you see" page, and a short skippable first-run tour. Success: a new operator on a fresh profile reaches a running session, a drawn edge and an opened review without reading a help page.

## Stories

- Story 11.1: Keys where the action is
- Story 11.2: The node toolbar
- Story 11.3: The ghost card and inline hints
- Story 11.4: Figures in Help
- Story 11.5: Status at a glance
- Story 11.6: The first-run tour

## Requirements & Constraints

- **Visible controls sit beside keys, never in place of them.** Every new action is a registry command, listed in the palette and bindable. Every new button goes through `runCommand` so the command audit test passes with no new allow-list entry unless the button is item-level (for example a toast's Allow or a tab's ×).
- **Low chrome.** Toolbars and hints show only on hover or selection, or only until a step is done. Nothing is permanent chrome. There is no welcome page, the canvas stays the home screen, the Getting started card stays a card, and nothing modal blocks the app without a one-key way out.
- **The tour is a deliberate reversal** of Epic 10's "no overlay tour". It runs once on a fresh profile, has about six stops, and is read-only: it takes pointer events and nothing underneath can be clicked. `esc` skips it, and the palette still opens over it. It never starts on its own on a profile that existed before this build, and it runs no action itself.
- **Inline hints** go when their Getting started step latches (the existing checklist detection) or when the operator hides them globally (`hints.hide` / `hints.show`). They show while the checklist card shows, or after `hints.show`. At most one hint per card and three on the canvas.
- **No network, no new dependency, no video or image assets.** Figures are React components over the app's own CSS classes. Help content is never fetched.
- **Performance.** Pan with 50 nodes must stay smooth with the toolbar code in place, so the toolbar is absent from the DOM unless its card is hovered or selected. Figures load only inside the lazily loaded Help pane, and the main bundle gains nothing.
- **Accessibility.** Figures have `role="img"` with the alt text as their name. Aria labels carry the same meaning words as tooltips. The toolbar is not in the Tab order. The tour moves focus to its card and gives it back when it ends.
- **Docs are deliverables.** Each story updates the relevant `docs/help/*.md` pages (the word budget from Story 10.2 still holds, and pages keep the Terms vocabulary), DESIGN.md, and the `Unreleased` section of `CHANGELOG.md`. The README's "Where things live" sentence names the new `state.json` fields.

## Technical Decisions

- **Frontend only, plus `state.json` schema 3.** Rust changes are limited to `src-tauri/src/appstate.rs`, which gains `hints: { hidden }` and `tour: { done }`. It follows the Story 10.3 / 10.5 pattern: a version-2 file upgrades silently with defaults of `false`, a newer file is read-only, `state_get` carries the fields, and small atomic setters (`hints_set`, `tour_set`) write them on the `checklist_set` pattern. `settings.json` and `workspace.json` are never touched.
- **Fixed card sizes stay** (240 × 80 project, 208 × 40 child). Toolbars and hints sit outside the card box, so `nodes.ts` geometry, `toFlowNodes` and the arrow keys are untouched. The toolbar may use xyflow's `NodeToolbar` (already in `@xyflow/react` 12) or a plain element.
- **Registry extensions:**
  - `Command.menu` widens to `"node" | "canvas"`.
  - Commands gain `toolbar?: number` (order, only on node-menu commands) and `short?: string` (the toolbar word).
  - Effective keys are read from the registry's `binding` on render, so a rebind in `keybindings.json` shows everywhere.
  - One helper, `commandHint(id)`, builds tooltips.
- **Pure, tested functions carry the logic:** `canvasMenuCommands()`, `toolbarCommands(target)`, `hintsFor(sources, done, hidden)`, `stateMeaning(state)` and `edgeHoverText(edge, live)`. `stateMeaning` is the one table of meanings, used by tooltips and by the What you see page.
- **Figures** are named in Markdown as a fenced block with the info string `figure <name>`, whose text is the alt text. They map to components through a typed `FIGURES` table. An unknown name renders as a literal code block and never as markup, so the renderer's safety holds. Tests check that every figure named in a page exists and every figure in the table is used. A node test renders each figure with `renderToStaticMarkup` and checks that the alt text is present, that no inline style sets a colour, and that every class comes from the app's own CSS.
- **Tour:** its stops are a typed table, and targets are `[data-tour="<id>"]` attributes on the real elements (a static-scan test checks they exist). Its keys are hidden commands guarded by `when: isTourOn()`. `tour.skip` comes first in the Esc order, before `contextMenu.close`, and `tour.next` comes before `selection.activate`.
- **Design lint applies to all new CSS under `src/`:**
  - No shadows: the tour cut-out is four dim rectangles, never a `box-shadow` spread.
  - No colour literals, and font sizes and radii from tokens only.
  - The accent allow-list is not extended. Hints, the toolbar, the tour card and the cut-out never use the accent, and figures show attention states only through the existing allow-listed classes.

## UX & Interaction Patterns

- **Show before telling** (new UX principle): controls are visible where the thing is and carry their key; a state says what it means where it is shown; help prefers a short moving picture to a paragraph.
- **Keys:**
  - Context-menu rows end with their key in the palette's key look.
  - Tooltips are the native `title`: the command's title, then ` · ` and the key (`Close · esc`). There is no custom tooltip surface.
  - The canvas menu (a right-click on the background that did not move) uses the context menu's look. A right-drag still pans.
- **Node toolbar:** `--bg-raised`, 1-px border, `--radius-sm`. At most four short mono `--text-xs` words, then `⋯`, which opens the node menu. Disabled commands are left out, never greyed. Destructive actions such as Stop stay in `⋯`. No accent, no animation.
- **Ghost card:** a dashed 1-px `--fg-faint` box of the project card's size, `Drop a folder here`, with the keys below. A click on it runs "Add project". **Hints:** mono `--text-xs` `--fg-muted` captions with no box, that let clicks through, are not drawn under an open pane, and fade out over 300 ms.
- **Figures:** at most 160 px tall, on `--bg-raised` inside a 1-px `--border` box. They animate only opacity, transform and `stroke-dashoffset`, loop every 4–8 s with a pause, and show their end frame still under reduced motion.
- **Tour:**
  - A dim layer (`--bg` at 55%, z 14: under the palette at 15 and the menu at 20) with a cut-out that has the selected node's `--focus` outline.
  - A card `min(360px, 90vw)` wide, with a step counter and Back / Next (Finish) / Skip. The cut-out moves over 150 ms, and the card appears without animation.
  - The Getting started card is held back until the tour ends.
- **Motion:** three new motions in all (hint fade-out, figure loops, tour cut-out move). Each is listed in DESIGN.md's Motion table and is instant or static under `prefers-reduced-motion`.

## Cross-Story Dependencies

- 11.1's `commandHint` and its menu-key rendering are used by 11.2 (toolbar tooltips, `⋯` → the node menu) and by 11.3 (the ghost card's keys).
- 11.3 introduces `state.json` schema 3 (`hints`). 11.6 adds `tour` to the same schema. Both build on the checklist store and the `first_run` signal from Story 10.3.
- 11.4's `FIGURES` table and figures (`draw-edge`, `edge-kinds`, `node-anatomy`, `session-states`, `panes`) are reused by 11.5 (the What you see page) and 11.6 (tour stops without a target).
- 11.6 targets 11.3's ghost card, 11.2's toolbar `new` button and a card's handle, so it lands last.
- 11.5 adds a Help page (`legend`, second in Contents), and `pages.test.ts` and `help.test.ts` counts go up by one. F1 routing (`src/help/context.ts`) is unchanged.
- Story 9.4's command audit and Story 9.3's performance measure from earlier epics apply to every story.
