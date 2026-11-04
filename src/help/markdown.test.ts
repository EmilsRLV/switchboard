import { describe, expect, it } from "vitest";
import { isWebUrl, linkTarget, plainText, renderMarkdown, slugify, type HelpNode } from "./markdown";

const PAGES: Record<string, string> = { "canvas.md": "canvas", "keyboard.md": "keyboard" };
const options = { resolvePage: (file: string) => PAGES[file] ?? null, currentPage: "canvas" };

function render(src: string): HelpNode[] {
  return renderMarkdown(src, options);
}

/** The inline children of the only paragraph `src` renders to. */
function inline(src: string): HelpNode[] {
  const nodes = render(src);
  expect(nodes).toHaveLength(1);
  const [paragraph] = nodes;
  if (paragraph?.type !== "paragraph") throw new Error(`not a paragraph: ${JSON.stringify(paragraph)}`);
  return paragraph.children;
}

const text = (t: string): HelpNode => ({ type: "text", text: t });

describe("renderMarkdown", () => {
  it("renders headings with slug ids, setext ones too, and keeps ids unique on a page", () => {
    expect(render("# Canvas & navigation\n\n## The *handle* ##\n\nSub\n---\n\n## The handle")).toEqual([
      { type: "heading", level: 1, id: "canvas--navigation", children: [text("Canvas & navigation")] },
      { type: "heading", level: 2, id: "the-handle", children: [text("The "), { type: "emphasis", children: [text("handle")] }] },
      { type: "heading", level: 2, id: "sub", children: [text("Sub")] },
      { type: "heading", level: 2, id: "the-handle-1", children: [text("The handle")] },
    ]);
  });

  it("joins a paragraph's lines with one space", () => {
    expect(render("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", children: [text("one two")] },
      { type: "paragraph", children: [text("three")] },
    ]);
  });

  it("renders emphasis, strong emphasis and inline code", () => {
    expect(inline("a *b* __c__ `ctrl+k` d")).toEqual([
      text("a "),
      { type: "emphasis", children: [text("b")] },
      text(" "),
      { type: "strong", children: [text("c")] },
      text(" "),
      { type: "code", text: "ctrl+k" },
      text(" d"),
    ]);
    expect(inline("`` a`b ``")).toEqual([{ type: "code", text: "a`b" }]);
  });

  it("renders bullet and numbered lists, nested, with their paragraphs", () => {
    expect(render("- one\n  more\n- two\n  1. inner\n\n1. first\n2. second")).toEqual([
      {
        type: "list",
        ordered: false,
        children: [
          { type: "item", children: [{ type: "paragraph", children: [text("one more")] }] },
          {
            type: "item",
            children: [
              { type: "paragraph", children: [text("two")] },
              { type: "list", ordered: true, children: [{ type: "item", children: [{ type: "paragraph", children: [text("inner")] }] }] },
            ],
          },
        ],
      },
      {
        type: "list",
        ordered: true,
        children: [
          { type: "item", children: [{ type: "paragraph", children: [text("first")] }] },
          { type: "item", children: [{ type: "paragraph", children: [text("second")] }] },
        ],
      },
    ]);
  });

  it("renders fenced and indented code blocks verbatim", () => {
    expect(render("```json\n{ \"a\": \"<b>\" }\nline 2\n```\n\n    indented\n    two")).toEqual([
      { type: "codeBlock", text: '{ "a": "<b>" }\nline 2' },
      { type: "codeBlock", text: "indented\ntwo" },
    ]);
  });

  it("Story 11.4: a fenced block with the info `figure <name>` is a figure, its text the alt on one line", () => {
    expect(render("```figure draw-edge\nDrag the handle\n  onto a card.\n```")).toEqual([
      { type: "figure", name: "draw-edge", alt: "Drag the handle onto a card." },
    ]);
    expect(render("~~~figure   edge-kinds  \nFive edges.\n~~~")).toEqual([{ type: "figure", name: "edge-kinds", alt: "Five edges." }]);
  });

  it("Story 11.4: `figure` with no name, and any other info string, stays a code block", () => {
    expect(render("```figure\nDrag the handle\n```")).toEqual([{ type: "codeBlock", text: "Drag the handle" }]);
    expect(render("```figures draw-edge\nx\n```")).toEqual([{ type: "codeBlock", text: "x" }]);
    expect(render("```json\n{}\n```")).toEqual([{ type: "codeBlock", text: "{}" }]);
    expect(render("```\nplain\n```")).toEqual([{ type: "codeBlock", text: "plain" }]);
  });

  it("Story 11.4: an odd figure name is kept literally, never interpreted", () => {
    expect(render("```figure <b>x</b>\nalt <i>text</i>\n```")).toEqual([{ type: "figure", name: "<b>x</b>", alt: "alt <i>text</i>" }]);
  });

  it("shows raw HTML, inline and as a block, as literal text", () => {
    expect(render("<script>alert(1)</script>")).toEqual([{ type: "paragraph", children: [text("<script>alert(1)</script>")] }]);
    expect(inline('a <img src=x onerror="alert(1)"> b <b>c</b>')).toEqual([text('a <img src=x onerror="alert(1)"> b <b>c</b>')]);
    expect(render("<div>\n*not emphasis*\n</div>")).toEqual([{ type: "paragraph", children: [text("<div>\n*not emphasis*\n</div>")] }]);
  });

  it("shows an image as its source text", () => {
    expect(inline("see ![a](b.png) here")).toEqual([text("see ![a](b.png) here")]);
  });

  it("everything else (quotes, rules, autolinks, escapes, entities) becomes text", () => {
    expect(render("> quoted")).toEqual([{ type: "paragraph", children: [text("> quoted")] }]);
    expect(render("***")).toEqual([{ type: "paragraph", children: [text("***")] }]);
    expect(inline("<https://example.com> \\*x\\* &amp; &copy;")).toEqual([text("<https://example.com> *x* & &copy;")]);
  });

  it("makes http and https links web links, whatever their case", () => {
    expect(inline("[site](https://example.com/a?b=c) and [old](HTTP://example.com)")).toEqual([
      { type: "link", target: { kind: "web", url: "https://example.com/a?b=c" }, children: [text("site")] },
      text(" and "),
      { type: "link", target: { kind: "web", url: "HTTP://example.com" }, children: [text("old")] },
    ]);
  });

  it("renders javascript:, file: and other schemes as their link text, never as links", () => {
    expect(inline("[x](javascript:alert(1)) [y](file:///C:/Windows) [z](mailto:a@b.c) [w](//evil.example)")).toEqual([text("x y z w")]);
  });

  it("makes a link to a known page (with an optional #heading) a page link", () => {
    expect(inline("[the palette](keyboard.md#palette), [canvas](canvas.md) and [here](#nodes)")).toEqual([
      { type: "link", target: { kind: "page", page: "keyboard", anchor: "palette" }, children: [text("the palette")] },
      text(", "),
      { type: "link", target: { kind: "page", page: "canvas", anchor: null }, children: [text("canvas")] },
      text(" and "),
      { type: "link", target: { kind: "page", page: "canvas", anchor: "nodes" }, children: [text("here")] },
    ]);
  });

  it("renders a link to an unknown page as its text", () => {
    expect(inline("[gone](missing.md#x) and [up](../README.md)")).toEqual([text("gone and up")]);
  });

  it("keeps the link text's own markup", () => {
    expect(inline("[**bold** `k`](keyboard.md)")).toEqual([
      { type: "link", target: { kind: "page", page: "keyboard", anchor: null }, children: [{ type: "strong", children: [text("bold")] }, text(" "), { type: "code", text: "k" }] },
    ]);
  });

  it("without a page resolver every page link is text", () => {
    expect(renderMarkdown("[a](keyboard.md)")).toEqual([{ type: "paragraph", children: [text("a")] }]);
  });
});

describe("helpers", () => {
  it("isWebUrl accepts http(s) only", () => {
    expect(isWebUrl("https://a.b")).toBe(true);
    expect(isWebUrl("HtTp://a.b")).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///c:/x", "https://", "https://a b", "ftp://a.b", " https://a.b", "keyboard.md", "https://a\u0085b", "https://a\u009fb"]) {
      expect(isWebUrl(url), url).toBe(false);
    }
  });

  it("linkTarget names the current page for a bare #heading, and nothing without one", () => {
    expect(linkTarget("#x", { currentPage: "keyboard" })).toEqual({ kind: "page", page: "keyboard", anchor: "x" });
    expect(linkTarget("#x")).toBeNull();
    expect(linkTarget("")).toBeNull();
  });

  it("slugify and plainText", () => {
    expect(slugify("  Keyboard & palette ")).toBe("keyboard--palette");
    expect(slugify("Tabs, pop-outs_2")).toBe("tabs-pop-outs_2");
    expect(plainText([text("a "), { type: "strong", children: [text("b")] }, { type: "code", text: "c" }])).toBe("a bc");
  });
});
