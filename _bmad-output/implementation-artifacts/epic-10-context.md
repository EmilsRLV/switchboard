# Epic 10 Context: Help in the app

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Put help where the work is. Add a Help pane of short guide pages written in the app's own words. Add a Getting started checklist that ticks itself off as the operator actually does each step. Ship the changelog and roadmap inside the app, with a quiet pointer to what changed after an update. All content is Markdown kept in the repo and bundled at build time. Nothing is fetched and no runtime dependency is added. There is no overlay tour, coach marks or wizard, so the canvas stays the home screen.

## Stories

- Story 10.1: Help pane and guide renderer
- Story 10.2: Guide pages and F1 from where you are
- Story 10.3: Getting started checklist
- Story 10.4: Changelog and roadmap in Help
- Story 10.5: What's new after an update

## Requirements & Constraints

- **Help pane:** F1 or "Help" in the palette opens it. It is a right-side pane like the others. Esc closes it and the chrome stays low. It opens on Contents. There is no welcome page, overlay, modal or coach marks.
- **Safe rendering:** support only a Markdown subset: headings, paragraphs, bullet and numbered lists, emphasis, inline and fenced code, and links.
  - Raw HTML and images render as literal text, never as markup.
  - `http(s)` links open in the system browser only when clicked. No other scheme is ever opened.
  - Links between pages (with optional `#heading`) navigate inside the pane.
- **No network:** help content is never fetched. The app makes no network calls apart from what `claude` itself makes and the localhost endpoints.
- **Every Help action is a command:** each one is in the palette and can be bound to a key. The pane's buttons and Contents rows go through commands, so the existing "everything is a command" audit still passes.
- **Guide content:** one short page per area, about 150–400 words each. Each page opens with what the thing is, then how to do it using the keys and palette titles exactly as the app shows them, then the states the operator can see. Pages use only the vocabulary on the Terms page (project node, session node, branch node, worktree, context edge, cooperate edge, handle, terminal pane, tabs, pop-out, plain terminal, launch sheet, edge inspector, review pane, import pane, settings pane, Diagnostics, command palette, toast, attention colour).
- **Keyboard page:** its command table is generated from the command registry, with the effective bindings after `keybindings.json` is applied.
- **Checklist:**
  - Six steps tick from real app state, whatever route the operator used.
  - It shows on the first run as a dismissible canvas card. It can be reopened from Help.
  - Progress and dismissal persist across restarts.
- **Changelog and roadmap:** both are hand-curated at the repo root, in plain words, with no story ids, requirement ids or file names. Help shows the app version. A test ties the newest changelog entry to the version in `package.json` and `Cargo.toml`.
- **What's new:** after the version changes, show a one-time "new in <version>" pointer, recorded as seen once the Changelog is opened. Nothing shows on a fresh profile.
- **Out of scope (Later):** searching the help, and serving the guide over MCP.

## Technical Decisions

- **Content and bundling:**
  - Guide pages live in `docs/help/*.md`, plus `CHANGELOG.md` and `ROADMAP.md` at the repo root.
  - They are bundled with Vite `?raw` imports.
  - The page list is one typed table in `src/help/pages.ts`.
- **Renderer:**
  - A pure function from Markdown to a plain element tree. Never use `innerHTML`.
  - `@lezer/markdown`, already a dependency, may do the parsing.
  - Unit-tested in node, since vitest has no DOM. Tests cover each construct, raw HTML and a `javascript:` link.
  - The changelog and roadmap go through the same renderer, so the same no-raw-HTML rule applies to them.
- **Pane:** `help` is a new member of the `Pane` union in `src/state/ui.ts`. It has the settings pane's width, and opening another pane closes it.
- **Commands:**
  - `help.open`, `help.page` (a pick list on the Link to… model), `help.contents`, `help.gettingStarted`, `help.changelog`, `help.roadmap` and `help.whatsNew` (a `dynamicTitle`).
  - `help.toggle` (F1) is a hidden key carrier, like `settings.toggle`.
  - `checklist.show` and `checklist.dismiss`.
- **F1 inside a terminal:** a bare key is never passed through, so F1 goes to the program running in the terminal. `ctrl+shift+k` still opens Help.
- **App state file:** the new app-written `state.json` sits beside `settings.json` (`%APPDATA%\switchboard\`, `$XDG_CONFIG_HOME/switchboard/`).
  - It is schema-versioned, loaded with `load_or_init`, and written atomically through `persist.rs`.
  - It is never watched and never hand-edited. Deleting it resets only the checklist and the seen version.
  - Never write this state into `settings.json`, `workspace.json` or `~/.claude`.
- **Pure functions with tests:**
  - F1 page mapping, from (open pane, selection) to a page.
  - Checklist detection, from the stores' state to the set of ticked steps.
  - Show-the-chip decision, from (stored version, current version, first run) to show or not.
- **Version:** read from `app_info`, which reports Cargo's version (`tauri.conf.json` sets none).
- **Help-content test (Story 10.2):**
  - Every listed page exists, and every file is listed.
  - No page contains raw HTML.
  - Every page link and `#heading` resolves.
  - Every key written as `` `ctrl+k` `` in a page is the default binding of some registered command.

## UX & Interaction Patterns

- **Visual style:** follow DESIGN.md: tokens only and no accent. Prose uses `--font-sans`, and code and keys use `--font-mono`. Add no new motion. DESIGN.md gains a "The Help pane" entry under Layout pieces.
- **Contents:** lists the guide pages in order, then Getting started, Changelog and Roadmap. `Switchboard <version>` shows with the config folder path under it in mono. **← Contents** goes back.
- **F1 from where you are:**

  | What is open or selected | Page F1 opens |
  |---|---|
  | Launch sheet | Sessions & launch sheet |
  | Terminal pane | Terminals, tabs & pop-outs |
  | Edge inspector, or a selected edge | Edges |
  | Review pane | Review |
  | Import pane | Projects |
  | Settings pane | Settings & diagnostics |
  | Worktree sheets | Branches & worktrees |
  | Selected project, session or branch node, with no pane open | That node's page |
  | Anything else | The page last read this run, else Contents |

- **Checklist card:**
  - It sits at the canvas's top-right under the banner strip. It is above the canvas and below panes, the palette, the menu and toasts.
  - It is compact, with no animation and no accent.
  - Each step whose command is enabled right now is a button. The others are plain text.
  - A ticked step shows a muted `✓` in `currentColor`.
  - After all six steps it reads `All done` and goes away at the next launch.
  - A profile that already existed before this build never gets the card automatically.
- **Empty canvas:** the hint ends with `F1 help` in the same mono, muted style. Update the README's clean-machine checklist quote to match.
- **What's new chip:** sits at the bottom-left beside the Elsewhere chip and matches its look: mono `--text-xs`, `--fg-muted` and a 1-px `--border`. No OS toast, no banner. It stays across launches until the Changelog is opened.

## Cross-Story Dependencies

- Story 10.1, the pane, renderer, page table and `help.*` commands, is the base for all the others.
- Story 10.2 builds on Story 10.1's page table, renderer and page navigation.
- Story 10.3 introduces `state.json`. Story 10.5 reuses it for the last version seen and relies on the checklist being the first-run surface.
- Story 10.5's chip opens the Changelog page from Story 10.4. Opening the Changelog by any route marks the version as seen.
- **Other epics:**
  - Epic 9's command registry, `keybindings.json` and its "everything is a command" audit (Story 9.4).
  - The Story 9.1 first-run detection and empty-canvas hint.
  - The existing pane system and the Elsewhere chip.
  - The Story 10.4 changelog summarises Epics 1–9.
