// The design lint: the rules of docs/DESIGN.md, enforced on every stylesheet under `src/` and
// every inline `style={…}` in a `.tsx` file. When DESIGN.md changes, this file changes with it.
//
// Rules (each violation names the file, the line and the rule):
//   colour-literal  a hex colour, rgb()/hsl()/… or a named colour outside theme/tokens.css
//                   (`transparent` and `currentColor` are allowed);
//   gradient        any *-gradient();
//   shadow          box-shadow, text-shadow (vendor-prefixed too) or drop-shadow();
//   font-size       a font-size that is not var(--text-*), or a length in a `font` shorthand;
//   border-radius   a radius that is not var(--radius-*), 0 or 50%;
//   accent          var(--accent) in a rule where a selector's last compound does not start
//                   with a class on the attention allow-list (inline styles never may use it).
//
// The sources are read from disk with `node:fs` (vitest's node environment; no DOM), with
// paths normalised to forward slashes so it reports the same on Windows and Linux.

import { describe, expect, it } from "vitest";

/** The selectors (by their first class) that may use the accent: attention states only. */
const ACCENT_ALLOW_LIST = [".banner", ".banner-mark", ".attention", ".pane-error"] as const;

/** The one file allowed to write colour values. */
const TOKENS_FILE = "/src/theme/tokens.css";

type Rule = "colour-literal" | "gradient" | "shadow" | "font-size" | "border-radius" | "accent";

type Violation = { file: string; line: number; rule: Rule; text: string };

/** CSS named colours (CSS Color 4), lower case. `transparent` and `currentcolor` are not here. */
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen"
  ).split(" "),
);

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const GRADIENT = /gradient\(/i;
const DROP_SHADOW = /drop-shadow\(/i;
const FONT_SIZE_OK = /^var\(--text-[a-z]+\)$/;
const RADIUS_OK = /^(?:var\(--radius-[a-z]+\)|0|50%)$/;
const ACCENT = /var\(\s*--accent\s*[),]/;
const FONT_KEYWORD = /^(?:inherit|initial|unset|revert)$/i;
/** A length or percentage literal (`15px`, `0.8rem`, `90%`); unitless numbers (weights, line-heights) are fine. */
const LENGTH = /(?<![\w-])\d*\.?\d+(?:[a-z]+|%)/i;

/** 1-based line of `offset` in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** `text` with every comment blanked out (newlines kept), so offsets and lines still match. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Does `value` (a CSS value or a string literal's content) hold a colour literal? */
function hasColourLiteral(value: string): boolean {
  if (HEX.test(value) || COLOUR_FUNCTION.test(value)) return true;
  const words = value
    .replace(/var\([^)]*\)/g, " ")
    .replace(/"[^"]*"|'[^']*'/g, " ")
    .match(/(?<![\w-])[a-zA-Z][a-zA-Z-]*/g);
  return (words ?? []).some((word) => NAMED_COLOURS.has(word.toLowerCase()));
}

/** Does the selector start with a class on the accent allow-list (`.banner`, `.banner.x .y`)? */
function allowedForAccent(selector: string): boolean {
  // The element styled is the last compound (after the final space, `>`, `+` or `~`).
  const last = selector.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? "";
  const first = /^\.([\w-]+)/.exec(last);
  return first !== null && (ACCENT_ALLOW_LIST as readonly string[]).includes(`.${first[1]}`);
}

/** Does a `font` shorthand set a size off the scale (a length literal outside `var(…)`)? */
function fontShorthandOffScale(value: string): boolean {
  if (FONT_KEYWORD.test(value)) return false;
  return LENGTH.test(value.replace(/var\([^)]*\)/g, " ").replace(/"[^"]*"|'[^']*'/g, " "));
}

type Declaration = { property: string; value: string; offset: number; selectors: string[] };

/** Index of the next of `chars` at or after `from`, skipping quoted strings; -1 for none. */
function nextOf(text: string, from: number, chars: string): number {
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? text.length : close;
      continue;
    }
    if (chars.includes(c)) return i;
  }
  return -1;
}

