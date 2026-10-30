// F1 from where you are (Story 10.2): which guide page Help opens on, from the pane that is open
// (taken before Help replaces it) or, with no pane, the selection; else the page last read this
// run, else Contents. Pure, and free of the page text (it names page ids only), so the main bundle
// can use it.

import type { CanvasTarget } from "../canvas/nodes";
import type { Pane } from "../state/ui";

/** What Help opens over. */
export type HelpContext = {
  /** The open pane, or `null`. */
  pane: Pane | null;
  /** The selection, or `null`. */
  selection: CanvasTarget | null;
  /** The guide page last shown this run, or `null`. */
  lastRead: string | null;
};

/** The page each pane opens on; `help` itself has none. */
const PANE_PAGES: Readonly<Record<Pane, string | null>> = {
  launch: "sessions",
  terminal: "terminals",
  edge: "edges",
  review: "review",
  import: "projects",
  settings: "settings",
  worktree: "branches",
  removeWorktree: "branches",
  help: null,
};

/** The page each selected thing opens on (a `more` row has none). */
const SELECTION_PAGES: Readonly<Record<CanvasTarget["kind"], string | null>> = {
  project: "projects",
  session: "sessions",
  branch: "branches",
  edge: "edges",
  more: null,
};

/** The guide page Help opens on from `context`, or `null` for Contents. */
export function helpPageFor({ pane, selection, lastRead }: HelpContext): string | null {
  if (pane !== null && pane !== "help") return PANE_PAGES[pane] ?? lastRead;
  if (pane === null && selection !== null) {
    const page = SELECTION_PAGES[selection.kind];
    if (page !== null) return page;
  }
  return lastRead;
}
