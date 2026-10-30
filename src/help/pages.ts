// The guide pages (Story 10.1): one typed table, in Contents order. Each page is Markdown in
// `docs/help/`, bundled at build time with Vite's `?raw` import (never fetched). This module is
// loaded only with the Help pane or a help command (dynamic imports), so the page text stays out
// of the main bundle.

import canvasSource from "../../docs/help/canvas.md?raw";
import keyboardSource from "../../docs/help/keyboard.md?raw";
import { renderMarkdown, type HelpNode } from "./markdown";

export type HelpPage = {
  /** Stable id: what `showHelpPage` and the page links name. */
  id: string;
  /** What Contents and "Help: open page…" show. */
  title: string;
  /** The file name in `docs/help/`, as other pages link to it (`keyboard.md#…`). */
  file: string;
  /** The page's Markdown. */
  source: string;
};

export const HELP_PAGES: readonly HelpPage[] = [
  { id: "canvas", title: "Canvas & navigation", file: "canvas.md", source: canvasSource },
  { id: "keyboard", title: "Keyboard & palette", file: "keyboard.md", source: keyboardSource },
];

/** The page with `id`, or `null`. */
export function helpPage(id: string | null): HelpPage | null {
  return HELP_PAGES.find((page) => page.id === id) ?? null;
}

/** The id of the page whose file is `file` (`keyboard.md`), or `null` for an unknown page. */
export function pageIdOfFile(file: string): string | null {
  return HELP_PAGES.find((page) => page.file === file)?.id ?? null;
}

/** The page rendered, its links resolved against this table. */
export function renderHelpPage(page: HelpPage): HelpNode[] {
  return renderMarkdown(page.source, { resolvePage: pageIdOfFile, currentPage: page.id });
}