/**
 * Every declaration of a stylesheet with the selectors of its rule. A small hand parser: the
 * stylesheets are plain CSS without nesting; `@media`, `@supports` and `@keyframes` blocks are
 * descended (a keyframe's `from` / `to` counts as its selector), statement at-rules skipped.
 */
function declarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  const block = (start: number): number => {
    let i = start;
    while (i < css.length) {
      const at = nextOf(css, i, "{};");
      if (at === -1) return css.length;
      const prelude = css.slice(i, at).trim();
      if (css[at] === "}") return at + 1;
      if (css[at] === ";") {
        i = at + 1; // `@import …;` and the like
        continue;
      }
      if (prelude.startsWith("@")) {
        i = block(at + 1);
        continue;
      }
      const close = nextOf(css, at + 1, "}");
      const end = close === -1 ? css.length : close;
      const selectors = prelude.split(",").map((s) => s.trim());
      let d = at + 1;
      while (d < end) {
        const semi = nextOf(css, d, ";");
        const stop = semi === -1 || semi > end ? end : semi;
        const raw = css.slice(d, stop);
        const colon = raw.indexOf(":");
        if (colon !== -1) {
          const lead = raw.length - raw.trimStart().length;
          out.push({
            property: raw.slice(0, colon).trim().toLowerCase(),
            value: raw.slice(colon + 1).trim(),
            offset: d + lead,
            selectors,
          });
        }
        d = stop + 1;
      }
      i = end + 1;
    }
    return i;
  };
  block(0);
  return out;
}

/** The violations of one stylesheet. */
function lintCss(file: string, source: string): Violation[] {
  const css = stripComments(source);
  const out: Violation[] = [];
  for (const { property, value, offset, selectors } of declarations(css)) {
    const flag = (rule: Rule) => out.push({ file, line: lineAt(css, offset), rule, text: `${property}: ${value}` });
    if (file !== TOKENS_FILE && hasColourLiteral(value)) flag("colour-literal");
    if (GRADIENT.test(value)) flag("gradient");
    const bare = value.replace(/\s*!important\s*$/i, "");
    if (/^(?:-[a-z]+-)?(?:box|text)-shadow$/.test(property) || DROP_SHADOW.test(value)) flag("shadow");
    if (property === "font-size" && !FONT_SIZE_OK.test(bare)) flag("font-size");
    if (property === "font" && fontShorthandOffScale(bare)) flag("font-size");
    if (/^border(?:-[a-z]+)*-radius$/.test(property) && !RADIUS_OK.test(bare)) flag("border-radius");
    if (ACCENT.test(value) && !selectors.every(allowedForAccent)) flag("accent");
  }
  return out;
}

/** Each `style={…}` in a TSX source: its inner text and offset. */
function inlineStyles(tsx: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const opener = /\bstyle=\{/g;
  for (let match = opener.exec(tsx); match !== null; match = opener.exec(tsx)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < tsx.length && depth > 0; i += 1) {
      if (tsx[i] === "{") depth += 1;
      else if (tsx[i] === "}") depth -= 1;
    }
    out.push({ text: tsx.slice(start, i - 1), offset: match.index });
  }
  return out;
}

