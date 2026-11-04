// The help renderer (Story 10.1): a Markdown subset turned into a plain tree the Help pane maps
// to React elements. Never HTML: nothing here produces markup, and the pane never uses
// `innerHTML`. Supported are headings (with a slug id), paragraphs, bullet and numbered lists,
// emphasis and strong emphasis, inline code, fenced and indented code blocks, and links. A link
// is a page link (`keyboard.md`, `keyboard.md#palette`, `#palette`) when it names a known page,
// a web link when it is `http://` or `https://`, and plain text otherwise (an unknown page, a
// `javascript:` or `file:` URL). Everything else -- raw HTML, images, block quotes, rules,
// autolinks, reference links -- becomes its own source text, shown literally.
//
// `@lezer/markdown` (CommonMark) does the parsing; this walks its syntax tree. Pure: no DOM, so
// vitest runs it in node.

import { parser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";

/** Where a link goes: a page in the pane (with an optional heading), or the system browser. */
export type HelpLinkTarget = { kind: "page"; page: string; anchor: string | null } | { kind: "web"; url: string };

/** One node of a rendered help page. */
export type HelpNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; id: string; children: HelpNode[] }
  | { type: "paragraph"; children: HelpNode[] }
  | { type: "list"; ordered: boolean; children: HelpNode[] }
  | { type: "item"; children: HelpNode[] }
  | { type: "emphasis"; children: HelpNode[] }
  | { type: "strong"; children: HelpNode[] }
  | { type: "code"; text: string }
  | { type: "codeBlock"; text: string }
  /** Story 11.4: a fenced block with the info string `figure <name>`; `alt` is its text on one line. */
  | { type: "figure"; name: string; alt: string }
  | { type: "link"; target: HelpLinkTarget; children: HelpNode[] }
  | { type: "text"; text: string };

export type RenderOptions = {
  /** The page id a link to `file` (`keyboard.md`) opens, or `null` for an unknown page. */
  resolvePage?: (file: string) => string | null;
  /** The page being rendered: the target of a bare `#heading` link. */
  currentPage?: string | null;
};

/** `http://` or `https://` (any case) followed by something without spaces or control characters (C0, DEL, C1). */
const WEB_URL = /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/i;
/** `file.md`, `file.md#heading` or `#heading`, relative and in the same folder. */
const PAGE_URL = /^([A-Za-z0-9_-]+\.md)?(?:#([A-Za-z0-9_-]+))?$/;

/** True for a URL the pane may open in the system browser: `http://` or `https://` only. */
export function isWebUrl(url: string): boolean {
  return WEB_URL.test(url);
}

/**
 * The slug of a heading's text, as the page links name it: lower case, letters, digits and
 * hyphens, spaces turned into hyphens (`Keyboard & palette` → `keyboard--palette`, as GitHub does).
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

/** The link target `url` names, or `null` when it is neither a known page nor a web URL. */
export function linkTarget(url: string, options: RenderOptions = {}): HelpLinkTarget | null {
  if (isWebUrl(url)) return { kind: "web", url };
  const match = PAGE_URL.exec(url);
  if (match === null || url === "") return null;
  const [, file, anchor] = match;
  const page = file === undefined ? (options.currentPage ?? null) : (options.resolvePage?.(file) ?? null);
  if (page === null) return null;
  return { kind: "page", page, anchor: anchor ?? null };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** A figure's info string (Story 11.4): `figure`, whitespace, then the name, taken verbatim. */
const FIGURE_INFO = /^figure\s+(\S.*)$/;

/** Mark nodes carry syntax only: never shown. */
const MARKS = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "ListMark", "QuoteMark", "CodeInfo"]);

/** Render `src` (a help page's Markdown) to its node tree. */
export function renderMarkdown(src: string, options: RenderOptions = {}): HelpNode[] {
  const walker = new Walker(src, options);
  return walker.blocks(parser.parse(src).topNode);
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) out.push(child);
  return out;
}

class Walker {
  private readonly ids = new Map<string, number>();

  constructor(
    private readonly src: string,
    private readonly options: RenderOptions,
  ) {}

  private text(from: number, to: number): string {
    return this.src.slice(from, to);
  }

  /** The block children of a container (the document, a list item). */
  blocks(parent: SyntaxNode): HelpNode[] {
    const out: HelpNode[] = [];
    for (const node of children(parent)) {
      const block = this.block(node);
      if (block !== null) out.push(block);
    }
    return out;
  }

  private block(node: SyntaxNode): HelpNode | null {
    const name = node.name;
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
    if (heading !== null) {
      const inline = trimInline(this.inline(node, node.from, node.to));
      return { type: "heading", level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6, id: this.uniqueId(slugify(plainText(inline))), children: inline };
    }
    switch (name) {
      case "Paragraph":
        return { type: "paragraph", children: trimInline(this.inline(node, node.from, node.to)) };
      case "BulletList":
      case "OrderedList":
        return {
          type: "list",
          ordered: name === "OrderedList",
          children: children(node)
            .filter((item) => item.name === "ListItem")
            .map((item) => ({ type: "item", children: this.blocks(item) })),
        };
      case "FencedCode":
      case "CodeBlock": {
        const text = children(node)
          .filter((c) => c.name === "CodeText")
          .map((c) => this.text(c.from, c.to))
          .join("")
          .replace(/\n$/, "");
        // Story 11.4: `figure <name>` makes the block a figure, its text the alt text on one line.
        const info = node.getChild("CodeInfo");
        const figure = info === null ? null : FIGURE_INFO.exec(this.text(info.from, info.to));
        if (figure !== null) return { type: "figure", name: figure[1]!, alt: text.replace(/\s+/g, " ").trim() };
        return { type: "codeBlock", text };
      }
      default:
        if (MARKS.has(name)) return null;
        // HTMLBlock, CommentBlock, Blockquote, HorizontalRule, LinkReference, …: the source, as text.
        return { type: "paragraph", children: [{ type: "text", text: this.text(node.from, node.to) }] };
    }
  }

