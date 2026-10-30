// The Help pane's actions (Story 10.1; F1 from where you are, Story 10.2): showing a guide page (Contents rows, page links,
// "Help: open page…", "Help: contents") and opening a web link in the system browser. The page
// table (and its text) is imported dynamically, so it stays out of the main bundle.

import { helpPageFor } from "../help/context";
import { openUrl } from "../ipc";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { notify } from "./navigation";
import { closeOpenPane, openPane } from "./panes";

/**
 * Show guide page `id` (`null`: Contents) in the Help pane, opening the pane when it is not
 * showing, scrolled to the heading `anchor` (`null`: the top).
 */
export function showHelpPage(id: string | null, anchor: string | null = null): void {
  if (useUiStore.getState().pane !== "help") openPane("help");
  useUiStore.getState().setHelpPage(id, anchor);
}

/**
 * `help.open` ("Help"): open the Help pane on the page for where the operator is (Story 10.2):
 * the open pane's page, else the selection's, else the page last read this run, else Contents.
 * The page is worked out before Help replaces the pane. With Help already open, nothing changes.
 */
export function openHelpHere(): void {
  const ui = useUiStore.getState();
  if (ui.pane === "help") return;
  showHelpPage(helpPageFor({ pane: ui.pane, selection: ui.selection, lastRead: ui.helpLastRead }));
}

/** `help.toggle` (F1): close Help (bringing back the pane it opened over), or open it as {@link openHelpHere}. */
export function toggleHelp(): void {
  if (useUiStore.getState().pane === "help") closeOpenPane();
  else openHelpHere();
}

/** The `when` of `help.contents`: the Help pane shows a page (not Contents). */
export function isHelpPageShown(): boolean {
  const ui = useUiStore.getState();
  return ui.pane === "help" && ui.helpPage !== null;
}

/** `help.page` ("Help: open page…"): the palette as a pick list of the guide pages. */
export async function startHelpPagePick(): Promise<void> {
  const { HELP_PAGES } = await import("../help/pages");
  useUiStore.getState().closeContextMenu();
  usePaletteStore.getState().openPick({
    placeholder: "Open help page…",
    items: HELP_PAGES.map(({ id, title }) => ({ id, title })),
    onPick: (id) => showHelpPage(id),
  });
}

/**
 * A web link clicked in a help page: open it in the system browser. Rust refuses anything but
 * `http://` / `https://`; a refusal or failure is the notice.
 */
export async function openWebLink(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err));
  }
}
