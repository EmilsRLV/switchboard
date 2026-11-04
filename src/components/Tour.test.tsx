import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { commandKey } from "../commands/keybindings";
import { applyBindingOverrides, clearBindingOverrides, clearCommands } from "../commands/registry";
import { resetTour, useTourStore } from "../state/tour";
import { CARD_GAP, CARD_MARGIN, cardKeyAction, cardPosition, dimRects, shownPlace, Tour, TourView, visiblePart, type Rect } from "./Tour";

const VIEWPORT = { width: 1200, height: 800 };
const CARD = { width: 360, height: 180 };

/** The area the rectangles cover (they never overlap). */
function area(rects: readonly Rect[]): number {
  return rects.reduce((sum, r) => sum + r.width * r.height, 0);
}

describe("the tour's layout (Story 11.6)", () => {
  it("the four dim rectangles cover the window around the cut-out, and all of it with none", () => {
    const hole = { left: 100, top: 200, width: 240, height: 80 };
    const rects = dimRects(hole, VIEWPORT);
    expect(area(rects) + hole.width * hole.height).toBe(VIEWPORT.width * VIEWPORT.height);
    expect(rects[0]).toEqual({ left: 0, top: 0, width: 1200, height: 200 });
    expect(rects[1]).toEqual({ left: 0, top: 280, width: 1200, height: 520 });
    expect(rects[2]).toEqual({ left: 0, top: 200, width: 100, height: 80 });
    expect(rects[3]).toEqual({ left: 340, top: 200, width: 860, height: 80 });
    expect(area(dimRects(null, VIEWPORT))).toBe(VIEWPORT.width * VIEWPORT.height);
  });

  it("a target is cut to the window, and one fully off screen is missing", () => {
    expect(visiblePart({ left: -20, top: 10, width: 100, height: 50 }, VIEWPORT)).toEqual({ left: 0, top: 10, width: 80, height: 50 });
    expect(visiblePart({ left: 1300, top: 10, width: 100, height: 50 }, VIEWPORT)).toBeNull();
    expect(visiblePart({ left: 10, top: 10, width: 0, height: 0 }, VIEWPORT)).toBeNull();
  });

  it("the card sits right of the cut-out, else left, else below, else centred, always CARD_MARGIN inside the window", () => {
    const right = { left: 100, top: 200, width: 240, height: 80 };
    expect(cardPosition(right, CARD, VIEWPORT)).toEqual({ x: 340 + CARD_GAP, y: 200 });
    const left = { left: 900, top: 200, width: 240, height: 80 };
    expect(cardPosition(left, CARD, VIEWPORT)).toEqual({ x: 900 - CARD_GAP - 360, y: 200 });
    const wide = { left: 100, top: 100, width: 1000, height: 300 };
    expect(cardPosition(wide, CARD, VIEWPORT)).toEqual({ x: 100, y: 400 + CARD_GAP });
    // The whole canvas: no side fits, so the card is centred (never flush in a corner).
    const canvas = { left: 0, top: 30, width: 1200, height: 770 };
    expect(cardPosition(canvas, CARD, VIEWPORT)).toEqual({ x: 420, y: 310 });
    // Low on the screen: kept CARD_MARGIN inside the bottom edge.
    expect(cardPosition({ left: 100, top: 750, width: 240, height: 40 }, CARD, VIEWPORT)).toEqual({ x: 352, y: 800 - 180 - CARD_MARGIN });
    // Near the top-left corner: kept CARD_MARGIN inside both edges.
    expect(cardPosition({ left: 1000, top: -50, width: 190, height: 60 }, CARD, VIEWPORT)).toEqual({ x: 1000 - CARD_GAP - 360, y: CARD_MARGIN });
    expect(cardPosition(null, CARD, VIEWPORT)).toEqual({ x: 420, y: 310 });
  });

  it("a missing target (stop 3, no toolbar in the DOM) falls back to no target and the figure", () => {
    expect(shownPlace(2, true, true)).toEqual({ target: "toolbar-new" });
    expect(shownPlace(2, true, false)).toEqual({ figure: "node-anatomy" });
    expect(shownPlace(0, true, false)).toEqual({});
    expect(shownPlace(4, true, false)).toEqual({ figure: "session-states" });
  });
});

