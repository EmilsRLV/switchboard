// The Help figures (Story 11.4): each renders (server-side, no DOM) as a picture named by its alt
// text, with no colour in an inline style and only classes the app's own stylesheets define.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FIGURES, figureFor, type FigureName } from "./index";

/** The slice of `node:fs` the test reads with (the project has no Node typings). */
type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const SRC = new URL("../../", import.meta.url);
const STYLESHEETS = ["canvas/nodes.css", "components/shell.css", "help/figures.css"];

/** Every class a stylesheet's selectors name: the text before each `{` that is not an at-rule. */
function selectorClasses(css: string): Set<string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const preludes = [...text.matchAll(/([^{};]*)\{/g)].map((m) => m[1]!.trim()).filter((p) => !p.startsWith("@"));
  return new Set(preludes.flatMap((p) => [...p.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!)));
}

const DEFINED = new Set(STYLESHEETS.flatMap((file) => [...selectorClasses(fs.readFileSync(new URL(file, SRC), "utf8"))]));

/** A colour in an inline style: a hex, rgb()/hsl() or a `var(--…)` token. */
const STYLE_COLOUR = /#|rgba?\(|hsla?\(|var\(--/i;

const NAMES = Object.keys(FIGURES) as FigureName[];

describe("the Help figures", () => {
  it("are the five of Story 11.4", () => {
    expect(NAMES.sort()).toEqual(["draw-edge", "edge-kinds", "node-anatomy", "panes", "session-states"]);
  });

  it("figureFor matches a name exactly, never a key of Object.prototype", () => {
    expect(figureFor("draw-edge")).toBe(FIGURES["draw-edge"]);
    for (const name of ["Draw-edge", " draw-edge", "nope", "constructor", "__proto__", "toString", "<b>x</b>"]) {
      expect(figureFor(name), name).toBeNull();
    }
  });

  for (const name of NAMES) {
    describe(name, () => {
      const Figure = FIGURES[name];
      const alt = `Alt text for ${name} & <friends>`;
      const html = renderToStaticMarkup(<Figure alt={alt} />);

      it('is one role="img" named by its alt text, in a help-figure box', () => {
        expect(html.startsWith(`<div class="help-figure help-figure-${name}" role="img" aria-label="Alt text for ${name} &amp; &lt;friends&gt;">`)).toBe(true);
        expect(html.match(/role="img"/g)).toHaveLength(1);
      });

      it("has no colour in an inline style", () => {
        const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
        for (const style of styles) expect(style, style).not.toMatch(STYLE_COLOUR);
      });

      it("uses only classes nodes.css, shell.css or figures.css define", () => {
        const used = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/).filter(Boolean)));
        expect(used.size).toBeGreaterThan(0);
        expect([...used].filter((c) => !DEFINED.has(c))).toEqual([]);
      });

      it("every animated element (a help-anim-<x> class) carries help-anim, the reduced-motion hook", () => {
        const lists = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/));
        const animated = lists.filter((classes) => classes.some((c) => c.startsWith("help-anim-")));
        for (const classes of animated) expect(classes, classes.join(" ")).toContain("help-anim");
        expect(lists.filter((classes) => classes.includes("help-anim") && !classes.some((c) => c.startsWith("help-anim-")))).toEqual([]);
      });

      it("an empty alt falls back to the figure's name as its label", () => {
        for (const empty of ["", "  "]) {
          expect(renderToStaticMarkup(<Figure alt={empty} />)).toContain(`role="img" aria-label="${name}"`);
        }
      });

      it("has nothing focusable or clickable inside", () => {
        expect(html).not.toMatch(/<(?:button|a|input|select|textarea)\b|tabindex=/);
      });
    });
  }

  it("draw-edge's end frame shows only the handle the last drag started from", () => {
    const DrawEdge = FIGURES["draw-edge"];
    const html = renderToStaticMarkup(<DrawEdge alt="x" />);
    const handles = [...html.matchAll(/class="(react-flow__handle link-handle[^"]*)"/g)].map((m) => m[1]!);
    expect(handles).toHaveLength(2);
    expect(handles.filter((c) => c.split(" ").includes("is-shown"))).toEqual([expect.stringContaining("help-anim-handle-cooperate")]);
  });

  it("the class collector reads selectors, not values", () => {
    const classes = selectorClasses(".a .b:hover, .c::after { margin: 0.5rem; } @media (x) { .d { opacity: 0.4; } } /* .e */");
    expect([...classes].sort()).toEqual(["a", "b", "c", "d"]);
  });
});
