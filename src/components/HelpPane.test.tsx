import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Server rendering reads a zustand store's initial state; read the live state instead, so a test
// can set the page the pane shows.
vi.mock("../state/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/ui")>();
  const store = actual.useUiStore;
  const live = Object.assign(<T,>(select: (state: ReturnType<typeof store.getState>) => T) => select(store.getState()), store);
  return { ...actual, useUiStore: live };
});

import { useUiStore } from "../state/ui";
import { registerBuiltins } from "../commands/builtins";
import { applyBindingOverrides, clearCommands } from "../commands/registry";
import HelpPane from "./HelpPane";

function show(page: string | null): string {
  useUiStore.setState({ pane: "help", helpPage: page, helpAnchor: null });
  return renderToStaticMarkup(<HelpPane />);
}

describe("HelpPane", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
  });
  afterEach(() => clearCommands());

  it("on Contents lists the guide pages as rows, with no ← Contents", () => {
    const html = show(null);
    expect(html).toContain('class="help-contents-row"');
    expect(html).toContain("Canvas &amp; navigation");
    expect(html).toContain("Keyboard &amp; palette");
    expect(html).not.toContain("← Contents");
  });

  it("the Keyboard page shows the effective keys after keybindings.json, and — for an unbound command", () => {
    applyBindingOverrides({ "help.toggle": "ctrl+h", "attention.next": null });
    const html = show("keyboard");
    expect(html).toContain("← Contents");
    expect(html).toContain('class="help-link"');
    const keyOnly = html.slice(html.indexOf("Key-only commands"));
    expect(html.indexOf("Key-only commands")).toBeGreaterThan(0);
    expect(keyOnly).toMatch(/<td>Toggle help<\/td><td><kbd class="help-key">ctrl\+h<\/kbd><\/td>/);
    expect(html).toMatch(/<td>Go to session that needs you<\/td><td>—<\/td>/);
    expect(html).not.toContain(">f1</kbd>");
  });

  it("the Getting started page (Story 10.3) ends with the live checklist and Show on canvas", () => {
    const html = show("getting-started");
    expect(html).toContain('aria-label="Your progress"');
    expect(html.match(/<li class="checklist-row/g)).toHaveLength(6);
    expect(html).toContain('<button type="button" class="checklist-step">Open the command palette</button>');
    expect(html).toContain(">Show on canvas</button>");
    expect(show("canvas")).not.toContain("Show on canvas");
  });

  it("Contents lists Getting started after the guide pages", () => {
    const html = show(null);
    expect(html.indexOf(">Getting started<")).toBeGreaterThan(html.indexOf(">Terms<"));
  });

  it("the Canvas page has no command table", () => {
    const html = show("canvas");
    expect(html).toContain("Canvas &amp; navigation");
    expect(html).not.toContain("help-table");
  });
});
