import { describe, expect, it } from "vitest";
import { HELP_PAGES, helpPage, pageIdOfFile, renderHelpPage } from "./pages";
import { plainText, type HelpNode } from "./markdown";

/** Every node of a tree, depth first. */
function all(nodes: readonly HelpNode[]): HelpNode[] {
  return nodes.flatMap((node) => [node, ...("children" in node ? all(node.children) : [])]);
}

describe("the guide pages", () => {
  it("are the two pages of Story 10.1, in order, each opening with its title as the heading", () => {
    expect(HELP_PAGES.map((p) => [p.id, p.title, p.file])).toEqual([
      ["canvas", "Canvas & navigation", "canvas.md"],
      ["keyboard", "Keyboard & palette", "keyboard.md"],
    ]);
    for (const page of HELP_PAGES) {
      const [first] = renderHelpPage(page);
      expect(first?.type, page.id).toBe("heading");
      expect(first?.type === "heading" && plainText(first.children), page.id).toBe(page.title);
      const words = page.source.split(/\s+/).filter(Boolean).length;
      expect(words, page.id).toBeGreaterThanOrEqual(150);
      expect(words, page.id).toBeLessThanOrEqual(400);
    }
    expect(helpPage("keyboard")?.title).toBe("Keyboard & palette");
    expect(helpPage(null)).toBeNull();
    expect(pageIdOfFile("canvas.md")).toBe("canvas");
    expect(pageIdOfFile("nope.md")).toBeNull();
  });

  it("every page link resolves to a page and a heading on it", () => {
    const ids = new Map(HELP_PAGES.map((p) => [p.id, all(renderHelpPage(p)).flatMap((n) => (n.type === "heading" ? [n.id] : []))]));
    let links = 0;
    for (const page of HELP_PAGES) {
      for (const node of all(renderHelpPage(page))) {
        if (node.type !== "link" || node.target.kind !== "page") continue;
        links++;
        expect(ids.has(node.target.page), node.target.page).toBe(true);
        if (node.target.anchor !== null) expect(ids.get(node.target.page), node.target.anchor).toContain(node.target.anchor);
      }
    }
    expect(links).toBeGreaterThan(0);
  });

  it("the Keyboard page says F1 goes to a focused terminal and ctrl+shift+k → Help still works there", () => {
    const source = helpPage("keyboard")!.source;
    expect(source).toMatch(/`f1`[^.]*go to the terminal/);
    expect(source).toContain("`ctrl+shift+k`");
    expect(source).toContain("**Help**");
  });
});
