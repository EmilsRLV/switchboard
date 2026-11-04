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
vi.mock("../state/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/settings")>();
  const store = actual.useSettingsStore;
  const live = Object.assign(<T,>(select: (state: ReturnType<typeof store.getState>) => T) => select(store.getState()), store);
  return { ...actual, useSettingsStore: live };
});
// app_info, answered or refused per test (the real one rejects outside Tauri).
const appInfoMock = vi.hoisted(() => vi.fn());
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, appInfo: appInfoMock };
});

import { useUiStore } from "../state/ui";
import { useSettingsStore } from "../state/settings";
import type { SettingsSnapshot } from "../ipc";
import { registerBuiltins } from "../commands/builtins";
import { applyBindingOverrides, clearCommands } from "../commands/registry";
import HelpPane, { Block, configFolder, loadAppVersion, resetKnownVersion, VersionFooter } from "./HelpPane";

function show(page: string | null): string {
  useUiStore.setState({ pane: "help", helpPage: page, helpAnchor: null });
  return renderToStaticMarkup(<HelpPane />);
}

describe("HelpPane", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    resetKnownVersion();
    appInfoMock.mockReset();
    appInfoMock.mockRejectedValue(new Error("no Tauri runtime"));
  });
  afterEach(() => {
    clearCommands();
    resetKnownVersion();
  });

  it("Story 10.4: once app_info answers, Contents reads Switchboard <version>", async () => {
    appInfoMock.mockResolvedValue({ name: "switchboard", version: "9.9.9" });
    expect(await loadAppVersion()).toBe("9.9.9");
    expect(show(null)).toContain('<div class="help-version-name">Switchboard 9.9.9</div>');
  });

  it("Story 10.4: when app_info fails, the helper gives null without throwing and the line reads Switchboard", async () => {
    await expect(loadAppVersion()).resolves.toBeNull();
    expect(show(null)).toContain('<div class="help-version-name">Switchboard</div>');
  });

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
    expect(html).toContain('<button type="button" class="checklist-step" title="Open the command palette · ctrl+k">Open the command palette</button>');
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

  it("Story 11.4: the Edges page draws the draw-edge and edge-kinds figures under their section headings", () => {
    const html = show("edges");
    const drawing = html.indexOf('id="help-drawing-and-finding-edges"');
    const drawEdge = html.indexOf('class="help-figure help-figure-draw-edge" role="img" aria-label="A hovered session node shows its handle');
    const seeing = html.indexOf('id="help-what-you-can-see"');
    const kinds = html.indexOf('class="help-figure help-figure-edge-kinds" role="img" aria-label="Five edges');
    expect(drawing).toBeGreaterThan(-1);
    expect(drawEdge).toBeGreaterThan(drawing);
    expect(seeing).toBeGreaterThan(drawEdge);
    expect(kinds).toBeGreaterThan(seeing);
    for (const label of ["context", "cooperate", "pending", "failed", "selected"]) {
      expect(html).toContain(`<span class="help-figure-label">${label}</span>`);
    }
    expect(html).not.toContain("figure draw-edge");
  });

  it("Story 11.4: each figure page draws its figure", () => {
    expect(show("projects")).toContain('class="help-figure help-figure-node-anatomy"');
    expect(show("sessions")).toContain('class="help-figure help-figure-session-states"');
    expect(show("canvas")).toContain('class="help-figure help-figure-panes"');
  });

  it("Story 11.4: a figure with an unknown or odd name shows its alt text as a code block, never markup", () => {
    const unknown = renderToStaticMarkup(<Block node={{ type: "figure", name: "nope", alt: "Drag the handle" }} />);
    expect(unknown).toBe('<pre class="help-pre">Drag the handle</pre>');
    const odd = renderToStaticMarkup(<Block node={{ type: "figure", name: "<b>x</b>", alt: "<i>alt</i>" }} />);
    expect(odd).toBe('<pre class="help-pre">&lt;i&gt;alt&lt;/i&gt;</pre>');
    const proto = renderToStaticMarkup(<Block node={{ type: "figure", name: "constructor", alt: "x" }} />);
    expect(proto).toBe('<pre class="help-pre">x</pre>');
    const known = renderToStaticMarkup(<Block node={{ type: "figure", name: "edge-kinds", alt: "Five edges" }} />);
    expect(known.startsWith('<div class="help-figure help-figure-edge-kinds" role="img" aria-label="Five edges">')).toBe(true);
  });

  it("Story 11.5: a table with an unknown or odd name shows its text as a code block, never markup", () => {
    expect(renderToStaticMarkup(<Block node={{ type: "table", name: "nope", text: "The rows" }} />)).toBe('<pre class="help-pre">The rows</pre>');
    expect(renderToStaticMarkup(<Block node={{ type: "table", name: "<b>x</b>", text: "<i>y</i>" }} />)).toBe(
      '<pre class="help-pre">&lt;i&gt;y&lt;/i&gt;</pre>',
    );
    expect(renderToStaticMarkup(<Block node={{ type: "table", name: "constructor", text: "x" }} />)).toBe('<pre class="help-pre">x</pre>');
  });

  it("Story 11.5: What you see is second in Contents and draws each figure above its table", () => {
    const rows = [...show(null).matchAll(/class="help-contents-row">([^<]*)</g)].map((m) => m[1]);
    expect(rows.slice(0, 2)).toEqual(["Canvas &amp; navigation", "What you see"]);
    const html = show("legend");
    const order = [
      html.indexOf('class="help-figure help-figure-session-states"'),
      html.indexOf('aria-label="The session states and what each means."'),
      html.indexOf('id="help-colour-glow-and-badges"'),
      html.indexOf('class="help-figure help-figure-edge-kinds"'),
      html.indexOf('aria-label="The edge looks and what each means."'),
    ];
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Claude needs an answer; enter opens its terminal");
    expect(html).not.toContain("table session-states");
  });

  it("Story 10.4: Contents lists Getting started, Changelog and Roadmap last", () => {
    const html = show(null);
    const rows = [...html.matchAll(/class="help-contents-row">([^<]*)</g)].map((m) => m[1]);
    expect(rows.slice(-3)).toEqual(["Getting started", "Changelog", "Roadmap"]);
  });

  it("Story 10.4: the Changelog and Roadmap pages render through the guide renderer", () => {
    const changelog = show("changelog");
    expect(changelog).toContain('aria-label="Changelog"');
    expect(changelog).toContain(">Unreleased</h4>");
    const roadmap = show("roadmap");
    for (const heading of ["Next", "Later", "Known limitations", "Not planned"]) expect(roadmap).toContain(`>${heading}</h4>`);
  });

  it("Story 10.4: under Contents, Switchboard and the config folder in mono; the folder left out with no settings path", () => {
    useSettingsStore.setState({ snapshot: { path: "C:\\Users\\me\\AppData\\Roaming\\switchboard\\settings.json" } as SettingsSnapshot });
    const html = show(null);
    // app_info has not answered (no Tauri here): the line reads Switchboard, with no error.
    expect(html).toContain('<div class="help-version-name">Switchboard</div>');
    expect(html).toContain('<div class="help-version-folder" title="Config folder">C:\\Users\\me\\AppData\\Roaming\\switchboard</div>');
    expect(html).not.toContain("pane-error");
    useSettingsStore.setState({ snapshot: { path: null } as unknown as SettingsSnapshot });
    expect(show(null)).not.toContain("help-version-folder");
    useSettingsStore.setState({ snapshot: null });
    expect(show(null)).not.toContain("help-version-folder");
    expect(show("canvas")).not.toContain("help-version");
  });

  it("Story 10.4: the footer shows the version when given", () => {
    expect(renderToStaticMarkup(<VersionFooter version="0.1.0" folder="/home/me/.config/switchboard" />)).toBe(
      '<footer class="help-version"><div class="help-version-name">Switchboard 0.1.0</div>' +
        '<div class="help-version-folder" title="Config folder">/home/me/.config/switchboard</div></footer>',
    );
    expect(renderToStaticMarkup(<VersionFooter version="0.1.0" folder={null} />)).toBe(
      '<footer class="help-version"><div class="help-version-name">Switchboard 0.1.0</div></footer>',
    );
    expect(renderToStaticMarkup(<VersionFooter version={null} folder={null} />)).toContain(">Switchboard</div>");
  });

  it("configFolder cuts the settings path at its last separator", () => {
    expect(configFolder("C:\\Users\\me\\AppData\\Roaming\\switchboard\\settings.json")).toBe("C:\\Users\\me\\AppData\\Roaming\\switchboard");
    expect(configFolder("/home/me/.config/switchboard/settings.json")).toBe("/home/me/.config/switchboard");
    expect(configFolder("/settings.json")).toBe("/");
    expect(configFolder("settings.json")).toBeNull();
    expect(configFolder(null)).toBeNull();
    expect(configFolder(undefined)).toBeNull();
  });
});
