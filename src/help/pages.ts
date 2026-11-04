// The guide pages (Stories 10.1, 10.2, then Getting started, 10.3, then the changelog and roadmap, 10.4): one typed table, in
// Contents order. Each page is Markdown in `docs/help/` (the changelog and roadmap: the repo root), bundled at
// build time with Vite's `?raw` import (never fetched). This module is loaded only with the Help pane or a
// help command (dynamic imports), so the page text stays out of the main bundle.

import changelogSource from "../../CHANGELOG.md?raw";
import roadmapSource from "../../ROADMAP.md?raw";
import branchesSource from "../../docs/help/branches.md?raw";
import canvasSource from "../../docs/help/canvas.md?raw";
import edgesSource from "../../docs/help/edges.md?raw";
import gettingStartedSource from "../../docs/help/getting-started.md?raw";
import keyboardSource from "../../docs/help/keyboard.md?raw";
import legendSource from "../../docs/help/legend.md?raw";
import projectsSource from "../../docs/help/projects.md?raw";
import reviewSource from "../../docs/help/review.md?raw";
import sessionsSource from "../../docs/help/sessions.md?raw";
import settingsSource from "../../docs/help/settings.md?raw";
import terminalsSource from "../../docs/help/terminals.md?raw";
import termsSource from "../../docs/help/terms.md?raw";
import toolSource from "../../docs/help/tool.md?raw";
import { renderMarkdown, type HelpNode } from "./markdown";

export type HelpPage = {
  /** Stable id: what `showHelpPage` and the page links name. */
  id: string;
  /** What Contents and "Help: open page…" show. */
  title: string;
  /** The file name in `docs/help/` (or the repo root), as other pages link to it (`keyboard.md#…`). */
  file: string;
  /** The page's Markdown. */
  source: string;
};

export const HELP_PAGES: readonly HelpPage[] = [
  { id: "canvas", title: "Canvas & navigation", file: "canvas.md", source: canvasSource },
  // Story 11.5: what the state words, the glow, the badges and the edge looks mean.
  { id: "legend", title: "What you see", file: "legend.md", source: legendSource },
  { id: "projects", title: "Projects", file: "projects.md", source: projectsSource },
  { id: "sessions", title: "Sessions & launch sheet", file: "sessions.md", source: sessionsSource },
  { id: "terminals", title: "Terminals, tabs & pop-outs", file: "terminals.md", source: terminalsSource },
  { id: "edges", title: "Edges", file: "edges.md", source: edgesSource },
  { id: "branches", title: "Branches & worktrees", file: "branches.md", source: branchesSource },
  { id: "review", title: "Review", file: "review.md", source: reviewSource },
  { id: "tool", title: "The app as a tool for Claude", file: "tool.md", source: toolSource },
  { id: "settings", title: "Settings & diagnostics", file: "settings.md", source: settingsSource },
  { id: "keyboard", title: "Keyboard & palette", file: "keyboard.md", source: keyboardSource },
  { id: "terms", title: "Terms", file: "terms.md", source: termsSource },
  // Story 10.3: after the guide pages; the pane appends the live checklist and Show on canvas.
  { id: "getting-started", title: "Getting started", file: "getting-started.md", source: gettingStartedSource },
  // Story 10.4: the changelog and roadmap, hand-written at the repo root (a page may link `CHANGELOG.md`).
  { id: "changelog", title: "Changelog", file: "CHANGELOG.md", source: changelogSource },
  { id: "roadmap", title: "Roadmap", file: "ROADMAP.md", source: roadmapSource },
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
