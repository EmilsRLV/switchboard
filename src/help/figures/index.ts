// The Help figures (Story 11.4): small CSS-animated diagrams a help page names with a fenced block
// whose info string is `figure <name>` (its text is the alt text). One typed table from name to
// component; the Help pane draws `FIGURES[name]`, and a name missing here shows the alt text as a
// code block. Imported only by the lazily loaded Help pane, so the main bundle gains nothing.

import type { ComponentType } from "react";
import "../figures.css";
import DrawEdgeFigure from "./draw-edge";
import EdgeKindsFigure from "./edge-kinds";
import NodeAnatomyFigure from "./node-anatomy";
import PanesFigure from "./panes";
import SessionStatesFigure from "./session-states";
import type { FigureProps } from "./parts";

export type { FigureProps } from "./parts";

export type FigureName = "draw-edge" | "edge-kinds" | "node-anatomy" | "session-states" | "panes";

export const FIGURES: Readonly<Record<FigureName, ComponentType<FigureProps>>> = Object.freeze({
  "draw-edge": DrawEdgeFigure,
  "edge-kinds": EdgeKindsFigure,
  "node-anatomy": NodeAnatomyFigure,
  "session-states": SessionStatesFigure,
  panes: PanesFigure,
});

/** The figure named exactly `name`, or `null` (never a key of `Object.prototype`). */
export function figureFor(name: string): ComponentType<FigureProps> | null {
  return Object.prototype.hasOwnProperty.call(FIGURES, name) ? FIGURES[name as FigureName] : null;
}
