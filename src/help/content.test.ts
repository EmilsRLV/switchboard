// The help-content test (Story 10.2): keeps the guide pages honest. Every `docs/help/*.md` is in
// the page table and every listed file exists; no page holds raw HTML or an image; every page
// link and `#heading` resolves; every key a page names in a code span is the default binding of
// some registered command, so a page cannot drift from the keys the app really has.

import { parser } from "@lezer/markdown";
import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltins } from "../commands/builtins";
import { parseKeybinding, type Keybinding } from "../commands/keybindings";
import { clearCommands, listCommands } from "../commands/registry";
import { HELP_PAGES, pageIdOfFile, renderHelpPage } from "./pages";
import { isWebUrl, type HelpNode } from "./markdown";

/** The slice of `node:fs` the test reads with (the project has no Node typings), as the audit does. */
type Fs = { readdirSync(path: URL): string[]; readFileSync(path: URL, encoding: "utf8"): string };
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const HELP_DIR = new URL("../../docs/help/", import.meta.url);
const REPO_ROOT = new URL("../../", import.meta.url);
/** The pages that are files at the repo root, not in `docs/help/` (Story 10.4). */
const ROOT_FILES = ["CHANGELOG.md", "ROADMAP.md"];

/** Every node of a rendered tree, depth first. */
function all(nodes: readonly HelpNode[]): HelpNode[] {
  return nodes.flatMap((node) => [node, ...("children" in node ? all(node.children) : [])]);
}

/** Each syntax node of `src` as (name, text). */
function syntaxNodes(src: string): { name: string; text: string; url: string | null }[] {
  const out: { name: string; text: string; url: string | null }[] = [];
  const cursor = parser.parse(src).cursor();
  do {
    const node = cursor.node;
    const urlNode = node.getChild("URL");
    out.push({ name: node.name, text: src.slice(node.from, node.to), url: urlNode === null ? null : src.slice(urlNode.from, urlNode.to) });
  } while (cursor.next());
  return out;
}

/** Named keys a code span may be (besides spans with `+` and single characters). */
const NAMED_KEYS = new Set([
  "esc",
  "escape",
  "enter",
  "delete",
  "tab",
  "space",
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** True when a code span's text names a key, by the Story 10.2 rule. */
function isKeySpan(text: string): boolean {
  return text.includes("+") || [...text].length === 1 || NAMED_KEYS.has(text.toLowerCase());
}

/** The text inside an inline code span (its backticks and padding stripped). */
function codeText(span: string): string {
  const ticks = /^`+/.exec(span)?.[0].length ?? 1;
  const inner = span.slice(ticks, span.length - ticks);
  return /^ .* $/.test(inner) && inner.trim() !== "" ? inner.slice(1, -1) : inner;
}

const sameKey = (a: Keybinding, b: Keybinding) => a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.key === b.key;

describe("the help content", () => {
  let defaults: Keybinding[] = [];
  beforeAll(() => {
    clearCommands();
    registerBuiltins();
    defaults = listCommands().flatMap((c) => (c.defaultBinding === null ? [] : [c.defaultBinding]));
    clearCommands();
  });

  it("lists every docs/help page, and every listed page exists", () => {
    const files = fs.readdirSync(HELP_DIR).filter((f) => f.endsWith(".md")).sort();
    expect(HELP_PAGES.map((p) => p.file).filter((f) => !ROOT_FILES.includes(f)).sort()).toEqual(files);
    expect(new Set(HELP_PAGES.map((p) => p.id)).size).toBe(HELP_PAGES.length);
  });

  it("lists the changelog and roadmap, and they are the repo root's files", () => {
    for (const file of ROOT_FILES) {
      const page = HELP_PAGES.find((p) => p.file === file);
      expect(page, file).toBeDefined();
      expect(page!.source, file).toBe(fs.readFileSync(new URL(file, REPO_ROOT), "utf8"));
    }
    expect(HELP_PAGES.slice(-3).map((p) => p.id)).toEqual(["getting-started", "changelog", "roadmap"]);
  });

  it("no page contains raw HTML or an image", () => {
    for (const page of HELP_PAGES) {
      const bad = syntaxNodes(page.source).filter((n) => n.name === "HTMLBlock" || n.name === "HTMLTag" || n.name === "Image");
      expect(bad.map((n) => n.text), page.file).toEqual([]);
    }
  });

  it("every page link and #heading resolves", () => {
    const headings = new Map(HELP_PAGES.map((p) => [p.id, all(renderHelpPage(p)).flatMap((n) => (n.type === "heading" ? [n.id] : []))]));
    for (const page of HELP_PAGES) {
      for (const link of syntaxNodes(page.source).filter((n) => n.name === "Link")) {
        expect(link.url, `${page.file}: ${link.text}`).not.toBeNull();
        const url = link.url!;
        if (isWebUrl(url)) continue;
        const match = /^([A-Za-z0-9_-]+\.md)?(?:#([A-Za-z0-9_-]+))?$/.exec(url);
        expect(match, `${page.file}: ${url}`).not.toBeNull();
        const [, file, anchor] = match!;
        const target = file === undefined ? page.id : pageIdOfFile(file);
        expect(target, `${page.file}: ${url}`).not.toBeNull();
        if (anchor !== undefined) expect(headings.get(target!), `${page.file}: ${url}`).toContain(anchor);
      }
    }
  });

  it("every key a page names is the default binding of some registered command", () => {
    let keys = 0;
    for (const page of HELP_PAGES) {
      for (const span of syntaxNodes(page.source).filter((n) => n.name === "InlineCode")) {
        const text = codeText(span.text);
        if (!isKeySpan(text)) continue;
        keys++;
        let parsed: Keybinding | null = null;
        try {
          parsed = parseKeybinding(text);
        } catch {
          parsed = null;
        }
        expect(parsed !== null && defaults.some((d) => sameKey(d, parsed!)), `${page.file}: \`${text}\` is no command's default key`).toBe(
          true,
        );
      }
    }
    expect(keys).toBeGreaterThan(0);
  });

  it("the no-HTML rule catches raw HTML and an image, as in a root file", () => {
    const names = syntaxNodes("# Roadmap\n\n- <b>soon</b>\n- ![x](y.png)\n").map((n) => n.name);
    expect(names).toContain("HTMLTag");
    expect(names).toContain("Image");
  });

  it("the key rule: spans with +, single characters and named keys are keys; other spans are not", () => {
    for (const k of ["ctrl+k", "n", "esc", "F1", "pagedown", "ctrl+`"]) expect(isKeySpan(k), k).toBe(true);
    for (const t of ["busy", "keybindings.json", "null", "N new"]) expect(isKeySpan(t), t).toBe(false);
    expect(codeText("`` ctrl+` ``")).toBe("ctrl+`");
    expect(codeText("`ctrl+k`")).toBe("ctrl+k");
  });
});
