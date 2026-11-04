// The tour's stops (Story 11.6): the table, the static scan that every target id is a
// `data-tour` attribute in the app's markup (the command audit's pattern: sources read from disk),
// and that every figure a stop shows is in `FIGURES`.

import { describe, expect, it } from "vitest";
import { FIGURES } from "./figures";
import { fallbackPlace, forcedOn, placeOf, stepText, targetSelector, TOUR_STOP_COUNT, TOUR_STOPS, TOUR_TARGET_IDS } from "./tour";

type Fs = {
  readdirSync(path: URL, options: { recursive: true }): string[];
  readFileSync(path: URL, encoding: "utf8"): string;
};
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const SRC = new URL("../", import.meta.url);

/** Every `.tsx` under `src/` (tests aside). */
function markupSources(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true })
    .map((entry) => entry.replace(/\\/g, "/"))
    .filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
    .map((path) => fs.readFileSync(new URL(path, SRC), "utf8"));
}

/** `data-tour="id"`, or `data-tour={… "id" …}` (an attribute set only on the first card). */
function hasTarget(source: string, id: string): boolean {
  const quoted = id.replace(/[-]/g, "\\-");
  return new RegExp(`data-tour=(?:"${quoted}"|\\{[^}]*"${quoted}"[^}]*\\})`).test(source);
}

describe("the tour's stops (Story 11.6)", () => {
  it("has the six stops in order, each with a title and one or two sentences", () => {
    expect(TOUR_STOPS.map((s) => s.title)).toEqual([
      "The canvas",
      "Add a project",
      "Start a session",
      "Link nodes",
      "Read the canvas",
      "Everything is a command",
    ]);
    expect(TOUR_STOP_COUNT).toBe(6);
    expect(new Set(TOUR_STOPS.map((s) => s.id)).size).toBe(6);
    for (const stop of TOUR_STOPS) {
      const text = stop.text.map((p) => (typeof p === "string" ? p : "KEY")).join("");
      const sentences = text.split(/[.;]\s/).length;
      expect(sentences, stop.id).toBeLessThanOrEqual(3);
      expect(text.trim().endsWith("."), stop.id).toBe(true);
    }
    expect(TOUR_STOPS[0]!.text).toEqual(["Projects are cards; sessions and branches hang under them."]);
  });

  it("names the spec's keys: ctrl+o, ctrl+j, ctrl+k and f1 by their commands", () => {
    const keys = (i: number) => TOUR_STOPS[i]!.text.flatMap((p) => (typeof p === "string" ? [] : [p.key]));
    expect(keys(1)).toEqual(["project.add"]);
    expect(TOUR_STOPS[1]!.text.join("")).toContain("drop a folder");
    expect(keys(4)).toEqual(["attention.next"]);
    expect(keys(5)).toEqual(["palette.toggle", "help.toggle"]);
  });

  it("every target id is a data-tour attribute in the markup under src/ (static scan)", () => {
    const sources = markupSources();
    expect(sources.length).toBeGreaterThan(20);
    for (const id of TOUR_TARGET_IDS) {
      expect(sources.some((s) => hasTarget(s, id)), id).toBe(true);
    }
    const used = new Set(TOUR_STOPS.flatMap((s) => [s.empty.target, s.projects.target]).filter((t) => t !== undefined));
    expect([...used].sort()).toEqual([...TOUR_TARGET_IDS].sort());
    // The scan itself: a planted attribute is found, a missing one is not.
    expect(hasTarget('<div data-tour="ghost">', "ghost")).toBe(true);
    expect(hasTarget('<b data-tour={first ? "toolbar-new" : undefined} />', "toolbar-new")).toBe(true);
    expect(hasTarget('<div data-tour="ghostly">', "ghost")).toBe(false);
  });

  it("every figure a stop shows is in FIGURES, and a figure stop has alt text", () => {
    for (const stop of TOUR_STOPS) {
      for (const place of [stop.empty, stop.projects]) {
        if (place.figure === undefined) continue;
        expect(Object.keys(FIGURES), stop.id).toContain(place.figure);
        expect(stop.figureAlt, stop.id).toBeTruthy();
      }
    }
  });

  it("empty canvas: stops 1–2 target the ghost card, stops 3–4 show figures, nothing forced", () => {
    expect(placeOf(0, false)).toEqual({ target: "ghost" });
    expect(placeOf(1, false)).toEqual({ target: "ghost" });
    expect(placeOf(2, false)).toEqual({ figure: "node-anatomy" });
    expect(placeOf(3, false)).toEqual({ figure: "draw-edge" });
    expect(placeOf(4, false)).toEqual({ figure: "session-states" });
    expect(placeOf(5, false)).toEqual({});
    for (let i = 0; i < TOUR_STOP_COUNT; i++) expect(forcedOn(i, false)).toBeNull();
  });

  it("with a project: the canvas, the first card, its toolbar's new (forced shown), its handle (forced shown)", () => {
    expect(placeOf(0, true)).toEqual({ target: "canvas" });
    expect(placeOf(1, true)).toEqual({ target: "project" });
    expect(placeOf(2, true)).toEqual({ target: "toolbar-new" });
    expect(placeOf(3, true)).toEqual({ target: "handle" });
    expect(placeOf(4, true)).toEqual({ figure: "session-states" });
    expect(placeOf(5, true)).toEqual({});
    expect([0, 1, 2, 3, 4, 5].map((i) => forcedOn(i, true))).toEqual([null, null, "toolbar", "handle", null, null]);
    expect(placeOf(9, true)).toEqual({});
  });

  it("a missing target falls back to no target, with the empty canvas's figure", () => {
    expect(fallbackPlace(2)).toEqual({ figure: "node-anatomy" });
    expect(fallbackPlace(3)).toEqual({ figure: "draw-edge" });
    expect(fallbackPlace(0)).toEqual({});
  });

  it("the step text and the selector", () => {
    expect(stepText(1)).toBe("2 / 6");
    expect(targetSelector("toolbar-new")).toBe('[data-tour="toolbar-new"]');
  });
});
