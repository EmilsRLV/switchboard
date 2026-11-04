// The first-run tour's stops (Story 11.6): one typed table, in order. A stop points at a real
// element through its `data-tour="<id>"` attribute (a static scan in `tour.test.ts` checks every
// id is in the markup), or, with no target, shows a Help figure (a Story 11.4 `FIGURES` name)
// instead. What a stop points at depends on whether the canvas has projects: the empty canvas
// has the ghost card and no toolbar or handle to show, so stops 3 and 4 fall back to figures.
// Pure data and functions: the store (`state/tour.ts`) holds where the tour is, `Tour.tsx` draws it.

import type { FigureName } from "./figures";

/** The elements a stop may point at: each is a `data-tour` attribute on the real element. */
export type TourTargetId = "canvas" | "ghost" | "project" | "toolbar-new" | "handle";

export const TOUR_TARGET_IDS: readonly TourTargetId[] = ["canvas", "ghost", "project", "toolbar-new", "handle"];

/** A piece of a stop's text: plain words, or a command whose effective key shows as `<kbd>`. */
export type TourTextPart = string | { readonly key: string };

/** Where a stop points on one kind of canvas: a target, or a figure (with its alt text), or neither. */
export type TourPlace = {
  readonly target?: TourTargetId;
  readonly figure?: FigureName;
};

export type TourStop = {
  readonly id: string;
  readonly title: string;
  /** One or two sentences. */
  readonly text: readonly TourTextPart[];
  /** On an empty canvas (no projects). */
  readonly empty: TourPlace;
  /** With at least one project. */
  readonly projects: TourPlace;
  /** What the stop shows on the first project card as if it were hovered (with projects only). */
  readonly forces?: "toolbar" | "handle";
  /** The figure's alt text, when the stop can show one. */
  readonly figureAlt?: string;
};

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "canvas",
    title: "The canvas",
    text: ["Projects are cards; sessions and branches hang under them."],
    empty: { target: "ghost" },
    projects: { target: "canvas" },
  },
  {
    id: "project",
    title: "Add a project",
    text: [{ key: "project.add" }, " picks a folder to add as a project card, or drop a folder on the canvas."],
    empty: { target: "ghost" },
    projects: { target: "project" },
  },
  {
    id: "session",
    title: "Start a session",
    text: ["Hover a card for its toolbar; its new button starts a Claude session in that project, as ", { key: "project.newSession" }, " does on a selected card."],
    empty: { figure: "node-anatomy" },
    projects: { target: "toolbar-new" },
    forces: "toolbar",
    figureAlt: "A project card with its sessions and branches under it",
  },
  {
    id: "edge",
    title: "Link nodes",
    text: ["Drag from a card's handle to another card to draw an edge, or press ", { key: "edge.link" }, " on a selected card."],
    empty: { figure: "draw-edge" },
    projects: { target: "handle" },
    forces: "handle",
    figureAlt: "Dragging from a card's handle to another card draws an edge",
  },
  {
    id: "read",
    title: "Read the canvas",
    text: ["Each session card says its state. The attention colour means a session needs you; ", { key: "attention.next" }, " goes there."],
    empty: { figure: "session-states" },
    projects: { figure: "session-states" },
    figureAlt: "A session card going from busy to waiting, in the attention colour",
  },
  {
    id: "commands",
    title: "Everything is a command",
    text: [{ key: "palette.toggle" }, " lists every command with its key; ", { key: "help.toggle" }, " opens help for where you are."],
    empty: {},
    projects: {},
  },
];

/** The number of stops. */
export const TOUR_STOP_COUNT = TOUR_STOPS.length;

/** Where stop `index` points: on the empty canvas or with projects. Out of range gives neither. */
export function placeOf(index: number, hasProjects: boolean): TourPlace {
  const stop = TOUR_STOPS[index];
  if (stop === undefined) return {};
  return hasProjects ? stop.projects : stop.empty;
}

/**
 * What the stop shows when its target is not in the DOM (or is off screen): no cut-out, the card
 * centred, and the empty canvas's figure when it has one.
 */
export function fallbackPlace(index: number): TourPlace {
  const figure = TOUR_STOPS[index]?.empty.figure;
  return figure === undefined ? {} : { figure };
}

/** What stop `index` forces shown on the first project card, while the canvas has projects. */
export function forcedOn(index: number, hasProjects: boolean): "toolbar" | "handle" | null {
  if (!hasProjects) return null;
  return TOUR_STOPS[index]?.forces ?? null;
}

/** The step text, `2 / 6`. */
export function stepText(index: number): string {
  return `${index + 1} / ${TOUR_STOP_COUNT}`;
}

/** The CSS selector of a target. */
export function targetSelector(id: TourTargetId): string {
  return `[data-tour="${id}"]`;
}
