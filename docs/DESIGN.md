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
```

That is: a banner's left border and mark, error text in a pane (`.pane-error`) and attention text
(`.attention`). From Epic 3 the `waiting` and `finished` session states join the list (and the lint with
them). Inline styles never use the accent.

### States

| State | Look |
|---|---|
| Hover (row) | `--bg-hover` background. |
| Hover (button) | Border in `--fg-muted`. |
| Selected row (palette, menu) | `--bg-hover` background and a 2-px `--fg-muted` left border (transparent when not selected, so the text never shifts). |
| Keyboard focus | A 1-px `--focus` outline, offset 1 px. The palette input shows none: it always has focus while the palette is open, and the dialog's border is the cue. |
| Selected node | A 1-px `--focus` outline, offset 2 px, and the node draws above its siblings. |
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
- **The palette** is centred near the top over a dimmed page (`--bg` at 55%): `--bg-raised`, 1-px border,
  `--radius-md`; rows in `--text-base`, key hints in `--text-sm` `--fg-muted`.
- **The context menu** is the palette's row look at the pointer: `--bg-raised`, 1-px border,
  `--radius-md`, items in `--text-md`, groups split by a 1-px `--border` line.
- **The canvas** is `--bg` with a dot grid in `--fg-faint`; empty, it shows a centred mono hint in
  `--fg-muted`. Nothing on the canvas uses the accent.

## Node anatomy

### Project card (240 × 80)

`--bg-raised`, 1-px `--border`, `--radius-md`, `--text-md`, top to bottom:

1. **Head row:** the **chevron** (`▸` collapsed / `▾` expanded, `--fg-muted`, `--fg` on hover), shown
   only when the project has children, with the **count badge** beside it while collapsed (mono
   `--text-xs`, 1-px border, `--radius-sm`); the **label** (folder name, `--text-base` / 500, ellipsis);
   the **live badge** (`N live`, same look as the count badge, `--fg-muted`), shown only above 0 (Epic 3).
2. **Path:** mono `--text-xs` `--fg-muted`, middle-elided, full path on hover.
3. **Status line:** mono `--text-sm`: the git line (see [Status colours](#status-colours)), `↑n ↓m` in
   `--fg-muted` when it differs from the upstream, and, for git repos only, the **branches** affordance at
   the right (mono `--text-xs`, 1-px border, `--radius-sm`, `--fg-muted`; inert until Epic 5).

The card size is fixed: `nodes.ts` and the arrow-key geometry depend on 240 × 80.

### Child card (208 × 40)

One row of the column under an expanded parent: `--bg-raised`, 1-px `--border`, `--radius-md`; the
**label** in `--text-md` (ellipsis) and, at the right, the **detail** in mono `--text-xs` `--fg-muted`.
Same size for session and branch children; the size is fixed like the project card's.

### Node states

Selected: 1-px `--focus` outline, 2-px offset. Duplicate add: a 1-px `--fg` outline that fades out over
1.5 s (instant under reduced motion; a selected card keeps its outline). A selected or dragged node draws
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

**Session states (documented now, built in Epic 3):**

| State | Colour |
|---|---|
| busy | `--fg`, with a 1-px pulse |
| idle, exited | `--fg-muted` |
| waiting, finished | `--accent` (attention) |

## Motion

Only three motions exist; every one is instant under `prefers-reduced-motion: reduce`.

| Motion | Duration |
|---|---|
| Duplicate-add flash (outline fades out) | 1.5 s |
| Reveal pan (arrow keys bring an off-screen node into view) | 150 ms |
| Palette fade-in | 100 ms |

Panes, banners, the notice and the menu appear without animation.

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
| `accent` | `var(--accent)` (with or without a fallback) in a rule where a selector's last compound does not start with an allow-listed class (`.banner`, `.banner-mark`, `.attention`, `.pane-error`); any accent in an inline style |

Self-tests plant a bad snippet for each rule and prove it fires. Colours passed to xyflow as component
props (the dot grid's `color="var(--fg-faint)"`) are not inline styles; keep them to tokens all the same.
