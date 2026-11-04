import { Suspense, lazy, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { commandHint, commandKey } from "../commands/keybindings";
import { getCommand, runCommand, subscribeBindings } from "../commands/registry";
import type { FigureName } from "../help/figures";
import { fallbackPlace, placeOf, stepText, targetSelector, TOUR_STOP_COUNT, TOUR_STOPS, type TourPlace, type TourTextPart } from "../help/tour";
import { useTourStore } from "../state/tour";
import { clampToArea } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import "./tour.css";

// The first-run tour (Story 11.6; DESIGN.md "The tour"): a dim layer over the whole window (z 14:
// over the shell, panes and toasts, under the palette and the menu) made of four rectangles around
// the stop's target, so the target shows through a cut-out with the selected node's outline, and
// a small card beside it with the stop's words, Back, Next (Finish) and Skip. A stop with no
// target, or whose target is not in the DOM or off screen, dims everything and centres the card,
// with a figure when it has one. The layer takes the pointer: nothing under it can be clicked.
// Read-only: the tour runs no command of its own; its buttons run `tour.*` through `runCommand`.

// Figures live in the Help pane's lazily loaded chunk; the tour loads them only on a figure stop.
const TourFigure = lazy(async () => {
  const { figureFor } = await import("../help/figures");
  return {
    default: function TourFigure({ name, alt }: { name: FigureName; alt: string }) {
      const Figure = figureFor(name);
      return Figure === null ? null : <Figure alt={alt} />;
    },
  };
});

export type Rect = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** The space between the cut-out and the card (clear of the 2-px-offset outline). */
export const CARD_GAP = 12;
/** How close to the window's edge the card may sit beside a cut-out. */
export const CARD_MARGIN = 8;

/** `rect` cut to the window; `null` when no part of it is on screen (or it has no size). */
export function visiblePart(rect: Rect, viewport: Size): Rect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.left + rect.width);
  const bottom = Math.min(viewport.height, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The four dim rectangles around `hole` (above, below, left, right), covering the rest of the
 * window. With no hole they close on the window's centre, so they cover all of it and the next
 * cut-out opens from there.
 */
export function dimRects(hole: Rect | null, viewport: Size): [Rect, Rect, Rect, Rect] {
  const h = hole ?? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0 };
  const right = h.left + h.width;
  const bottom = h.top + h.height;
  const size = (n: number) => Math.max(0, n);
  return [
    { left: 0, top: 0, width: viewport.width, height: size(h.top) },
    { left: 0, top: bottom, width: viewport.width, height: size(viewport.height - bottom) },
    { left: 0, top: h.top, width: size(h.left), height: h.height },
    { left: right, top: h.top, width: size(viewport.width - right), height: h.height },
  ];
}

/**
 * Where the card goes: right of the cut-out, else left of it, else below it; centred when none
 * fits or there is no cut-out. Always kept `CARD_MARGIN` inside the window (`clampToArea`).
 */
export function cardPosition(hole: Rect | null, card: Size, viewport: Size): Point {
  let at: Point = { x: (viewport.width - card.width) / 2, y: (viewport.height - card.height) / 2 };
  if (hole !== null) {
    const right = hole.left + hole.width + CARD_GAP;
    const left = hole.left - CARD_GAP - card.width;
    const below = hole.top + hole.height + CARD_GAP;
    if (right + card.width <= viewport.width - CARD_MARGIN) at = { x: right, y: hole.top };
    else if (left >= CARD_MARGIN) at = { x: left, y: hole.top };
    else if (below + card.height <= viewport.height - CARD_MARGIN) at = { x: hole.left, y: below };
  }
  const inner = { width: viewport.width - 2 * CARD_MARGIN, height: viewport.height - 2 * CARD_MARGIN };
  const kept = clampToArea({ x: at.x - CARD_MARGIN, y: at.y - CARD_MARGIN }, card, inner);
  return { x: kept.x + CARD_MARGIN, y: kept.y + CARD_MARGIN };
}