/** The violations of the inline styles of one TSX file. */
function lintTsx(file: string, tsx: string): Violation[] {
  const out: Violation[] = [];
  for (const { text, offset } of inlineStyles(tsx)) {
    const flag = (rule: Rule) => out.push({ file, line: lineAt(tsx, offset), rule, text: `style={${text}}` });
    const strings = (text.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? []).map((s) => s.slice(1, -1));
    if (HEX.test(text) || COLOUR_FUNCTION.test(text) || strings.some(hasColourLiteral)) flag("colour-literal");
    if (GRADIENT.test(text)) flag("gradient");
    if (/\b(?:boxShadow|textShadow)\b/.test(text) || DROP_SHADOW.test(text)) flag("shadow");
    const fontSize = /\bfontSize\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/.exec(text);
    if (fontSize !== null && !FONT_SIZE_OK.test(fontSize[1]!.trim().replace(/^["']|["']$/g, ""))) flag("font-size");
    const radius = /\bborder\w*Radius\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/.exec(text);
    if (radius !== null && !RADIUS_OK.test(radius[1]!.trim().replace(/^["']|["']$/g, ""))) flag("border-radius");
    if (/--accent\b/.test(text)) flag("accent");
  }
  return out;
}

function format(violations: Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.text}`);
}

/** The slice of `node:fs` the lint reads with (the project has no Node typings). */
type Fs = {
  readdirSync(path: URL, options: { recursive: true }): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
};
// A non-literal specifier keeps `tsc` from looking for Node's typings; vitest runs in Node.
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const SRC = new URL("../", import.meta.url);

/** Every `.css` / `.tsx` file under `src/`, keyed `/src/<path>` with forward slashes. */
function sources(extension: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(SRC, { recursive: true })) {
    const path = entry.replace(/\\/g, "/");
    if (path.endsWith(extension)) out[`/src/${path}`] = fs.readFileSync(new URL(path, SRC), "utf8");
  }
  return out;
}

const stylesheets = sources(".css");
const components = sources(".tsx");

describe("design lint: the tree", () => {
  it("finds the stylesheets and components it is meant to guard", () => {
    const files = [...Object.keys(stylesheets), ...Object.keys(components)];
    for (const expected of [
      TOKENS_FILE,
      "/src/theme/base.css",
      "/src/components/shell.css",
      "/src/canvas/canvas.css",
      "/src/canvas/nodes.css",
      "/src/components/ContextMenu.tsx",
    ]) {
      expect(files).toContain(expected);
    }
    // Read as source text, not empty.
    expect(stylesheets["/src/components/shell.css"]).toContain(".palette-row");
    expect(stylesheets[TOKENS_FILE]).toContain("--accent:");
  });

  it("every stylesheet follows docs/DESIGN.md", () => {
    const violations = Object.entries(stylesheets).flatMap(([file, source]) => lintCss(file, source));
    expect(format(violations)).toEqual([]);
  });

  it("every inline style follows docs/DESIGN.md", () => {
    const violations = Object.entries(components).flatMap(([file, source]) => lintTsx(file, source));
    expect(format(violations)).toEqual([]);
  });

  it("the busy pulse animates opacity only and is static under reduced motion", () => {
    const nodes = stylesheets["/src/canvas/nodes.css"] ?? "";
    const block = /@keyframes session-pulse\s*\{([\s\S]*?)\n\}/.exec(nodes)?.[1] ?? "";
    const properties = [...block.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(properties.length).toBeGreaterThan(0);
    expect(new Set(properties)).toEqual(new Set(["opacity"]));
    expect(nodes).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.session-state-busy \.session-dot \{\s*animation: none;/);
  });
});

describe("design lint: each rule fires", () => {
  const css = (snippet: string, file = "/src/x.css") => lintCss(file, snippet).map((v) => `${v.line} ${v.rule}`);
  const tsx = (snippet: string) => lintTsx("/src/X.tsx", snippet).map((v) => `${v.line} ${v.rule}`);

  it("colour literals, outside tokens.css only", () => {
    expect(css(".a {\n  color: #fff;\n}")).toEqual(["2 colour-literal"]);
    expect(css(".a { background: rgba(0, 0, 0, 0.5); }")).toEqual(["1 colour-literal"]);
    expect(css(".a { border-color: hsl(10 20% 30%); }")).toEqual(["1 colour-literal"]);
    expect(css(".a { color: white; }")).toEqual(["1 colour-literal"]);
    expect(css(".a { border: 1px solid Red; }")).toEqual(["1 colour-literal"]);
    expect(css(":root { --x: #123456; }", TOKENS_FILE)).toEqual([]);
    expect(css(".a { color: transparent; background: currentColor; fill: var(--fg); }")).toEqual([]);
    expect(css(".a { white-space: nowrap; background: color-mix(in srgb, var(--bg) 55%, transparent); }")).toEqual([]);
    // Selectors and comments are not values.
    expect(css("#red .white { color: var(--fg); } /* color: #fff */")).toEqual([]);
  });

  it("gradients and the three shadows", () => {
    expect(css(".a { background: linear-gradient(var(--bg), var(--fg)); }")).toEqual(["1 gradient"]);
    expect(css(".a { background-image: repeating-radial-gradient(circle, var(--bg), var(--fg)); }")).toEqual(["1 gradient"]);
    expect(css(".a { box-shadow: inset 2px 0 0 var(--fg-muted); }")).toEqual(["1 shadow"]);
    expect(css(".a { text-shadow: 0 0 1px var(--fg); }")).toEqual(["1 shadow"]);
    expect(css(".a { filter: drop-shadow(0 0 1px var(--fg)); }")).toEqual(["1 shadow"]);
    expect(css(".a { -webkit-box-shadow: 0 0 1px var(--fg); }")).toEqual(["1 shadow"]);
  });

  it("font sizes off the scale", () => {
    expect(css(".a { font-size: 15px; }")).toEqual(["1 font-size"]);
    expect(css(".a { font-size: 0.8rem; }")).toEqual(["1 font-size"]);
    expect(css(".a { font-size: var(--text-md); }")).toEqual([]);
    expect(css(".a { font-size: var(--text-md) !important; }")).toEqual([]);
    expect(css(".a { font-size: 15px !important; }")).toEqual(["1 font-size"]);
    // The `font` shorthand: a length literal is a size off the scale.
    expect(css(".a { font: 500 15px var(--font-sans); }")).toEqual(["1 font-size"]);
    expect(css(".a { font: 12px/1 x; }")).toEqual(["1 font-size"]);
    expect(css(".a { font: inherit; }")).toEqual([]);
    expect(css(".a { font: 500 var(--text-md)/1.4 var(--font-sans); }")).toEqual([]);
  });

  it("radii off the tokens", () => {
    expect(css(".a { border-radius: 6px; }")).toEqual(["1 border-radius"]);
    expect(css(".a { border-top-left-radius: 2px; }")).toEqual(["1 border-radius"]);
    expect(css(".a { border-radius: var(--radius-sm) !important; }")).toEqual([]);
    expect(css(".a { border-radius: var(--radius-sm); } .b { border-radius: 50%; } .c { border-radius: 0; }")).toEqual([]);
  });

  it("the accent outside the attention allow-list, @media and @keyframes included", () => {
    expect(css(".btn:focus-visible { outline: 1px solid var(--accent); }")).toEqual(["1 accent"]);
    expect(css(".banner, .palette-row { color: var(--accent); }")).toEqual(["1 accent"]);
    expect(css("@media (min-width: 1px) {\n  .x { color: var(--accent); }\n}")).toEqual(["2 accent"]);
    expect(css("@keyframes k { from { color: var(--accent); } }")).toEqual(["1 accent"]);
    // The element styled (the last compound) is what must be on the list, not an ancestor.
    expect(css(".banner .palette-row { color: var(--accent); }")).toEqual(["1 accent"]);
    expect(css(".attention ~ .btn { color: var(--accent); }")).toEqual(["1 accent"]);
    // A fallback does not hide it.
    expect(css(".x { color: var(--accent, red); }")).toEqual(["1 accent"]);
    expect(css(".banner { color: var(--accent); } .pane-error { color: var(--accent); }")).toEqual([]);
    expect(
      css(".banner { border-left: 2px solid var(--accent); } .banner.is-x .banner-mark { background: var(--accent); }"),
    ).toEqual([]);
    expect(css(".attention, .pane-error { color: var(--accent); }")).toEqual([]);
  });

  it("inline styles in TSX", () => {
    expect(tsx('<div\n  style={{ color: "#fff" }} />')).toEqual(["2 colour-literal"]);
    expect(tsx('<div style={{ background: "white" }} />')).toEqual(["1 colour-literal"]);
    expect(tsx('<div style={{ background: "linear-gradient(var(--bg), var(--fg))" }} />')).toEqual(["1 gradient"]);
    expect(tsx('<div style={{ boxShadow: "none" }} />')).toEqual(["1 shadow"]);
    expect(tsx("<div style={{ fontSize: 15 }} />")).toEqual(["1 font-size"]);
    expect(tsx('<div style={{ borderRadius: "6px" }} />')).toEqual(["1 border-radius"]);
    expect(tsx('<div style={{ color: "var(--accent)" }} />')).toEqual(["1 accent"]);
    expect(tsx('<div style={{ left: position.x, top: position.y, fontSize: "var(--text-sm)", borderRadius: 0 }} />')).toEqual([]);
  });
});
