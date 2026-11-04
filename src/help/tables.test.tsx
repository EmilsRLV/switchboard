// The What you see tables (Story 11.5): their rows are the meanings' one table, drawn from code.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { applyBindingOverrides, clearCommands } from "../commands/registry";
import { edgeLooks } from "../canvas/edges";
import { stateMeaning, STATE_MEANING_KINDS } from "../canvas/nodes";
import { stateRows, tableFor, TABLES } from "./tables";

const SessionStates = TABLES["session-states"];
const EdgeLooks = TABLES["edge-looks"];

/** The rows of a rendered table: each cell's text, tags stripped. */
function cells(html: string): string[][] {
  const body = html.slice(html.indexOf("<tbody>"));
  return [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) => [...row[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => cell[1]!.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&")));
}

describe("the What you see tables", () => {
  beforeAll(() => {
    clearCommands();
    registerBuiltins();
  });
  afterAll(() => {
    applyBindingOverrides({});
    clearCommands();
  });

  it("session-states has one row per state: the word, then stateMeaning", () => {
    const html = renderToStaticMarkup(<SessionStates label="States" />);
    expect(html.startsWith('<table class="help-table help-legend" aria-label="States">')).toBe(true);
    expect(cells(html)).toEqual(STATE_MEANING_KINDS.map((kind) => [kind === "other" ? "any other word" : kind, stateMeaning(kind)]));
    expect(STATE_MEANING_KINDS).toEqual(["starting", "busy", "waiting", "finished", "idle", "stopping", "exited", "other"]);
  });

  it("draws each state word in its canvas look", () => {
    const tones = Object.fromEntries(stateRows().map((row) => [row.kind, [row.tone, row.dot]]));
    expect(tones).toEqual({
      starting: ["muted", false],
      busy: ["busy", true],
      waiting: ["attention", true],
      finished: ["attention", true],
      idle: ["muted", false],
      stopping: ["muted", false],
      exited: ["muted", false],
      other: ["muted", false],
    });
    const html = renderToStaticMarkup(<SessionStates label="States" />);
    expect(html).toContain('<span class="help-legend-word session-attention-word session-state"><span class="session-dot" aria-hidden="true"></span>waiting</span>');
    expect(html).toContain('<span class="help-legend-word session-state session-state-busy"><span class="session-dot" aria-hidden="true"></span>busy</span>');
  });

  it("edge-looks has one row per edge look, with edges.ts's words", () => {
    const html = renderToStaticMarkup(<EdgeLooks label="Edges" />);
    expect(cells(html)).toEqual(edgeLooks().map(({ look, meaning }) => [look, meaning]));
    expect(html).toContain("attention link-line link-context");
    expect(html).toContain('class="react-flow__edge is-pending"');
  });

  it("a rebind shows in the rows", () => {
    applyBindingOverrides({ "selection.activate": "ctrl+o" });
    try {
      expect(renderToStaticMarkup(<SessionStates label="States" />)).toContain("ctrl+o opens its terminal");
    } finally {
      applyBindingOverrides({});
    }
  });

  it("finds a table only by its exact name", () => {
    expect(tableFor("session-states")).toBe(TABLES["session-states"]);
    expect(tableFor("nope")).toBeNull();
    expect(tableFor("constructor")).toBeNull();
  });
});
