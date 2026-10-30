import { describe, expect, it } from "vitest";
import type { CanvasTarget } from "../canvas/nodes";
import type { Pane } from "../state/ui";
import { helpPageFor } from "./context";
import { HELP_PAGES } from "./pages";

describe("helpPageFor (F1 from where you are)", () => {
  it("an open pane names its page, whatever is selected", () => {
    const rows: [Pane, string][] = [
      ["launch", "sessions"],
      ["terminal", "terminals"],
      ["edge", "edges"],
      ["review", "review"],
      ["import", "projects"],
      ["settings", "settings"],
      ["worktree", "branches"],
      ["removeWorktree", "branches"],
    ];
    for (const [pane, page] of rows) {
      expect(helpPageFor({ pane, selection: null, lastRead: null }), pane).toBe(page);
      expect(helpPageFor({ pane, selection: { kind: "project", id: "p" }, lastRead: "keyboard" }), pane).toBe(page);
    }
  });

  it("with no pane, the selection names its page", () => {
    const rows: [CanvasTarget, string][] = [
      [{ kind: "project", id: "p" }, "projects"],
      [{ kind: "session", id: "s" }, "sessions"],
      [{ kind: "branch", id: "b" }, "branches"],
      [{ kind: "edge", id: "e" }, "edges"],
    ];
    for (const [selection, page] of rows) {
      expect(helpPageFor({ pane: null, selection, lastRead: "keyboard" }), selection.kind).toBe(page);
    }
  });

  it("otherwise the page last read this run, else Contents", () => {
    expect(helpPageFor({ pane: null, selection: null, lastRead: null })).toBeNull();
    expect(helpPageFor({ pane: null, selection: null, lastRead: "keyboard" })).toBe("keyboard");
    expect(helpPageFor({ pane: null, selection: { kind: "more", id: "p" }, lastRead: null })).toBeNull();
    expect(helpPageFor({ pane: null, selection: { kind: "more", id: "p", group: "branches" }, lastRead: "edges" })).toBe("edges");
    expect(helpPageFor({ pane: "help", selection: { kind: "project", id: "p" }, lastRead: "review" })).toBe("review");
  });

  it("every page it names is a guide page", () => {
    const ids = new Set(HELP_PAGES.map((p) => p.id));
    const panes: Pane[] = ["launch", "terminal", "edge", "review", "import", "settings", "worktree", "removeWorktree"];
    for (const pane of panes) expect(ids.has(helpPageFor({ pane, selection: null, lastRead: null })!), pane).toBe(true);
    for (const kind of ["project", "session", "branch", "edge"] as const) {
      expect(ids.has(helpPageFor({ pane: null, selection: { kind, id: "x" }, lastRead: null })!), kind).toBe(true);
    }
  });
});