/** The ids the card's dialog is labelled and described by (one tour at a time). */
export const TOUR_TITLE_ID = "tour-title";
export const TOUR_TEXT_ID = "tour-text";

/** What a stop shows once its target was looked for: the place, or the fallback when the target is missing. */
export function shownPlace(stop: number, hasProjects: boolean, found: boolean): TourPlace {
  const place = placeOf(stop, hasProjects);
  return place.target === undefined || found ? place : fallbackPlace(stop);
}

/** A stop's text: plain words, and each command's effective key as `<kbd>` (its title when unbound). */
export function TourText({ parts, keyOf, id }: { parts: readonly TourTextPart[]; keyOf: (id: string) => string | null; id?: string }) {
  return (
    <p className="tour-text" id={id}>
      {parts.map((part, index): ReactNode => {
        if (typeof part === "string") return part;
        const key = keyOf(part.key);
        if (key !== null) {
          return (
            <kbd key={index} className="tour-kbd">
              {key}
            </kbd>
          );
        }
        return getCommand(part.key)?.title ?? part.key;
      })}
    </p>
  );
}

export type TourViewProps = {
  stop: number;
  /** The cut-out (the target's visible rect), or `null` for none. */
  hole: Rect | null;
  viewport: Size;
  /** The card's top-left corner. */
  at: Point;
  figure: FigureName | null;
  keyOf: (id: string) => string | null;
  cardRef?: RefObject<HTMLDivElement | null>;
  nextRef?: RefObject<HTMLButtonElement | null>;
};

/**
 * The tour as drawn (no hooks, so a test can render it): the pointer-taking layer, the four dim
 * rectangles, the cut-out's outline, and the card.
 */
