# Switchboard design

The single statement of the visual system. Dark only, low chrome, one accent. The values live in
[`src/theme/tokens.css`](../src/theme/tokens.css). Part of the rules is enforced by the design lint,
[`src/theme/design.test.ts`](../src/theme/design.test.ts), which runs in `npm test` and so in CI: colour
literals, gradients and shadows, font sizes, radii and the accent allow-list (its table is in
[The design lint](#the-design-lint)). **For those rules this document and the lint say the same thing:
when one changes, the other changes with it.** The rest are review rules, checked by eye and not by
the lint: 1-px lines and the 2-px indicators, font weights 400 and 500 only, and the
`prefers-reduced-motion` overrides.

Styling is plain CSS with CSS variables: no component library, no CSS-in-JS, no icon library, no font
files. `settings.theme` stays reserved; there is no light theme.

## Tokens

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0f1115` | The page and the canvas; buttons and the palette input sit on it. |
| `--bg-raised` | `#161920` | Cards, panes, banners, the notice, the palette, the context menu. |
| `--bg-hover` | `#1d2129` | A hovered or selected row (palette, context menu). |

### Text

| Token | Value | Use |
|---|---|---|
| `--fg` | `#d7dae0` | Body text, facts, the duplicate-add flash. |
| `--fg-muted` | `#8b919c` | Secondary text: paths, headings, keys, not-applicable states, the notice, row indicators. |
| `--fg-faint` | `#3d424b` | The canvas dot grid and disabled text. |

### Lines, accent, focus

| Token | Value | Use |
|---|---|---|
| `--border` | `#262a33` | Every border and separator. |
| `--border-strong` | `var(--fg-muted)` | The active terminal tab's underline (Story 4.5); stored edges and the edge handle (Story 6.1). |
| `--accent` | `#e8a33d` | Attention only (see [The accent](#the-accent)). |
| `--focus` | `var(--fg)` | Focus rings, the node selection outline and the selected edge. |
| `--selection` | `var(--fg-muted)` | Text selection background (text in `--bg`). |
| `--line` | `1px` | The width of every border, outline and separator. |

### Type scale

Every `font-size` is one of these; nothing else.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 11px | Paths, badges, card details, meta columns, the canvas attribution. |
| `--text-sm` | 12px | The card's status line, pane section headings, palette key hints. |
| `--text-md` | 13px | Card text, buttons, banners and the notice, pane body text, menu items, the empty-canvas hint. |
| `--text-base` | 14px | Body (`body`), palette rows. |
| `--text-lg` | 16px | Pane titles. |

Two families: `--font-sans` (the system UI stack) for prose and labels, `--font-mono` for paths, git
lines, banners, badges and keys. Weights are 400 and 500 only.

### Radii

| Token | Size | Use |
|---|---|---|
| `--radius-sm` | 3px | Badges, keys, buttons, the import list. |
| `--radius-md` | 4px | Cards, panes, the palette, the context menu. |

A `border-radius` is one of these, `0`, or `50%` (the round banner mark). Spacing is not tokenised: it
stays literal `rem` values.

### Terminal palette

The 16 ANSI colours a terminal draws with (Story 4.1), as `--ansi-0` … `--ansi-15`; xterm's theme is read
from these and the tokens above at runtime (`src/terminal/theme.ts`). They are terminal content (see
[The accent](#the-accent)); nothing in the chrome uses them.

| Token | Value | ANSI | Token | Value | ANSI |
|---|---|---|---|---|---|
| `--ansi-0` | `#1d2129` | black | `--ansi-8` | `#5c6370` | bright black |
| `--ansi-1` | `#e06c75` | red | `--ansi-9` | `#ef8189` | bright red |
| `--ansi-2` | `#98c379` | green | `--ansi-10` | `#b5e08f` | bright green |
| `--ansi-3` | `#e5c07b` | yellow | `--ansi-11` | `#f0d197` | bright yellow |
| `--ansi-4` | `#61afef` | blue | `--ansi-12` | `#7cc0f5` | bright blue |
| `--ansi-5` | `#c678dd` | magenta | `--ansi-13` | `#d79ae8` | bright magenta |
| `--ansi-6` | `#56b6c2` | cyan | `--ansi-14` | `#79cbd5` | bright cyan |
| `--ansi-7` | `#d7dae0` | white | `--ansi-15` | `#ffffff` | bright white |

The rest of the terminal's theme is the app's: background `--bg-raised` (the pane's surface), text and
cursor `--fg`, the text under the cursor `--bg-raised`, selection `--selection` with `--bg` text; the font is
`--font-mono` at `--text-md`.

### Diff colours

The Review pane's diff (Story 8.1): inserted and deleted lines, and the words that changed within them. The
terminal's green and red at low opacity, on `--bg-raised`. They are diff content, like terminal content (see
[The accent](#the-accent)): nothing in the chrome uses them, and the diff never uses the accent.

| Token | Value | Use |
|---|---|---|
| `--diff-add-bg` | `#98c3791a` | An inserted (or changed, new side) line. |
| `--diff-del-bg` | `#e06c751a` | A deleted (or changed, old side) line; a deleted block in the unified view. |
| `--diff-add-word` | `#98c37947` | The changed words within an inserted line; the new side's change gutter. |
| `--diff-del-word` | `#e06c7547` | The changed words within a deleted line; the old side's change gutter. |

The diff's syntax highlighting uses the terminal palette (`--ansi-*`: keywords magenta, strings green, numbers
yellow, comments bright black, types cyan, functions blue), set on the CodeMirror view in
`src/review/DiffView.tsx`. A collapsed stretch of unchanged lines is a `--bg-hover` row in mono `--text-xs`
`--fg-muted`; the gutters are `--bg-raised` with `--fg-faint` line numbers and a 1-px `--border` line.

## Rules

1. **Lines are 1 px** (`--line`) in `--border`. The only 2-px lines are the left indicators: the banner
   (accent), the notice and the selected palette or menu row (`--fg-muted`). Stored edges are 1-px lines in
   `--border-strong`; a cooperate edge's double line is two 1-px lines (see [Edges](#edges)).
2. **No depth effects.** No `box-shadow`, `text-shadow`, `drop-shadow()` or gradient anywhere. Layers are
   told apart by surface (`--bg` / `--bg-raised` / `--bg-hover`) and a border.
3. **Colours come from tokens.** No hex, `rgb()`, `hsl()` or named colour outside `tokens.css`
   (`transparent` and `currentColor` are fine; `color-mix()` of tokens is fine).
4. **One accent, reserved for attention** (below). Focus, selection, hover and the active palette or menu
   row never use it.
5. **Monochrome icons.** In-app glyphs are text (`▸ ▾ · ↑ ↓`) drawn in `currentColor`; there is no icon
   set. The app icon is monochrome too (see [Icons](#icons)).
6. **Little motion** (below), all of it honouring `prefers-reduced-motion`.

### The accent

The accent appears only on attention states. The allow-list, as the lint holds it: a declaration using
`var(--accent)` is allowed only when the last compound of every selector of its rule (the element
styled, after the final combinator) starts with one of

```
.banner  .banner-mark  .attention  .pane-error
.session-attention  .session-attention-word  .project-glow
.approval-toast
```

That is: a banner's left border and mark, error text in a pane (`.pane-error`), attention text
(`.attention`; also the line of a context edge whose live application failed, Story 6.3, or of a cooperate
edge with a failed side, Story 6.4), the attention states of Story 3.3: a session card in `finished` / `waiting` (its border,
`.session-attention`, and its state word, `.session-attention-word`) and the glow of its project card
(`.project-glow`), and (Story 7.2) the border of an agent approval toast (`.approval-toast`): a request waits on
the operator; a review toast (Story 7.4) is an `.approval-toast` too: a session asks the operator to look. The
review flag on a card never uses it. Inline styles never use the accent.

**Terminal content is not chrome.** What a program prints in a terminal is drawn in its own colours (the
ANSI palette below, 256-colour and truecolour escapes included), which may well be orange; the accent rule
governs the app's chrome around it, never the terminal's content. The terminal pane's own chrome (header,
drag handle) follows every rule here. **Diff content** (Story 8.1) is the same: the Review pane's inserted and
deleted lines and words use the diff tokens and its syntax the ANSI palette, never the accent; the pane's own
chrome follows every rule here.

### States

| State | Look |
|---|---|
| Hover (row) | `--bg-hover` background. |
| Hover (button) | Border in `--fg-muted`. |
| Selected row (palette, menu) | `--bg-hover` background and a 2-px `--fg-muted` left border (transparent when not selected, so the text never shifts). |
| Keyboard focus | A 1-px `--focus` outline, offset 1 px. The palette input shows none: it always has focus while the palette is open, and the dialog's border is the cue. |
| Selected node | A 1-px `--focus` outline, offset 2 px, and the node draws above its siblings. |
| Selected edge | Its line (both lines of a cooperate edge) and its label in `--focus`. No accent. |
| Attention (session card) | A `finished` or `waiting` session: 1-px `--accent` border, the state word in `--accent` after its 4-px dot (`currentColor`) pulsing like `busy`'s. |
| Glow (project card) | Any of its sessions (drawn or hidden, collapsed or not) is `finished` / `waiting`: a 1-px `--accent` outline at 2-px offset whose opacity pulses 1 → 0.4. No shadow, gradient or filter. Selected and glowing, the `--focus` outline stays at 2 px and the glow moves out to 4 px around it. |
| Text selection | `--selection` background, `--bg` text. |
| Disabled | `--fg-faint` text. |

## Layout pieces

- **Banners** are a strip across the top in `--bg-raised` with a `--border` bottom line: per banner a 2-px
  accent left border, a round accent mark and mono `--text-md` text that wraps (long text such as a PATH
  list wraps anywhere). The strip stops at 30vh and scrolls beyond that.
- **The notice** (a stub saying what it will do, an action saying why it could not run) is not a banner:
  one muted row (`--fg-muted` text and mark, 2-px `--fg-muted` left border, `--bg-raised`; long text is
  cut with an ellipsis, never a second line) laid over the top edge of the canvas, out of the strip's
  flow, so its arrival and its 3-s exit never move or resize the canvas. It lets clicks through and sits below panes, the palette and the menu.
- **Panes** come in on the right over the canvas: `--bg-raised`, a 1-px left border, title in
  `--text-lg` / 500, section headings in `--text-sm` upper case `--fg-muted`.
- **Settings → Diagnostics** (Stories 4.3, 7.1) is label / value rows (label `--fg-muted`, value mono). Below
  them, when an `/mcp` request has been refused, a caption **Recent MCP refusals** (the section-heading style:
  `--text-sm` upper case `--fg-muted`) heads a plain list of the last 20, newest first. Each is one mono
  `--text-sm` `--fg-muted` line, `HH:MM:SS /mcp — <reason>`, that wraps anywhere. There are no colours, icons or
  buttons, and a token is never shown. Last (Story 9.4), the caption **Keybindings** over one label / value row,
  `keybindings.json` and its status (`none`, `ok` or `n errors`, then `, n conflicts` when there are any; the
  value in `.attention`, like an endpoint error, while there are errors or conflicts), then, when there are any,
  the errors, the warnings (an unbound palette key or key-only command, `live reload unavailable: …`) and the
  conflicts (`ctrl+k: palette.toggle, review.refresh`) as a plain list in the refusals' look.
- **The terminal pane** is a pane, wider (the first wide pane; the Review pane is the second): `min(720px, 70vw)` by default, dragged between 360 px and 90vw by
  its left edge (a 6-px handle over the 1-px border, `--border` while hovered, `col-resize` cursor). A header
  row over a 1-px `--border` line holds the project label (`--text-md` / 500), its folder (mono `--text-xs`
  `--fg-muted`, ellipsis), the state (mono `--text-xs` `--fg-muted`: `running`, `stopping`, `exited N`; `could not start
  …` is `.pane-error`) and the buttons. Below it the terminal fills the rest on `--bg-raised` with no chrome
  inside it. It appears without animation, like every pane.
- **Terminal tabs and pop-outs** (Story 4.5). The terminal pane has a tab strip above its header: one tab
  per terminal opened or shown in it, over a 1-px `--border` line, scrolling sideways when the tabs overflow.
  Each tab is a plain `<button>` (the active one `aria-current`) followed by its own labelled × button; no
  tablist roles. Tabs do not look like buttons: no border, no surface, the plain text style (`--text-md`, `--fg-muted`; `--fg` when
  active or hovered), the active tab underlined by a 1-px `--border-strong` line. A tab holds the title
  (ellipsis), the state word (mono `--text-xs` `--fg-muted`), the Story 3.3 attention dot before it for a
  `waiting` / `finished` session (4 px, round, `--accent` through `.session-attention`; static, no pulse) and
  `↗` in `--fg-muted` while the terminal is popped out, then its × in the same muted text. Keyboard focus is
  the usual 1-px `--focus` outline. A popped-out tab's body is a placeholder: "In its own window" in
  `--text-md` `--fg-muted`, centred, with **Focus window** and **Return to pane** as ordinary buttons; its header
  keeps the title, state and Hide only. A pop-out window (900 × 600, at least 480 × 320) is the terminal alone
  on `--bg-raised` (its native background is the same colour, kept equal to the token by a Rust test): the
  pane's header row (with **Return to pane**) and the terminal filling the rest, no tab strip; the notice shows
  over its top edge as in the main window. Alt+F4 inside a terminal closes the window, in both kinds of window. No new motion: tabs switch and windows appear without animation.
- **The launch sheet** (`n` on a project, Story 4.2) is a pane like settings and import, at their width: the
  title `New session`, then labelled fields stacked in a column (label in `--text-sm` `--fg-muted`; inputs,
  selects and the prompt textarea on `--bg` with a 1-px `--border`, `--radius-sm`, `--text-md`, a `--fg-muted`
  border on hover and the 1-px `--focus` outline on keyboard focus; the prompt in `--font-mono`). The add-dirs
  are a bordered list, one row per folder (mono `--text-xs` path with ellipsis and a Remove button), split by
  1-px `--border` lines; a missing folder's row adds `.pane-error` text. A row a context edge prefilled
  (Story 6.2) adds `via edge → <target>` after the path (`--text-xs` `--fg-muted`; a long target is cut with an
  ellipsis before the Remove button would be pushed out, the full text on hover). Under the list, context
  edges that gave no folder are one muted line, `not added: ui:feat (no worktree), docs (folder missing)`
  (`--text-xs` `--fg-muted`, wrapping anywhere); it never blocks Start. A field hint (blank name) is
  `--text-xs` `--fg-muted`, as is the reason beside a disabled Start; a refused start is `.pane-error` text under Start (`role="alert"`, like a row's error). No new motion.
  On a branch card (Story 5.3) the same sheet: its muted subtitle reads `Starts claude on <branch> in
  <folder>` (the folder mono, middle-elided, full path on hover). A branch without a worktree adds a
  **Worktree** group under the subtitle, above the fields: the `Worktree` section heading, a muted line
  `Creates a worktree for <branch>` and the worktree sheet's command preview block; a refused plan is
  `.pane-error` text under it. The project's sheet of a git project adds, after the fields, the checkbox **Let
  Claude make a worktree (`--worktree`)** in the background checkbox's look and, while it is on, a **Worktree
  name** field (mono, like the worktree sheet's name) whose `--text-xs` `--fg-muted` hint states the branch and
  folder Claude creates (or why the name is refused). Tokens only; no accent beyond `.pane-error`.
- **The worktree sheet** ("New worktree…" on a git project or a branch card, Story 5.2) is a pane at the launch
  sheet's width with its field look (label, inputs and selects; the name in `--font-mono`): the title `New
  worktree`, a muted line, then the mode toggle: two ordinary buttons, **New branch** and **Existing branch**,
  side by side, the pressed one (`aria-pressed`) in `--fg` text with an `--fg` border, like the branches chip
  when on. Then the fields of the mode (name and base, or the branch). Under a `Runs` section heading, the
  **command preview**: a read-only block on `--bg` with a 1-px `--border` and `--radius-sm`, mono `--text-xs`
  `--fg-muted`, wrapping anywhere, `—` while there is nothing to run. Then **Create**, the reason beside it
  while disabled (`--text-xs` `--fg-muted`), and a refusal or git's error under it as `.pane-error` text
  (`role="alert"`). Tokens only; the accent appears only through `.pane-error`. No new motion.
- **The remove-worktree sheet** ("Remove worktree…" on a branch card with a worktree chip, Story 5.4) is the
  app's first confirmation, a pane at the worktree sheet's width: the title `Remove worktree`, the branch
  (`--text-md` / 500) and the worktree's full path under it (mono `--text-xs` `--fg-muted`, wrapping anywhere,
  selectable). Then what the checks found, one line each: `N changed files (modified or untracked)` in `--fg`
  for a dirty worktree, `No changed files.` or the missing-folder line in `--fg-muted`; a refusal (`locked`, a
  session running in it, or an app terminal that was started in it) is `.pane-error` text and the sheet
  offers no button. Then the checkbox **Also delete
  branch `<name>`** (off; the launch sheet's checkbox look, the name mono) with the muted `--text-xs` line `The
  branch is kept.` while it is off, the `Runs` heading and the worktree sheet's command preview block (one
  command per line, both when the box is ticked). Then one ordinary button: **Remove**; on a dirty worktree
  **Force remove…**, which, pressed, turns disabled and reveals a second ordinary button in its own row below
  it that states the loss, `Discard N changed files and remove`, disabled for its first 0.6 s and never
  focused on appearing, so a double-click cannot confirm. No colour marks the destructive step: the words do,
  and focus starts on **Close**, never on a button that removes (Enter on those is swallowed). git's error, or a refused branch delete under the
  muted `Worktree removed; the branch was kept.`, is `.pane-error` text (`role="alert"`). Tokens only; the
  accent appears only through `.pane-error`. No new motion.
- **The palette** is centred near the top over a dimmed page (`--bg` at 55%): `--bg-raised`, 1-px border,
  `--radius-md`; rows in `--text-base`, key hints in `--text-sm` `--fg-muted`. As the "Link to…" pick list
  (Story 6.1) it is the same dialog with the placeholder `Link to…` and one row per target, no key hints.
- **The edge inspector** (Story 6.1) is a pane, narrower than the others: `min(320px, 90vw)`. It shows the title
  `Edge`, then the facts as a two-column list: the term in `--fg-muted`, the value in `--fg`, `--text-md`, and
  each value on one line with an ellipsis. The facts are `Kind` and the two ends: `From` and `To`, or
  `Between` and `And` for a cooperate edge. Each end is its label and `(project)`. Below the facts sit the
  launch sheet's **Label** field and an ordinary **Delete** button. No colour marks the delete: an edge is
  cheap to redraw. It never takes the focus on opening. Tokens only, no accent, no new motion.
  Story 6.3 adds, under the facts, the **Now:** line (`Now:` in `--fg-muted`, then the state and its detail in
  `--fg`, `--text-md`, wrapping anywhere; `aria-live` polite): `pending (waiting for idle)`, `applied`,
  `failed (not confirmed)`, or, with no live state, what the edge does at the next launch or resume. A
  context edge from a session adds ordinary buttons before Delete: **Retry** (only when it failed or a draft
  holds it back) and **Restart with flags** (always; disabled while it runs). A failure is said in words,
  never in the accent.
  Story 6.4: a cooperate edge has one **Now:** line per side, the same look: `<name>: pending (waiting for
  idle)`, `<name>: pending (you're typing — Retry when done)`, `<name>: pending (sent, waiting for the session
  to take it)`, `<name>: notified` (the session went busy within 3 s of the line, which another cause could
  also make happen), `<name>: failed (not confirmed)`, `<name>: failed (session stayed busy)`, `<name>: failed
  (<error>)`, or `<name>: peer named at the next resume` with no live state. An ordinary **Retry** button sits
  under a side that failed or that a draft holds back. No Restart with flags for a cooperate edge.
  Story 7.2: an edge whose "Always for this edge" is set adds, after the Now lines and before Label, the line
  `Agent actions: always allowed` (the **Now:** line's look: the term in `--fg-muted`, the value in `--fg`) with
  an ordinary **Revoke** button beside it. Revoked, the line goes.
- **Agent approval toasts** (Story 7.2) stack at the canvas's bottom-right, oldest first, over the canvas and
  any pane and below the palette and the menu: a column `min(28rem, 100% - 1.5rem)` wide, 0.5 rem apart,
  scrolling past the canvas's height. Each toast is `--bg-raised` with a 1-px `--accent` border
  (`.approval-toast`, attention: it waits on the operator) and `--radius-md`. Top to bottom: `<caller> wants to
  <action>` in `--text-md` (the caller's name 500), wrapping anywhere; the argv or the edge in the command
  preview look (a block on `--bg` with a 1-px `--border`, `--radius-sm`, mono `--text-xs` `--fg-muted`,
  wrapping anywhere, at most 8 rem tall then scrolling, selectable); then ordinary buttons **Allow**, **Deny**
  and, when offered, **Always for this edge**, and at the right the muted mono `--text-xs` countdown `denied in
  N s`. The buttons turn disabled while an answer is on its way. It never takes the focus; the palette answers
  the oldest. No colour marks Deny or Always: the words do. It appears and goes without animation. This is the
  one exception to "status stays ambient": an attention surface with inline buttons.
- **Review toasts** (Story 7.4) join the same stack, after the approval toasts, in their look (`.approval-toast`,
  the accent border: a session asks the operator to look): one per flagged session, `<name> asks for review:
  <summary>` in `--text-md` (the name 500), wrapping anywhere, then the ordinary buttons **Open** and **Dismiss**.
  No command block and no countdown: it does not wait or expire. Dismiss closes it and keeps the flag; a new
  request from the session shows it again. It never takes the focus and appears and goes without animation.
- **The Review pane** (Story 8.1, replacing Story 7.4's list) is the **second wide pane**, after the terminal
  pane and on its model: `min(1100px, 85vw)` by default, dragged between 360 px and 90vw by its left edge (the
  terminal pane's handle), the canvas visible beside it. Top to bottom, each row over a 1-px `--border` line:
  - a **header row**: the title (the project's label, `<project>:<branch>`, or the session's name; `--text-lg` /
    500, one line, ellipsis), the reviewed folder (mono `--text-xs` `--fg-muted`, ellipsis, full path on hover),
    and the ordinary buttons **Refresh** and **Close**;
  - opened from a review request (Story 7.4), the request: a `Summary` section heading over the summary
    (`--text-md`, wrapping anywhere, selectable) and `Requested <time>` (`--text-xs` `--fg-muted`; the local
    time today, else the date and time), at most 30% of the pane's height, then scrolling;
  - a **toolbar**: the filter toggle (**All**, **Staged**, **Unstaged**) and, at the right, the layout toggle
    (**Side by side**, **Unified**): ordinary buttons in `--fg-muted`, the pressed one (`aria-pressed`) in
    `--fg` text with an `--fg` border, like the worktree sheet's mode toggle; between them the totals, `N files
    +A −R` (mono `--text-xs` `--fg-muted`). Story 8.2: on a project or a branch the toolbar starts with the mode
    toggle (**Changes**, **vs base**, **Commits**) in the same look; the filter shows in Changes only, and vs base
    and Commits put the base dropdown in its place: a muted `base` label (`--text-xs` `--fg-muted`) before the
    launch sheet's select in mono `--text-xs`, the default branch first and marked `(default)`. In Commits the
    totals read `N commits`; Story 8.3 adds **Files** as the toggle's last position (wherever the pane has a folder;
    a session's toggle is **Changes** and **Files**), and in Files the toolbar holds the mode toggle only: no filter,
    base, totals or layout toggle;
  - the **body**: the changed-files tree (`min(300px, 35%)` wide, a 1-px `--border` line at its right,
    scrolling) beside the diff. A folder row is mono `--text-xs` `--fg-muted` (`src/auth/`; a chain of single
    folders on one row), its files indented under it. A file row is the palette's row look in mono `--text-xs`:
    `--bg-hover` on hover, and when selected `--bg-hover` with a 2-px `--fg-muted` left border (transparent
    otherwise, so the text never shifts); the 1-px `--focus` outline on keyboard focus. It holds a one-letter mark
    (`M A D R U C`, `--fg-muted`, the word on hover), the name (ellipsis; a rename adds `renamed from <old>` in
    `--fg-muted`) and at the right the counts `+N −M` (or `binary file`) in `--fg-muted`. A request's paths come
    first under a `Requested` section heading, then `Other changes`; a requested path naming no changed file
    shows `unchanged` or `missing` in the counts' place. `No changes` and `Reading changes…` are muted lines; a
    refusal (`no worktree`, `not a git repository`) is `.pane-error` text.
  - Story 8.2, **Commits**: the tree column lists the commits, newest first, as file rows: the short hash where the
    mark sits (`--fg-muted`), the subject (ellipsis) and at the right `<author> · <age>` (`--fg-muted`; the age as a
    session card's); `N older commits not shown` and `No commits on <branch> beyond <base>` are muted lines. With a
    commit selected the column starts with an ordinary **← Commits** button and the commit's short hash and subject
    (mono `--text-xs`, one line, ellipsis) over a 1-px `--border` line, then its files as above; with none,
    the diff side reads `No commit selected.` (muted).
  - Story 8.3, **Files**: the tree column is the folder's tree in the file rows' look (mono `--text-xs`, the palette's
    row look on hover and when selected), one row per entry, indented `0.85rem` per level. A folder row is a button
    whose mark is `▸` closed or `▾` open (`--fg-muted`, `aria-expanded`) and whose name ends in `/`; a link adds `link`
    at the right in `--fg-muted`. A **gitignored** entry is dimmed: its whole row in `--fg-muted` (never the accent; the
    word `ignored` is in its tooltip and accessible name). An entry whose name cannot be opened (not UTF-8, control characters, a Windows device name) is a disabled row in
    `--fg-faint`. Under a folder, `Reading…` and `N more not shown` are muted mono `--text-xs` lines and a read error
    is `.pane-error` text. The right side is the **viewer**: one read-only CodeMirror view of the file, the diff's
    look exactly (its theme, gutters and syntax colours, no change colours); `No file selected.`, `Reading <path>…`,
    `binary file`, `too large to show`, `submodule` and `unreadable name` are muted lines in its place, and `not UTF-8 (shown lossily)` the muted line
    over it.
  - The **diff** fills the rest: CodeMirror's merge view with no chrome of its own beyond its gutters (see
    [Diff colours](#diff-colours)), in `--font-mono` `--text-md`. `binary file`, `too large to show (+N −M)`,
    `No file selected.` and `Reading <path>…` are muted lines in its place; a file that is not UTF-8 adds a muted
    mono `--text-xs` line `not UTF-8 (shown lossily)` over the diff.
  - Story 8.4, **touched mark**: on a session, a Changes or Files file row the session edited carries a plain `•` in
    `--fg-muted` before the counts (its tooltip `edited by this session`, also in the row's accessible name). Never the
    accent: it is information.
  - Story 8.4, **comments**: the toolbar holds an ordinary **Comment** button before the layout toggle (disabled,
    `--fg-faint`, on a project or a branch, titled `comments go to a session`, or with no file shown). The **comment
    box** is a row under the toolbar over a 1-px `--border` line: `Comment on <file>:<line>` (mono `--text-xs`
    `--fg-muted`, ellipsis), a one-line textarea in the launch sheet's input look in mono (no resize), and the muted
    `--text-xs` hint `ctrl+Enter sends · Esc cancels`; a refusal is `.pane-error` text under it. Below it (or the
    toolbar), the **comment list**: one mono `--text-xs` row per comment of this run, `<file>:<line>`
    (`--fg-muted`), the comment (ellipsis, full line on hover) and the state word at the right (`queued`, `sent`,
    `read`, `dropped`, `--fg-muted`; a drop is said in words, never the accent), at most 20% of the pane's height, then scrolling, over a 1-px `--border` line. No accent,
    no new motion.

  Tokens only; the accent appears only through `.pane-error`. It never takes the focus on opening and appears
  without animation, like every pane.
- **The Help pane** (Story 10.1; F1, or **Help** in the palette) is a pane at the settings pane's width. Its header
  row holds the title `Help`, an ordinary **← Contents** button while a page shows, and **Close**. It opens on
  the page for where the operator is (Story 10.2: the open pane's page, else the selection's, else the page last
  read this run, else Contents), and closing it brings back the pane it opened over, as it was left: the edge inspector
  only while an edge is selected, the terminal pane only while it has a tab, a sheet or Review only while it still
  has its form or target (else Help closes to the canvas). Opening another pane from Help drops the remembered one.
  **Contents** is the `Contents` section heading over a bordered list of the guide pages in order (one row per page,
  the import list's look: `--text-md`, rows split by 1-px `--border` lines, `--bg-hover` on hover, the 1-px
  `--focus` outline on keyboard focus); after the guide pages come Getting started (Story 10.3), then Changelog
  and Roadmap (Story 10.4). Under the list, the Contents footer (Story 10.4): `Switchboard <version>` (`--text-sm`
  `--fg-muted`; the version from `app_info`, just `Switchboard` until it answers or when it fails, never an error)
  and under it the config folder (mono `--text-xs` `--fg-muted`, wrapping anywhere, selectable; left out with no
  settings path). A page is prose in `--font-sans` `--text-md` (line height 1.5): its `#`
  heading in `--text-lg`, `##` in `--text-base`, deeper ones in `--text-md`, all 500; lists indented; inline code
  and keys in mono `--text-sm`; a code block in the command preview look (`--bg`, 1-px `--border`,
  `--radius-sm`, mono `--text-xs` `--fg-muted`, wrapping). A link is its text underlined in `--fg` (`--fg-muted` on
  hover), never the accent: a page link shows that page (at its heading), a web link opens in the system browser
  on a click (its URL on hover). Raw HTML and images show as their literal text. The Keyboard page ends with two
  tables, `Commands` and `Key-only commands` (captions in the section-heading style): the title in `--fg`, the
  effective key in mono `--text-sm` `--fg-muted` or `—`, rows split by 1-px `--border` lines. Tokens only, no
  accent; it appears without animation and a heading link scrolls without motion.
- **Settings → Agent actions** (Story 7.2) is one muted line under the section heading: `Ask: …` or, while the
  workspace allows all, `Allow all: …`, each naming the palette command that switches it.
- **The context menu** is the palette's row look at the pointer: `--bg-raised`, 1-px border,
  `--radius-md`, items in `--text-md`, groups split by a 1-px `--border` line. Project, session and branch cards
  have one; it lists only enabled entries and does not open when there are none. Story 11.1: each row ends
  with its effective key in the palette's key look (mono `--text-sm` `--fg-muted`, `formatKeybinding`), nothing
  when it has none; a rebind in `keybindings.json` shows there the next time it opens. The `⋯` button of a node
  toolbar (Story 11.2) opens the same menu under itself.
- **The canvas menu** (Story 11.1) is the context menu opened by a right-click on the canvas background that did
  not move (the node menu's rule): the commands tagged for it (add a project folder, import from Claude, fit
  view, help, settings) in the same look, with their keys. A right-drag still pans.
- **Tooltips** (Story 11.1) are the native `title`: for every button that runs a command, the command's title,
  then ` · ` and its effective key when it has one (`Close · esc`, `New session… · n`), made by one helper from
  the registry, so they follow `keybindings.json` once the button is drawn again (a menu reads the keys each time
  it opens); a button may name its command in its own words and still end with the key (`Comment on the current
  line · c`). Item-level buttons (a toast's Allow, a tab's ×) and the Edge pane's Revoke, Retry and Restart with
  flags, whose tooltips say what they do there, keep their own words. No custom tooltip surface: nothing to
  style, nothing to animate.
- **The Elsewhere tray** (live sessions in folders not on the canvas) sits at the canvas's bottom-left, over
  it and below the notice, panes, palette and menu. A chip `elsewhere N` (mono `--text-xs`, `--fg-muted`,
  `--bg-raised`, 1-px `--border`, `--radius-sm`; `--fg` text and a `--fg-muted` border on hover or while
  open) shows only when N > 0. Open, a list above it: a `--bg-raised` box with a 1-px `--border` and
  `--radius-md`, rows split by a 1-px `--border` line, each with the state word (mono `--text-xs`, `busy` in
  `--fg`, the rest `--fg-muted`; no pulse), the name (`--text-md`, ellipsis), the shortened cwd (mono
  `--text-xs` `--fg-muted`, full path on hover) and an **Add folder** button. No accent.
- **The what's-new chip** (Story 10.5) shares the Elsewhere tray's bottom-left row, after the `elsewhere N` chip
  (alone, it takes the corner itself): a button `new in <version>` with the same chip look (mono `--text-xs`,
  `--fg-muted`, `--bg-raised`, 1-px `--border`, `--radius-sm`; `--fg` text and a `--fg-muted` border on hover, the
  1-px `--focus` outline). It shows after the running version changes, until the Changelog is opened, and never
  on a fresh profile. Clicking it runs **What's new** (Help → Changelog). No accent, no banner, no OS
  notification, no motion.
- **The Getting started card** (Story 10.3) sits at the canvas's top-right under the banner strip, offset below the
  notice line: over the canvas (the Elsewhere tray's layer) and below the notice, panes, toasts, the palette and the
  menu. It is information, not a wizard: no overlay, modal or motion. A compact `--bg-raised` box with a 1-px
  `--border` and `--radius-md`: the title `Getting started` (`--text-md` / 500) and a small **Dismiss** button on one
  row, then the six steps, one row each (`--text-md`): a step whose command is enabled now is its title as a button
  (underlined text in the row's colour, `--fg-muted` on hover, the 1-px `--focus` outline), otherwise plain text;
  its keys follow at the right in mono `--text-xs` `--fg-muted`. A ticked step's row is `--fg-muted` and starts with
  a `✓` in `currentColor`. After the sixth step the rows give way to a muted `All done`. It shows on a fresh profile
  only; the Help pane's Getting started page (after the guide pages in Contents) ends with the same rows under
  a `Your progress` section heading and an ordinary **Show on canvas** button. Tokens only, no accent.
- **The canvas** is `--bg` with a dot grid in `--fg-faint`; empty, it shows the ghost card (Story 11.3). Nothing on the canvas uses the accent except the attention states (a `finished` / `waiting` session card and its project's glow; see [States](#states)).
- **The node toolbar** (Story 11.2) is a row to the right of a project, session or branch card, outside the
  card's fixed box (so `nodes.ts` geometry and the arrow keys are untouched), top-aligned with the card's top
  edge and clear of its link handle: under the card it would cover the next card of the column (8 px apart). A
  transparent bridge between card and row keeps the hover while the pointer crosses it; the link handle stays
  visible, on top and draggable. It shows only while the card is hovered or selected (not while it is dragged)
  and is absent from the DOM otherwise; a card showing it draws above its neighbours. It is `--bg-raised` with a
  1-px `--border` and `--radius-sm`, holding at most four short mono `--text-xs` text buttons (`new`, `term`,
  `link`, `review`; `--fg-muted`, `--fg` on hover, no border of their own, never focusable: not in the Tab order)
  and last `⋯`, which opens the node's context menu under itself (`Menu · right-click`). Each button's tooltip is
  its command's title and key, and its accessible name the title. The buttons are the enabled commands of that
  card tagged for the toolbar, one per slot in a fixed order; a disabled one is left out, never greyed, and Stop
  is never one of them. They never depend on the open pane: a click selects the card, closes the open pane when
  that pane is what disables the command (Review with the terminal pane open), then runs it. It appears and goes
  without animation. No accent; it is never the place a state is shown.
- **The ghost card** (Story 11.3) is the empty canvas's state: a box of the project card's size (240 × 80) and
  `--radius-md` at the canvas element's centre with a dashed 1-px `--fg-faint` border and no surface, `Drop a
  folder here` in `--text-md` `--fg-muted`, and under the box (too wide for it), in mono `--text-md`
  `--fg-muted`, `ctrl+o pick a folder · ctrl+k palette · f1 help`, the keys read from the registry so a rebind
  shows. On hover the box's words turn `--fg`; the card is never focused (out of the Tab order, a click does not
  focus it) and is named "Add project folder". A click on it runs **Add project folder…** (its tooltip that
  command's title and key); adding a project (picked, dropped or imported, one new folder) selects its card,
  so its hint's `n` works at once; a duplicate or several folders leave the selection as it is. The canvas
  around it still pans and takes drops, and a right-click on it opens the canvas menu. It goes with the first
  project and comes back with the last one removed, without animation.
- **Inline hints** (Story 11.3) are one-line mono `--text-xs` `--fg-muted` captions placed by the thing they
  name, outside the card's box and clear of the node toolbar (to the card's right, top-aligned): under the
  first project card, in the 12 px above its column (`n new session · hover for more`); right of its handle at
  the handle's height, below the toolbar row (`drag to link · e`, while the handle shows, in place of the
  first); right of the first live session card that is drawn (its project expanded, not cut by `show all`),
  vertically centred, since the 8-px child gap has no room
  (`r review changes`; not while that card's toolbar shows, which offers `review` itself). The keys are read
  from the registry. At most one per card and three on the canvas; never a box, a border, a surface or the
  accent; they let clicks through. They show while the Getting started card shows, or always after **Show
  canvas hints** (`state.json`'s `hints.hidden: false`) and never after **Hide canvas hints** (`true`). A hint
  fades out over 300 ms (instant under reduced motion) once its step is done, hints are hidden, a pane opens
  or its card is no longer first, and never comes back for a done step; it goes at once when the toolbar
  shows or the handle hides, and the project and handle hints swap at once. None is drawn while any pane is
  open. Captions are hidden from screen readers. The hints commands are offered only while a hinted step
  (session, edge, review) is undone.
- **Help figures** (Story 11.4) are diagrams inside a help page, as wide as the page's text and at most 160 px
  tall, drawn with the app's own card, handle, edge, state, pane and palette classes on the pane's surface
  (`--bg-raised`) inside a 1-px `--border` box with `--radius-sm`; each stage is drawn at a fixed scale
  (`transform: scale(…)` where the cards would not fit, never resized boxes) sized for the pane at its
  usual width, and clips on a narrower pane. A page names one as a fenced block with the info string
  `figure <name>`, its text the alt text; an unknown name shows that text as a code block. Five ship:
  `draw-edge` and `edge-kinds` (Edges), `node-anatomy` (Projects), `session-states` (Sessions) and `panes`
  (Canvas); `edge-kinds` and `node-anatomy` are still. The others move by CSS alone: opacity, transform and
  `stroke-dashoffset`, looping every 4–8 s with a pause at the end of each loop; under
  `prefers-reduced-motion: reduce` the end frame is shown still. A figure has `role="img"` and its alt text (the
  fenced block's text) as its accessible name; a caption, when wanted, is the Markdown paragraph after it.
  Labels inside a figure are mono `--text-xs` `--fg-muted`. The attention states appear only through the
  allow-listed classes (`.session-attention`, `.session-attention-word`, `.project-glow`, `.attention`), as on
  the canvas.
- **The What you see page** (Story 11.5) is a guide page after Canvas in Contents: the state words, the
  attention colour, the glow and the badges, then the edge looks, each a row of the term (the state word in its
  own look: the busy dot, the accent on `waiting` / `finished`) and its meaning in `--fg`, with the session-states
  and edge-kinds figures above their rows. Keys in the rows are mono `--text-sm` like every page.
- **The tour** (Story 11.6) is the one dimmed, guided surface. A layer at the palette backdrop's colour
  (`--bg` at 55%) over the shell, panes and toasts, under the palette and the menu, made of four rectangles
  around the stop's target so the target shows through a **cut-out** with a 1-px `--focus` outline at 2-px
  offset (the selected node's outline); a stop without a target dims everything and shows a figure instead.
  Beside the cut-out (or centred), the **tour card**: `--bg-raised`, 1-px `--border`, `--radius-md`,
  `min(360px, 90vw)` wide; the stop's title (`--text-md` / 500) and one or two sentences (`--text-md`, line
  height 1.5), a figure when the stop has one, then a row with `2 / 6` in mono `--text-xs` `--fg-muted` at the
  left and the ordinary buttons **Back**, **Next** (**Finish** on the last stop) and **Skip** at the right.
  Keys are named inline as `kbd`. The cut-out moves to the next target over 150 ms (the reveal pan's duration;
  instant under reduced motion); the card appears without animation. No accent, no shadow, no gradient: the
  layers are told apart by surface, as everywhere. The layer takes pointer events (the tour is read-only);
  `esc` skips, `ctrl+k` still opens the palette over it.

## Node anatomy

### Project card (240 × 80)

`--bg-raised`, 1-px `--border`, `--radius-md`, `--text-md`, top to bottom:

1. **Head row:** the **chevron** (`▸` collapsed / `▾` expanded, `--fg-muted`, `--fg` on hover), shown
   only when the project has children, with the **count badge** beside it while collapsed (mono
   `--text-xs`, 1-px border, `--radius-sm`); the **label** (folder name, `--text-base` / 500, ellipsis);
   the **live badge** (`N live`, same look as the count badge, `--fg-muted`), shown only above 0: the
   project's sessions in a live state (busy, idle or unrecognised; not exited).
2. **Path:** mono `--text-xs` `--fg-muted`, middle-elided, full path on hover. While branches are on and
   the last branch read failed (Story 5.1), the row reads `branches unavailable` instead (same look, git's
   message on hover; the full path moves to the label's hover): the card's size is fixed, so the line takes
   the path's row rather than adding one.
3. **Status line:** mono `--text-sm`: the git line (see [Status colours](#status-colours)), `↑n ↓m` in
   `--fg-muted` when it differs from the upstream, and, for git repos only (or while branches are on, so they
   can be turned off), the **branches** chip at the right: a toggle button whose accessible name is always
   "branches", with `aria-pressed` carrying the state (mono `--text-xs`, 1-px `--border`, `--radius-sm`,
   `--fg-muted`; border `--fg-muted` on hover; on, `--fg` text and an `--fg` border, so on never looks like
   hover; the 1-px `--focus` outline on keyboard focus). No accent.

The card size is fixed: `nodes.ts` and the arrow-key geometry depend on 240 × 80. Everything Epic 11 adds
to a card sits outside this box and never changes it: the node toolbar to the right of the card, top-aligned and
clear of the handle, and an inline hint.

### Child card (208 × 40)

One row of the column under an expanded parent: `--bg-raised`, 1-px `--border`, `--radius-md`. Same size for
session and branch children; the size is fixed like the project card's.

- **Session** (discovered from a transcript), two lines:
  1. the **title** in `--text-md`, ellipsis;
  2. the **meta** in mono `--text-xs` `--fg-muted`, ellipsis: `branch · N msgs · <age>`. The branch is left
     out when the transcript names none. The age reads `now`, `5m`, `3h`, `2d`, then `12 Oct` (this year) or
     `12 Oct 2025`, and is recomputed each minute. While the live poll has seen the session this run, the
     line starts with its **state word**, `busy · master · 12 msgs · now` / `exited · …` (see
     [Status colours](#status-colours)); a historic session shows none.

  The meta line's parts sit in a row: only the branch shrinks and ends in an ellipsis; the state word,
  the message count and the age always show whole.

  Story 7.2: while a live session has posted a `set_status` text, the line is its state word, then that text
  in place of branch, count and age (and of a finished card's last line): mono `--text-xs` `--fg-muted`, one
  line, ellipsis, the full text on hover. It goes when the session's state changes or with an empty
  `set_status`. No accent: it is information.

  Story 7.3: while a session has unread peer messages, line 1 ends in a plain **unread badge**, `N new`, after
  the title: the count badge's look (mono `--text-xs`, 1-px `--border`, `--radius-sm`) in `--fg-muted`, never the
  accent (messages are information, not attention). The title shrinks with its ellipsis; the badge never does.
  It goes when the session reads its inbox. Its accessible name and tooltip add `N unread messages`. Live or not
  (a message waits for a stopped peer), it shows whenever Rust counts unread messages.

  Story 7.4: while a session asks for review, line 1 ends in a plain **review flag**, `review`, after the title and
  the unread badge: the unread badge's look (mono `--text-xs`, 1-px `--border`, `--radius-sm`, `--fg-muted`), never
  the accent. It is a button: `--fg` text and a `--fg-muted` border on hover, the 1-px `--focus` outline on keyboard
  focus; a click opens the Review pane on that session (and the flag goes) without selecting the card. Its
  accessible name and the card's tooltip add `asks for review`. It goes when the review is opened or the flag is
  cleared.

  A live session with no transcript yet has the same card: its `name` from the poll (or `new session`) as
  the title and `0 msgs`, with no age (no activity is known) and only the start time on hover (none
  when the poll gave none).

  The full title and the exact start and last-active times are on hover (`title`).

  A **fork** (Story 4.4) is an ordinary session card; its tooltip and accessible name add `forked from
  <original title>`.
- **Branch** (a local branch, Story 5.1), one or two lines:
  1. the **name** in `--text-md`, ellipsis, then `*` (same text, never cut) for the branch checked out in the
     project's folder;
  2. the **meta** in mono `--text-xs` `--fg-muted`, left out when it would be empty: `↑n ↓m` against the
     upstream (either part left out at 0; nothing without an upstream), `upstream gone` when the upstream
     is configured but missing, then the **worktree chip** (a 1-px `--border` box, `--radius-sm`, the
     folder's last two segments after `…/`, or `missing` when the folder is gone; it is the part that shrinks
     with an ellipsis; full path on hover and in its accessible label). Only a linked worktree has a chip,
     never the project's own checkout.

  The tooltip holds the name, the upstream and the worktree path. Tokens only, no accent: a branch never
  needs attention.
- **Branch, stub:** one row: the **label** in `--text-md` (ellipsis) and, at the right, the **detail** in mono
  `--text-xs` `--fg-muted`.

### The fork line

A fork's card and its original's are joined by a thin line (Story 4.4) whenever both cards are drawn: 1 px
(`--line`) in `--border` like every line, a curve from the left edge of one card to the left edge of the other that bows 24 px
to the left of both (so two cards of one column are joined beside the column, not along its edge). No
arrowhead, no label, never the accent; it sits under the cards, cannot be hovered, selected or edited, and is
not an edge kind (Epic 6's edges are something else). Its anchors are invisible.

### Edges

Stored edges (Story 6.1) join two drawn cards with a curve. They run from the source card's right edge to
the target card's left edge; to a card further left, from the source's left edge to the target's right edge;
between two cards of one column, from right edge to right edge, curving out and back. There is no arrowhead,
and they never use the accent except for a failed live application (below).

- **Context:** one dashed 1-px line (`4 3`) in `--border-strong`.
- **Cooperate:** two parallel 1-px lines in `--border-strong`. This is drawn as a 3-px stroke whose middle
  pixel is drawn over in `--bg`.
- **Selected:** drawn in `--focus`.
- **Live state (Story 6.3):** a context edge being applied to a running session (`is-pending` on the edge) is
  drawn in `--fg-faint`; one whose application failed carries `.attention` on its line and is drawn in
  `--accent` (attention: it needs the operator). Applied, or with no live state, it is drawn as usual.
  A cooperate edge (Story 6.4) takes the same looks from its two sides: a failed side wins, then a pending
  one; notified sides draw it as usual. Selected wins over both.
- **Label:** the label sits at the midpoint in `--font-sans` `--text-xs` `--fg-muted` (`--focus` while the edge is
  selected), on `--bg`. It is one line, at most 160 px wide, and cut with an ellipsis. The full text shows
  on hover.
- **Hidden ends:** an edge with an end that is not drawn is not drawn.
- **The pointer:** a click within 6 px of the line selects the edge.

**The handle.** Session and project cards carry one handle on the right edge, centred vertically. It is a
7-px circle with a 1-px `--border-strong` border on `--bg-raised` (a `--focus` border on hover). It is
invisible until the card is hovered or selected, and the cursor over it is a crosshair. Story 11.5: hovering
a stored edge's line shows its kind and live state in words (`context edge · pending (waiting for idle)`, an
SVG `<title>`), and the handle's tooltip reads `Drag to link · e`. While a link is
dragged, the line that follows the pointer has the context edge's dashed look. Every project, branch and session
card is a drop target over its whole area. Over a card the pair is refused for, the cursor is
`not-allowed`. Nothing else changes colour.

### The more row

A column has two groups (Story 5.1): the sessions, then the branches; each is cut on its own. A session
started on a branch (Story 5.3) whose branch card is drawn sits right under that card (after
the sessions already there), one more `COLUMN_INDENT` (16 px) in, so the branch group reads branch, its
sessions, the next branch; under a dragged branch card they follow it. The card itself is an ordinary session card. Such sessions count toward neither
group's ten nor its N, and fall back to the
session group when branches are off, the branch is gone or its card is cut by the limit. Past ten in a
group, a row follows its tenth in the next column slot: `show all (N)` (N counts every child of that group),
or `show fewer` while all show; the branch group starts in the slot after the session group's row. Mono `--text-xs` in `--fg-muted` (`--fg` on hover), no border and no surface,
the slot's 208 × 40. It is selectable like a node (same outline), not draggable, and has no menu; a click or
Enter toggles it.

### Node states

Selected: 1-px `--focus` outline, 2-px offset. Duplicate add: a 1-px `--fg` outline that fades out over
1.5 s (instant under reduced motion; a selected card keeps its outline). Attention and glow: see
[States](#states); selecting the session clears both (it reads `idle` until it is busy again). A selected or dragged node draws
above its siblings (xyflow `zIndex`), so a dragged child is never hidden under its column.

## Status colours

Monochrome steps; the accent only for attention.

**Git line (project card):**

| Line | Colour |
|---|---|
| `master · 3 changed`, `↑2 ↓1` (facts) | `--fg` (`↑ ↓` in `--fg-muted`) |
| `not a git repo`, `folder missing`, `git unavailable` (not applicable) | `--fg-muted` |
| `git error` | `--fg-muted`, its message on hover |
| `…` (not polled yet) | `--fg-muted` |

**Session states** (the state word that leads a session card's meta line, Story 3.2):

| State | Colour |
|---|---|
| busy | `--fg`, after a small `currentColor` dot (4 px, round) that pulses: opacity 1 → 0.35, 1.2 s, ease-in-out, alternating; static under reduced motion |
| starting, idle, exited | `--fg-muted`, no dot. `starting` is a session the app just launched, before its first output or poll row (Story 4.2): muted exactly like `idle`, with no glow and no toast. |
| stopping | `--fg-muted`, no dot, in place of the state word of a live session whose Switchboard terminal is being stopped (Story 4.4), until its process exits (then `exited`). No glow, no accent, and a `finished` card's last line gives way to it. |
| any other status the poll reports (`compacting`), kept verbatim | `--fg-muted` |
| waiting, finished | `--accent` (attention), after the 4-px dot pulsing like `busy`'s; the card's border in `--accent` too. `finished` is a busy → idle turn seen by the poll (Story 3.3); `waiting` comes from hooks (Story 4.3). |

Historic sessions show no state word.

## Motion

Only nine motions exist (six until Epic 11); every one is instant (or static) under `prefers-reduced-motion: reduce`.

| Motion | Duration |
|---|---|
| Duplicate-add flash (outline fades out) | 1.5 s |
| Reveal pan (arrow keys bring an off-screen node into view) | 150 ms |
| Palette fade-in | 100 ms |
| Busy pulse (the dot before `busy`: opacity 1 → 0.35, ease-in-out, alternating, looping; opacity only) | 1.2 s |
| Attention pulse (the accent dot before `finished` / `waiting`: the busy pulse) | 1.2 s |
| Project glow (the accent outline around a project needing you: opacity 1 → 0.4, ease-in-out, alternating, looping; opacity only) | 1.2 s |
| Hint fade-out (an inline hint whose step is done, hints hidden, a pane opening, or its card no longer first: opacity 1 → 0, then removed; any other drop is instant; Story 11.3) | 300 ms |
| Help figures (inside the Help pane and the tour card only: opacity, transform and `stroke-dashoffset`, looping with a pause at the end of each loop; the end frame still under reduced motion; Story 11.4) | 4–8 s per loop |
| Tour cut-out move (the spotlight slides to the next stop's target; Story 11.6) | 150 ms |

Panes (the terminal pane, the launch, worktree and remove-worktree sheets, the edge inspector, the Review pane and the Help pane too), terminal tabs and pop-out windows, banners, the notice, the menu and the canvas menu, the node toolbar, the ghost card, the Elsewhere tray, the what's-new chip, the agent approval toasts, the review toasts and the tour card appear without animation. Edges appear and go without animation.

## Icons

- **Tray icon** (Story 9.2): the app icon itself (no separate tray artwork), monochrome like it. Its text is
  plain, set by the OS: the tooltip `Switchboard — 2 busy · 1 waiting` (`Switchboard — no live sessions` with
  none live), and the native menu **Show Switchboard**, a disabled counts line `2 busy · 1 waiting` (or `no live
  sessions`), a separator, **Quit**. No accent, no badge drawn on the icon. The one toast of the first close to the tray (hidden; minimized on Linux) reads
  `Switchboard is still running in the tray`; no tray shows the banner `tray unavailable: closing the window
  quits`.
- **App icon:** one source, [`src-tauri/icons/source.svg`](../src-tauri/icons/source.svg), 1024 × 1024:
  three outlined node squares joined by two lines, in `--fg` on a `--bg` rounded square; no accent, no
  gradient. The outline is the UI's 1-px line scaled up so the mark still reads at 16 px. Every other
  file in `src-tauri/icons/` is generated from it:

  ```sh
  npx tauri icon src-tauri/icons/source.svg
  ```

  After regenerating, run `cargo clean -p switchboard` (in `src-tauri/`) before the next local build: the
  window icon is embedded by `tauri::generate_context!` when the library compiles, and Cargo does not
  track the icon files, so an incremental build keeps the old one. CI builds from scratch.
  (The command also writes `android/` and `ios/` folders; Switchboard is desktop-only, so those are not
  kept.)
- **In-app glyphs** stay text (`▸ ▾ · ↑ ↓`) in `currentColor`. No SVG icon set in the UI.

## The design lint

`src/theme/design.test.ts` reads every `.css` file under `src/` and every `style={…}` in `.tsx` files and
fails, naming the file, line and rule, on:

| Rule | Fails on |
|---|---|
| `colour-literal` | a hex colour, `rgb()`/`hsl()`/`hwb()`/`lab()`/`lch()`/`oklab()`/`oklch()`/`color()`, or a named colour, outside `tokens.css` (`transparent`, `currentColor` allowed) |
| `gradient` | any `*-gradient()` |
| `shadow` | `box-shadow`, `text-shadow` (vendor-prefixed too), `drop-shadow()` |
| `font-size` | a `font-size` that is not `var(--text-*)`, or a length literal in a `font` shorthand |
| `border-radius` | a radius that is not `var(--radius-*)`, `0` or `50%` |
| `accent` | `var(--accent)` (with or without a fallback) in a rule where a selector's last compound does not start with an allow-listed class (`.banner`, `.banner-mark`, `.attention`, `.pane-error`, `.session-attention`, `.session-attention-word`, `.project-glow`, `.approval-toast`); any accent in an inline style |

Self-tests plant a bad snippet for each rule and prove it fires. Colours passed to xyflow as component
props (the dot grid's `color="var(--fg-faint)"`) are not inline styles; keep them to tokens all the same.