  /** The inline content of `node` between `from` and `to`: its child constructs, the text between them. */
  private inline(node: SyntaxNode, from: number, to: number): HelpNode[] {
    const out: HelpNode[] = [];
    let at = from;
    for (const child of children(node)) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > at) pushText(out, this.text(at, child.from));
      at = Math.max(at, child.to);
      if (MARKS.has(child.name)) continue;
      for (const n of this.inlineNode(child)) {
        if (n.type === "text") pushText(out, n.text);
        else out.push(n);
      }
    }
    if (at < to) pushText(out, this.text(at, to));
    return out;
  }

  private inlineNode(node: SyntaxNode): HelpNode[] {
    switch (node.name) {
      case "Emphasis":
        return [{ type: "emphasis", children: this.inline(node, node.from, node.to) }];
      case "StrongEmphasis":
        return [{ type: "strong", children: this.inline(node, node.from, node.to) }];
      case "InlineCode": {
        const marks = children(node).filter((c) => c.name === "CodeMark");
        const start = marks[0]?.to ?? node.from;
        const end = marks.length > 1 ? marks[marks.length - 1]!.from : node.to;
        return [{ type: "code", text: collapseCode(this.text(start, end)) }];
      }
      case "Link":
        return this.link(node);
      case "Escape":
        return [{ type: "text", text: this.text(node.from + 1, node.to) }];
      case "Entity": {
        const raw = this.text(node.from, node.to);
        return [{ type: "text", text: ENTITIES[raw] ?? raw }];
      }
      case "HardBreak":
        return [{ type: "text", text: " " }];
      default:
        // Image, HTMLTag, Autolink, Comment, ProcessingInstruction, …: the source, as text.
        return [{ type: "text", text: this.text(node.from, node.to) }];
    }
  }

  private link(node: SyntaxNode): HelpNode[] {
    const parts = children(node);
    const url = parts.find((c) => c.name === "URL");
    const marks = parts.filter((c) => c.name === "LinkMark");
    const open = marks[0];
    const close = marks[1];
    // A reference link (`[x][ref]`) or anything odd: the source, as text.
    if (url === undefined || open === undefined || close === undefined) return [{ type: "text", text: this.text(node.from, node.to) }];
    const label = this.inline(node, open.to, close.from);
    const raw = this.text(url.from, url.to).replace(/^<(.*)>$/, "$1");
    const target = linkTarget(raw, this.options);
    // An unknown page or a scheme that is never opened: the link text alone, as plain content.
    if (target === null) return label;
    return [{ type: "link", target, children: label }];
  }

  /** `slug`, or `slug-1`, `slug-2`… when an earlier heading on the page has it. */
  private uniqueId(slug: string): string {
    const base = slug === "" ? "section" : slug;
    const seen = this.ids.get(base);
    this.ids.set(base, (seen ?? 0) + 1);
    return seen === undefined ? base : `${base}-${seen}`;
  }
}

/** Soft line breaks (and a continuation line's indent) read as one space. */
function pushText(out: HelpNode[], text: string): void {
  const collapsed = text.replace(/[ \t]*\r?\n[ \t]*/g, " ");
  if (collapsed === "") return;
  const last = out[out.length - 1];
  if (last !== undefined && last.type === "text") out[out.length - 1] = { type: "text", text: last.text + collapsed };
  else out.push({ type: "text", text: collapsed });
}

/** CommonMark's inline code: line endings become spaces, one surrounding space each side is stripped. */
function collapseCode(text: string): string {
  const flat = text.replace(/\r?\n/g, " ");
  return /^ .*[^ ].* $/.test(flat) ? flat.slice(1, -1) : flat;
}

/** Leading and trailing whitespace of an inline run dropped (a heading's text after `#`). */
function trimInline(nodes: HelpNode[]): HelpNode[] {
  const out = [...nodes];
  const first = out[0];
  if (first?.type === "text") {
    const text = first.text.replace(/^\s+/, "");
    if (text === "") out.shift();
    else out[0] = { type: "text", text };
  }
  const last = out[out.length - 1];
  if (last?.type === "text") {
    const text = last.text.replace(/\s+$/, "");
    if (text === "") out.pop();
    else out[out.length - 1] = { type: "text", text };
  }
  return out;
}

/** The text of an inline run, without its markup (a heading's slug is made from it). */
export function plainText(nodes: readonly HelpNode[]): string {
  return nodes
    .map((node) => ("children" in node ? plainText(node.children) : node.type === "figure" ? node.alt : node.text))
    .join("");
}