export function TourView({ stop, hole, viewport, at, figure, keyOf, cardRef, nextRef }: TourViewProps) {
  const current = TOUR_STOPS[stop] ?? TOUR_STOPS[0]!;
  const last = stop >= TOUR_STOP_COUNT - 1;
  return (
    <div className="tour">
      <div className="tour-layer" aria-hidden="true" onMouseDown={keepFocus}>
        {dimRects(hole, viewport).map((rect, index) => (
          <div key={index} className="tour-dim" style={box(rect)} />
        ))}
        {hole !== null && <div className="tour-cutout" style={box(hole)} />}
      </div>
      <div
        ref={cardRef}
        className={"tour-card" + (hole === null ? " is-centred" : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TOUR_TITLE_ID}
        aria-describedby={TOUR_TEXT_ID}
        style={{ left: at.x, top: at.y }}
        onKeyDown={onCardKeyDown}
      >
        <h2 className="tour-title" id={TOUR_TITLE_ID}>
          {current.title}
        </h2>
        <TourText parts={current.text} keyOf={keyOf} id={TOUR_TEXT_ID} />
        {figure !== null && (
          <Suspense fallback={null}>
            <TourFigure name={figure} alt={current.figureAlt ?? current.title} />
          </Suspense>
        )}
        <div className="tour-row">
          <span className="tour-step">{stepText(stop)}</span>
          <span className="tour-buttons">
            <button type="button" className="btn" data-command="tour.back" disabled={stop === 0} title={commandHint("tour.back", "Back")} onClick={() => runCommand("tour.back")}>
              Back
            </button>
            <button ref={nextRef} type="button" className="btn" data-command="tour.next" title={commandHint("tour.next", last ? "Finish" : "Next")} onClick={() => runCommand("tour.next")}>
              {last ? "Finish" : "Next"}
            </button>
            <button type="button" className="btn" data-command="tour.skip" title={commandHint("tour.skip", "Skip")} onClick={() => runCommand("tour.skip")}>
              Skip
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A press on the layer does nothing, and leaves the focus on the card. */
function keepFocus(event: { preventDefault(): void }): void {
  event.preventDefault();
}

function box(rect: Rect) {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** What a key pressed in the card does: run a command, focus a button by index, or nothing (`null`). */
export type CardKeyAction = { run: string } | { focus: number } | null;

/**
 * The card's own keys, pure: Enter on a focused button runs that button's command (`focused`, its
 * `data-command`; not the dispatcher's Enter, which is Next), and Tab / Shift+Tab stay among the
 * card's `count` enabled buttons, wrapping; from outside them (`index` -1) Tab starts at the first
 * and Shift+Tab at the last. A handled key is swallowed (preventDefault) by the caller.
 */
export function cardKeyAction(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  focused: string | undefined,
  index: number,
  count: number,
): CardKeyAction {
  if (event.key === "Enter") {
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || focused === undefined) return null;
    return { run: focused };
  }
  if (event.key !== "Tab" || count === 0) return null;
  if (index < 0) return { focus: event.shiftKey ? count - 1 : 0 };
  const step = event.shiftKey ? -1 : 1;
  return { focus: (index + step + count) % count };
}

/** The card's keydown: {@link cardKeyAction} on the focused element. */
function onCardKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const action = cardKeyAction(event, target.dataset?.command, buttons.indexOf(target as HTMLButtonElement), buttons.length);
  if (action === null) return;
  event.preventDefault();
  if ("run" in action) runCommand(action.run);
  else buttons[action.focus]?.focus();
}

/**
 * The first-run tour, mounted in `App` beside the palette and the menu: drawn only while it is on.
 */
export function Tour() {
  const on = useTourStore((s) => s.on);
  return on ? <ShownTour /> : null;
}

type Layout = { hole: Rect | null; found: boolean; viewport: Size; card: Size };

const NO_LAYOUT: Layout = { hole: null, found: false, viewport: { width: 0, height: 0 }, card: { width: 0, height: 0 } };

function sameLayout(a: Layout, b: Layout): boolean {
  const r = (x: Rect | null, y: Rect | null) =>
    x === y || (x !== null && y !== null && x.left === y.left && x.top === y.top && x.width === y.width && x.height === y.height);
  return (
    a.found === b.found &&
    r(a.hole, b.hole) &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height &&
    a.card.width === b.card.width &&
    a.card.height === b.card.height
  );
}

/** Measure the target, the window and the card: before the first paint, then on every frame while shown. */
function useTourLayout(selector: string | null, cardRef: RefObject<HTMLDivElement | null>): Layout {
  const [layout, setLayout] = useState<Layout>(NO_LAYOUT);
  const measure = () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const element = selector === null ? null : document.querySelector(selector);
    const rect = element === null ? null : element.getBoundingClientRect();
    const hole = rect === null ? null : visiblePart({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, viewport);
    const cardRect = cardRef.current?.getBoundingClientRect();
    const card = { width: cardRect?.width ?? 0, height: cardRect?.height ?? 0 };
    const next: Layout = { hole, found: hole !== null, viewport, card };
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  };
  // Every render (a stop change, a figure loading): measured again before paint; settles as soon
  // as nothing changed.
  useLayoutEffect(measure);
  // A window resize or a target moving: the next frame re-measures.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      measure();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `measure` reads the selector it was made with; the loop restarts when it changes.
  }, [selector]);
  return layout;
}

/** The tour while it is on: follows the stop, the canvas (projects or not) and the bindings. */
function ShownTour() {
  const stop = useTourStore((s) => s.stop);
  const hasProjects = useWorkspaceStore((s) => (s.snapshot?.workspace.projects.length ?? 0) > 0);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeBindings(bump), []);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const target = placeOf(stop, hasProjects).target;
  const layout = useTourLayout(target === undefined ? null : targetSelector(target), cardRef);
  const place = shownPlace(stop, hasProjects, layout.found);
  const hole = place.target === undefined ? null : layout.hole;

  // Focus goes to the card and comes back to where it was when the tour ends.
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  // Next takes the focus on each stop.
  useEffect(() => {
    nextRef.current?.focus();
  }, [stop]);

  return (
    <TourView
      stop={stop}
      hole={hole}
      viewport={layout.viewport}
      at={cardPosition(hole, layout.card, layout.viewport)}
      figure={place.figure ?? null}
      keyOf={commandKey}
      cardRef={cardRef}
      nextRef={nextRef}
    />
  );
}
