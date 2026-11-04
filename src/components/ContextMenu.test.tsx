import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { clearCommands } from "../commands/registry";
import { useCanvasStore, type CanvasInstance } from "../state/canvas";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { ContextMenu, ContextMenuPopup } from "./ContextMenu";

/** A mounted canvas with nothing on it: enough for the `when`s that need one. */
const canvas: CanvasInstance = {
  getNodes: () => [],
  getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  setViewport: async () => true,
  fitView: async () => true,
  screenToFlowPosition: (client) => client,
};

/** The menu's rows as `[title, key or null]`. */
function rows(html: string): [string, string | null][] {
  return [...html.matchAll(/<button[^>]*role="menuitem"[^>]*><span class="context-menu-title">([^<]*)<\/span>(?:<kbd class="palette-row-key">([^<]*)<\/kbd>)?<\/button>/g)].map(
    (match) => [match[1]!, match[2] ?? null],
  );
}

describe("the context menu (Story 11.1)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useCanvasStore.getState().setInstance(canvas);
    const project = { id: "ide", path: "/p/ide", label: "ide", position: { x: 0, y: 0 }, expanded: false, color: null, launchDefaults: null, showBranches: false };
    useWorkspaceStore.setState({ snapshot: { workspace: { projects: [project], edges: [] }, children: [] } as never });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false });
  });
  afterEach(() => {
    useCanvasStore.getState().setInstance(null);
    useUiStore.setState({ selection: null, contextMenu: null });
    clearCommands();
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(<ContextMenu />)).toBe("");
  });

  it("the canvas menu: the canvas rows with their keys, under Canvas actions", () => {
    const html = renderToStaticMarkup(<ContextMenuPopup at={{ x: 10, y: 20, menu: "canvas" }} />);
    expect(html).toContain('aria-label="Canvas actions"');
    expect(rows(html)).toEqual([
      ["Add project folder…", "ctrl+o"],
      ["Import from Claude…", null],
      ["Fit view", "ctrl+0"],
      ["Help", "f1"],
      ["Open settings", "ctrl+,"],
    ]);
    expect(html.match(/role="separator"/g)).toHaveLength(2);
  });

  it("the node menu: the selected node's rows, under Node actions", () => {
    useUiStore.setState({ selection: { kind: "project", id: "ide" } });
    const html = renderToStaticMarkup(<ContextMenuPopup at={{ x: 10, y: 20, menu: "node" }} />);
    expect(html).toContain('aria-label="Node actions"');
    const titles = rows(html).map(([title]) => title);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles).not.toContain("Fit view");
    expect(titles).not.toContain("Import from Claude…");
    expect(titles).toContain("Remove from canvas");
  });
});
