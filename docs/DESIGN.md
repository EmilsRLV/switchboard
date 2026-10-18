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
| `--accent` | `#e8a33d` | Attention only (see [The accent](#the-accent)). |
| `--focus` | `var(--fg)` | Focus rings and the node selection outline. |
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

## Rules

1. **Lines are 1 px** (`--line`) in `--border`. The only 2-px lines are the left indicators: the banner
   (accent), the notice and the selected palette or menu row (`--fg-muted`).
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
```

That is: a banner's left border and mark, error text in a pane (`.pane-error`), attention text
(`.attention`), and the attention states of Story 3.3: a session card in `finished` / `waiting` (its border,
`.session-attention`, and its state word, `.session-attention-word`) and the glow of its project card
(`.project-glow`). Inline styles never use the accent.

**Terminal content is not chrome.** What a program prints in a terminal is drawn in its own colours (the
ANSI palette below, 256-colour and truecolour escapes included), which may well be orange; the accent rule
governs the app's chrome around it, never the terminal's content. The terminal pane's own chrome (header,
drag handle) follows every rule here.

### States

| State | Look |
|---|---|
| Hover (row) | `--bg-hover` background. |
| Hover (button) | Border in `--fg-muted`. |
| Selected row (palette, menu) | `--bg-hover` background and a 2-px `--fg-muted` left border (transparent when not selected, so the text never shifts). |
| Keyboard focus | A 1-px `--focus` outline, offset 1 px. The palette input shows none: it always has focus while the palette is open, and the dialog's border is the cue. |
| Selected node | A 1-px `--focus` outline, offset 2 px, and the node draws above its siblings. |
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
- **The terminal pane** is a pane, wider: `min(720px, 70vw)` by default, dragged between 360 px and 90vw by
  its left edge (a 6-px handle over the 1-px border, `--border` while hovered, `col-resize` cursor). A header
  row over a 1-px `--border` line holds the project label (`--text-md` / 500), its folder (mono `--text-xs`
  `--fg-muted`, ellipsis), the state (mono `--text-xs` `--fg-muted`: `running`, `exited N`; `could not start
  …` is `.pane-error`) and the buttons. Below it the terminal fills the rest on `--bg-raised` with no chrome
  inside it. It appears without animation, like every pane.
- **The palette** is centred near the top over a dimmed page (`--bg` at 55%): `--bg-raised`, 1-px border,
  `--radius-md`; rows in `--text-base`, key hints in `--text-sm` `--fg-muted`.
- **The context menu** is the palette's row look at the pointer: `--bg-raised`, 1-px border,
  `--radius-md`, items in `--text-md`, groups split by a 1-px `--border` line. Project and session cards
  have one; it lists only enabled entries and does not open when there are none.
- **The Elsewhere tray** (live sessions in folders not on the canvas) sits at the canvas's bottom-left, over
  it and below the notice, panes, palette and menu. A chip `elsewhere N` (mono `--text-xs`, `--fg-muted`,
  `--bg-raised`, 1-px `--border`, `--radius-sm`; `--fg` text and a `--fg-muted` border on hover or while
  open) shows only when N > 0. Open, a list above it: a `--bg-raised` box with a 1-px `--border` and
  `--radius-md`, rows split by a 1-px `--border` line, each with the state word (mono `--text-xs`, `busy` in
  `--fg`, the rest `--fg-muted`; no pulse), the name (`--text-md`, ellipsis), the shortened cwd (mono
  `--text-xs` `--fg-muted`, full path on hover) and an **Add folder** button. No accent.
- **The canvas** is `--bg` with a dot grid in `--fg-faint`; empty, it shows a centred mono hint in
  `--fg-muted`. Nothing on the canvas uses the accent except the attention states (a `finished` / `waiting` session card and its project's glow; see [States](#states)).

## Node anatomy

### Project card (240 × 80)

`--bg-raised`, 1-px `--border`, `--radius-md`, `--text-md`, top to bottom:

1. **Head row:** the **chevron** (`▸` collapsed / `▾` expanded, `--fg-muted`, `--fg` on hover), shown
   only when the project has children, with the **count badge** beside it while collapsed (mono
   `--text-xs`, 1-px border, `--radius-sm`); the **label** (folder name, `--text-base` / 500, ellipsis);
   the **live badge** (`N live`, same look as the count badge, `--fg-muted`), shown only above 0: the
   project's sessions in a live state (busy, idle or unrecognised; not exited).
2. **Path:** mono `--text-xs` `--fg-muted`, middle-elided, full path on hover.
3. **Status line:** mono `--text-sm`: the git line (see [Status colours](#status-colours)), `↑n ↓m` in
   `--fg-muted` when it differs from the upstream, and, for git repos only, the **branches** affordance at
   the right (mono `--text-xs`, 1-px border, `--radius-sm`, `--fg-muted`; inert until Epic 5).

The card size is fixed: `nodes.ts` and the arrow-key geometry depend on 240 × 80.

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

  A live session with no transcript yet has the same card: its `name` from the poll (or `new session`) as
  the title and `0 msgs`, with no age (no activity is known) and only the start time on hover (none
  when the poll gave none).

  The full title and the exact start and last-active times are on hover (`title`).
- **Branch, stub:** one row: the **label** in `--text-md` (ellipsis) and, at the right, the **detail** in mono
  `--text-xs` `--fg-muted`.

### The more row

Past ten children, a row follows the tenth in the next column slot: `show all (N)` (N counts every child),
or `show fewer` while all show. Mono `--text-xs` in `--fg-muted` (`--fg` on hover), no border and no surface,
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
| idle, exited | `--fg-muted` |
| any other status the poll reports (`compacting`), kept verbatim | `--fg-muted` |
| waiting, finished | `--accent` (attention), after the 4-px dot pulsing like `busy`'s; the card's border in `--accent` too. `finished` is a busy → idle turn seen by the poll (Story 3.3); `waiting` comes from hooks (Story 4.3). |

Historic sessions show no state word.

## Motion

Only six motions exist; every one is instant (or static) under `prefers-reduced-motion: reduce`.

| Motion | Duration |
|---|---|
| Duplicate-add flash (outline fades out) | 1.5 s |
| Reveal pan (arrow keys bring an off-screen node into view) | 150 ms |
| Palette fade-in | 100 ms |
| Busy pulse (the dot before `busy`: opacity 1 → 0.35, ease-in-out, alternating, looping; opacity only) | 1.2 s |
| Attention pulse (the accent dot before `finished` / `waiting`: the busy pulse) | 1.2 s |
| Project glow (the accent outline around a project needing you: opacity 1 → 0.4, ease-in-out, alternating, looping; opacity only) | 1.2 s |

Panes (the terminal pane too), banners, the notice, the menu and the Elsewhere tray appear without animation.

## Icons

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
| `accent` | `var(--accent)` (with or without a fallback) in a rule where a selector's last compound does not start with an allow-listed class (`.banner`, `.banner-mark`, `.attention`, `.pane-error`, `.session-attention`, `.session-attention-word`, `.project-glow`); any accent in an inline style |

Self-tests plant a bad snippet for each rule and prove it fires. Colours passed to xyflow as component
props (the dot grid's `color="var(--fg-faint)"`) are not inline styles; keep them to tokens all the same.
