import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { CHANGELOG_PAGE } from "../commands/help";
import { useUiStore } from "../state/ui";
import { clearCommands } from "../commands/registry";
import type { AppStateSnapshot } from "../ipc";
import type { ElsewhereRow } from "../ipc";
import { resetWhatsNew, useWhatsNewStore } from "../state/whatsNew";
import { ElsewhereTrayView } from "./ElsewhereTray";
import { chipVersion, WhatsNewChipView } from "./WhatsNewChip";

function snapshot(lastSeenVersion: string | null, version = "0.2.0", firstRun = false): AppStateSnapshot {
  return { firstRun, checklist: { shown: false, dismissed: false, done: [] }, version, lastSeenVersion };
}

const ROW = { session_id: "s1", name: "x", cwd: "/w/other", state: { kind: "idle" } } as unknown as ElsewhereRow;

/** The canvas's bottom-left row as `App` renders it, from the stores' state. */
function cornerRow(rows: readonly ElsewhereRow[], open: boolean): string {
  const version = chipVersion(useWhatsNewStore.getState());
  return renderToStaticMarkup(
    <div className="corner-row">
      <ElsewhereTrayView rows={rows} open={open} />
      {version !== null && <WhatsNewChipView version={version} />}
    </div>,
  );
}

// `?raw` CSS is empty under vitest; read the file as the design lint does (a non-literal
// specifier keeps `tsc` from looking for Node's typings).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const CSS = fs.readFileSync(new URL("./shell.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf("}", start));
}

describe("the what's-new chip (Story 10.5)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    resetWhatsNew();
  });
  afterEach(() => clearCommands());

  it("is a button reading new in <version>, with the corner chip's look", () => {
    const html = renderToStaticMarkup(<WhatsNewChipView version="0.2.0" />);
    expect(html).toBe('<button type="button" class="corner-chip whats-new-chip" title="Open the changelog">new in 0.2.0</button>');
  });

  it("clicking it runs What's new: Help shows the Changelog and the chip goes", () => {
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, helpPage: null, helpAnchor: null, helpReturn: null, helpLastRead: null });
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    const element = WhatsNewChipView({ version: "0.2.0" });
    (element.props as { onClick: () => void }).onClick();
    expect(useUiStore.getState()).toMatchObject({ pane: "help", helpPage: CHANGELOG_PAGE });
    expect(useWhatsNewStore.getState().show).toBe(false);
    expect(chipVersion(useWhatsNewStore.getState())).toBeNull();
  });

  it("shows only while the store says so", () => {
    expect(chipVersion(useWhatsNewStore.getState())).toBeNull();
    useWhatsNewStore.getState().load(snapshot("0.2.0", "0.2.0", true));
    expect(chipVersion(useWhatsNewStore.getState())).toBeNull();
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    expect(chipVersion(useWhatsNewStore.getState())).toBe("0.2.0");
    useWhatsNewStore.getState().markSeen();
    expect(chipVersion(useWhatsNewStore.getState())).toBeNull();
  });

  it("sits beside the Elsewhere chip in one bottom-left row; alone it takes the corner", () => {
    useWhatsNewStore.getState().load(snapshot("0.1.0"));
    expect(cornerRow([], false)).toBe('<div class="corner-row"><button type="button" class="corner-chip whats-new-chip" title="Open the changelog">new in 0.2.0</button></div>');

    const html = cornerRow([ROW], false);
    expect(html).toMatch(
      /^<div class="corner-row"><div class="elsewhere"><button type="button" class="corner-chip elsewhere-chip" aria-expanded="false"[^>]*>elsewhere 1<\/button><\/div><button type="button" class="corner-chip whats-new-chip"/,
    );

    // The tray still opens: its list above its own chip, inside the same row.
    expect(cornerRow([ROW], true)).toMatch(/<div class="elsewhere"><ul class="elsewhere-list"[^>]*>.*<\/ul><button type="button" class="corner-chip elsewhere-chip" aria-expanded="true"/);
  });

  it("the corner row holds the position; the chips share the muted mono look; no accent, no motion", () => {
    const row = rule(".corner-row");
    expect(row).toContain("position: absolute;");
    expect(row).toContain("left: 0.75rem;");
    expect(row).toContain("bottom: 0.75rem;");
    expect(row).toContain("align-items: flex-end;");
    expect(rule(".elsewhere")).not.toContain("position");
    const chip = rule(".corner-chip");
    for (const decl of ["font-family: var(--font-mono);", "font-size: var(--text-xs);", "color: var(--fg-muted);", "border: var(--line) solid var(--border);", "border-radius: var(--radius-sm);"]) {
      expect(chip).toContain(decl);
    }
    expect(CSS).toContain(".corner-chip:hover");
    expect(CSS).toContain(".corner-chip:focus-visible");
    expect(CSS).not.toMatch(/whats-new[^{]*\{[^}]*(accent|animation|transition)/);
  });
});
