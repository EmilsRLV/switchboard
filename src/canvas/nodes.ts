// Pure helpers behind the project nodes: deriving xyflow nodes from the workspace snapshot
// plus the live status map and the card's text. No React, no DOM, so all of it is
// unit-tested in vitest's node environment.

import type { Node } from "@xyflow/react";
import type { Position, Project, ProjectStatus, ProjectStatusMap } from "../ipc";

/** What a `ProjectNode` renders from. */
export type ProjectNodeData = {
  project: Project;
  /** `null` while the poller has not reached this project. */
  status: ProjectStatus | null;
  /** True while a duplicate add highlights this node. */
  flashed: boolean;
};

export type ProjectFlowNode = Node<ProjectNodeData, "project">;

/** The card's size (`nodes.css`), so a node placed "at" a point can be centred on it. */
export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 80;

/** Live-session count on the badge; a constant 0 (hidden) until Epic 3 wires sessions. */
export const LIVE_SESSIONS: number = 0;

/** Longest path shown on a card before the middle is elided. */
export const PATH_MAX_CHARS = 36;

/**
 * The xyflow nodes for the canvas: one `project` node per workspace project at its stored
 * position. Nodes are not draggable, selectable or connectable yet (Stories 2.3/2.4).
 */
export function toFlowNodes(
  projects: readonly Project[],
  statuses: ProjectStatusMap,
  flashed: readonly string[],
): ProjectFlowNode[] {
  return projects.map((project) => ({
    id: project.id,
    type: "project",
    position: { x: project.position.x, y: project.position.y },
    data: {
      project,
      status: statuses[project.id] ?? null,
      flashed: flashed.includes(project.id),
    },
    draggable: false,
    selectable: false,
    connectable: false,
  }));
}

/** The canvas point whose card (top-left there) is centred on `centre`. */
export function cardTopLeft(centre: Position): Position {
  return { x: centre.x - CARD_WIDTH / 2, y: centre.y - CARD_HEIGHT / 2 };
}

/**
 * A path short enough for a card: the first component (drive or root), an ellipsis and as
 * many trailing components as fit in `max` characters, never fewer than the last one.
 * `B:\projects\very\deep\guild-auth` → `B:\…\deep\guild-auth`. Separator style is kept.
 */
export function shortenPath(path: string, max = PATH_MAX_CHARS): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter((p, i) => p !== "" || i === 0);
  if (parts.length < 3) return path;
  const head = parts[0] === "" ? "" : parts[0];
  let candidate = path;
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) {
    const tail = parts.slice(parts.length - keep).join(sep);
    candidate = `${head}${sep}…${sep}${tail}`;
    if (candidate.length <= max) break;
  }
  return candidate;
}

export type StatusLine = {
  text: string;
  /** `muted` for the non-repo and not-yet-known cases, `normal` for git facts. */
  tone: "normal" | "muted";
  /** Hover text with the detail the line itself does not carry (git's error message). */
  title?: string;
};

/** The card's status line: `master · 2 changed`, `not a git repo`, `folder missing`, … */
export function statusLine(status: ProjectStatus | null): StatusLine {
  if (status === null) return { text: "…", tone: "muted" };
  switch (status.kind) {
    case "repo":
      return {
        text: `${status.branch}${status.detached ? " detached" : ""} · ${status.dirty} changed`,
        tone: "normal",
      };
    case "not_repo":
      return { text: "not a git repo", tone: "muted" };
    case "missing":
      return { text: "folder missing", tone: "muted" };
    case "git_unavailable":
      return { text: "git unavailable", tone: "muted" };
    case "git_error":
      return { text: "git error", tone: "muted", title: status.message };
  }
}

/** `↑n ↓m` when the upstream differs, else `null` (nothing to show). */
export function aheadBehind(status: ProjectStatus | null): string | null {
  if (status === null || status.kind !== "repo") return null;
  if (status.ahead === 0 && status.behind === 0) return null;
  return `↑${status.ahead} ↓${status.behind}`;
}

/** Tauri's drop position (physical pixels) → client (CSS) pixels for `screenToFlowPosition`. */
export function physicalToClient(position: Position, devicePixelRatio: number): Position {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return { x: position.x / dpr, y: position.y / dpr };
}