describe("the tour as drawn (Story 11.6)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    resetTour();
  });
  afterEach(() => {
    clearBindingOverrides();
    clearCommands();
  });

  const view = (stop: number, hole: Rect | null, figure: "session-states" | null = null) =>
    renderToStaticMarkup(<TourView stop={stop} hole={hole} viewport={VIEWPORT} at={{ x: 10, y: 20 }} figure={figure} keyOf={commandKey} />);

  it("a stop with a target: the layer, four dim rectangles, the cut-out and the card with its counter and buttons", () => {
    const html = view(1, { left: 100, top: 200, width: 240, height: 80 });
    expect(html).toContain('<div class="tour-layer" aria-hidden="true">');
    expect(html.match(/class="tour-dim"/g)).toHaveLength(4);
    expect(html).toContain('<div class="tour-cutout" style="left:100px;top:200px;width:240px;height:80px"></div>');
    expect(html).toContain('class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" style="left:10px;top:20px"');
    expect(html).toContain('<h2 class="tour-title" id="tour-title">Add a project</h2>');
    expect(html).toContain('<p class="tour-text" id="tour-text">');
    expect(html).toContain('<kbd class="tour-kbd">ctrl+o</kbd>');
    expect(html).toContain('<span class="tour-step">2 / 6</span>');
    expect(html).toContain('title="Back · left">Back</button>');
    expect(html).toContain('title="Next · right">Next</button>');
    expect(html).toContain('title="Skip · esc">Skip</button>');
    // Stop 1's Back is disabled; the last stop's Next reads Finish.
    expect(view(0, null)).toMatch(/<button type="button" class="btn" data-command="tour.back" disabled="" title="Back · left">/);
    expect(view(5, null)).toContain(">Finish</button>");
    expect(view(5, null)).toContain('<kbd class="tour-kbd">ctrl+k</kbd> lists every command with its key; <kbd class="tour-kbd">f1</kbd> opens help for where you are.');
  });

  it("no target: no cut-out, the card centred; the step's keys follow a rebind", () => {
    const html = view(4, null);
    expect(html).not.toContain("tour-cutout");
    expect(html).toContain('class="tour-card is-centred"');
    expect(html).toContain('<kbd class="tour-kbd">ctrl+j</kbd>');
    applyBindingOverrides({ "attention.next": "ctrl+shift+j" });
    expect(view(4, null)).toContain('<kbd class="tour-kbd">ctrl+shift+j</kbd>');
    // Unbound: the command's title instead of a key.
    applyBindingOverrides({ "attention.next": null });
    expect(view(4, null)).toContain("Go to session that needs you goes there.");
  });

  it("the card's keys: Enter on a focused button runs its command; Tab and Shift+Tab wrap, from outside too", () => {
    const k = (key: string, shiftKey = false) => ({ key, shiftKey, ctrlKey: false, altKey: false, metaKey: false });
    expect(cardKeyAction(k("Enter"), "tour.skip", 2, 3)).toEqual({ run: "tour.skip" });
    expect(cardKeyAction(k("Enter"), "tour.back", 0, 3)).toEqual({ run: "tour.back" });
    expect(cardKeyAction(k("Enter"), undefined, -1, 3)).toBeNull();
    expect(cardKeyAction({ ...k("Enter"), ctrlKey: true }, "tour.skip", 2, 3)).toBeNull();
    expect(cardKeyAction(k("Tab"), "tour.skip", 2, 3)).toEqual({ focus: 0 });
    expect(cardKeyAction(k("Tab", true), "tour.back", 0, 3)).toEqual({ focus: 2 });
    expect(cardKeyAction(k("Tab"), "tour.next", 1, 3)).toEqual({ focus: 2 });
    expect(cardKeyAction(k("Tab"), undefined, -1, 3)).toEqual({ focus: 0 });
    expect(cardKeyAction(k("Tab", true), undefined, -1, 3)).toEqual({ focus: 2 });
    expect(cardKeyAction(k("Tab"), undefined, -1, 0)).toBeNull();
    expect(cardKeyAction(k("Escape"), "tour.next", 1, 3)).toBeNull();
  });

  it("Enter on a focused Skip / Back runs that command and prevents default (the card's keydown)", async () => {
    const { default: React } = await import("react");
    void React;
    // The keydown handler as wired on the card: find it on the rendered element tree.
    const tree = TourView({ stop: 2, hole: null, viewport: VIEWPORT, at: { x: 0, y: 0 }, figure: null, keyOf: commandKey });
    const card = (tree.props.children as { props: { className?: string; onKeyDown?: (e: unknown) => void } }[]).find((c) => c.props.className?.startsWith("tour-card"))!;
    useTourStore.getState().start();
    useTourStore.setState({ stop: 2 });
    const fire = (command: string, index: number) => {
      const buttons = [{ focus: () => {} }, { focus: () => {} }, { focus: () => {} }];
      const target = { dataset: { command } };
      const event = {
        key: "Enter",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        target,
        currentTarget: { querySelectorAll: () => buttons.map((b, i) => (i === index ? target : b)) },
        preventDefault: vi.fn(),
      };
      card.props.onKeyDown!(event);
      return event;
    };
    const back = fire("tour.back", 0);
    expect(back.preventDefault).toHaveBeenCalled();
    expect(useTourStore.getState().stop).toBe(1);
    const skip = fire("tour.skip", 2);
    expect(skip.preventDefault).toHaveBeenCalled();
    expect(useTourStore.getState().on).toBe(false);
  });

  it("the tour draws nothing while off", () => {
    expect(useTourStore.getState().on).toBe(false);
    expect(renderToStaticMarkup(<Tour />)).toBe("");
  });
});

type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;

describe("tour.css (Story 11.6)", () => {
  const css = fs.readFileSync(new URL("./tour.css", import.meta.url), "utf8");
  const rule = (selector: string) => {
    // The rule of `selector` alone (not one of a selector list).
    const at = css.indexOf(`

${selector} {`);
    return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("sits at z 14 and takes the pointer: nothing under the dim can be clicked", () => {
    expect(rule(".tour")).toContain("z-index: 14;");
    expect(rule(".tour")).toContain("inset: 0;");
    expect(rule(".tour-layer")).toContain("pointer-events: auto;");
    expect(rule(".tour-layer")).toContain("inset: 0;");
  });

  it("dims at the palette backdrop's colour, outlines the cut-out like a selected node, and moves over 150 ms (none under reduced motion)", () => {
    expect(rule(".tour-dim")).toContain("background: color-mix(in srgb, var(--bg) 55%, transparent);");
    expect(rule(".tour-cutout")).toContain("outline: var(--line) solid var(--focus);");
    expect(rule(".tour-cutout")).toContain("outline-offset: 2px;");
    expect(css).toContain("left 150ms");
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.tour-dim,\s*\.tour-cutout\s*\{\s*transition: none;/);
    expect(css).not.toMatch(/animation:|@keyframes/);
  });
});
