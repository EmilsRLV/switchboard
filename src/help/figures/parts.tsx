// Shared pieces of the Help figures (Story 11.4): the frame every figure sits in, and the app's
// own project and session cards, handle and edge lines, drawn with the classes `nodes.css` styles
// on the canvas. Nothing here is interactive: a figure is a picture (`role="img"`), so the card's
// chevron and branches chip are plain spans, never buttons. Inline styles only place things
// (left / top); every colour comes from the stylesheets.

import type { ReactNode } from "react";

/** What every figure takes: its alt text (the fenced block's text), its accessible name. */
export type FigureProps = { alt: string };

/** The frame: a page-wide `--bg-raised` box at most 160 px tall, named by its alt text. */
export function Figure({ name, alt, children }: { name: string; alt: string; children: ReactNode }) {
  return (
    // An empty body still names the picture: by the figure's name.
    <div className={`help-figure help-figure-${name}`} role="img" aria-label={alt.trim() === "" ? name : alt}>
      <div className="help-figure-stage">{children}</div>
    </div>
  );
}

/** A card's place on the figure's stage, as xyflow places a node on the canvas. */
export function Place({ x, y, className, children }: { x: number; y: number; className?: string; children: ReactNode }) {
  return (
    <div className={"react-flow__node help-figure-node" + (className === undefined ? "" : ` ${className}`)} style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

/** The link handle on a card's right edge, shown unless `hidden`; `className` adds the figure's animation. */
export function Handle({ className, hidden }: { className?: string; hidden?: boolean }) {
  return (
    <div
      className={"react-flow__handle link-handle" + (hidden === true ? "" : " is-shown") + " help-figure-handle" + (className === undefined ? "" : ` ${className}`)}
    />
  );
}

export type ProjectCardProps = {
  label: string;
  path: string;
  git: string;
  /** `▾` (expanded) or `▸` with the child count beside it (collapsed); none without children. */
  chevron?: { expanded: true } | { expanded: false; count: number };
  /** The `N live` badge, or a node of its own (an animated badge). */
  live?: ReactNode;
  branches?: boolean;
  glow?: boolean;
  children?: ReactNode;
};

/** A project card (240 × 80), as `ProjectNode` draws it. */
export function ProjectCard({ label, path, git, chevron, live, branches, glow, children }: ProjectCardProps) {
  return (
    <div className={"project-node" + (glow === true ? " project-glow" : "")}>
      <div className="project-node-head">
        {chevron !== undefined && (
          <span className="project-node-toggle">
            <span className="project-node-chevron">{chevron.expanded ? "▾" : "▸"}</span>
            {!chevron.expanded && <span className="project-node-badge">{chevron.count}</span>}
          </span>
        )}
        <span className="project-node-label">{label}</span>
        {live}
      </div>
      <div className="project-node-path">{path}</div>
      <div className="project-node-status">
        <span>{git}</span>
        {branches === true && <span className="project-node-branches">branches</span>}
      </div>
      {children}
    </div>
  );
}

/** The `N live` badge of a project card. */
export function LiveBadge({ count, className }: { count: number; className?: string }) {
  return <span className={"project-node-live" + (className === undefined ? "" : ` ${className}`)}>{count} live</span>;
}

export type SessionState = "starting" | "busy" | "waiting" | "finished" | "idle" | "exited";

/** A session card (208 × 40), as `SessionCard` draws it: the title over the state word and meta. */
export function SessionCard({
  title,
  state,
  meta,
  children,
}: {
  title: string;
  state?: SessionState;
  /** The rest of the meta line: `main · 4 msgs · now`, or a finished turn's last line. */
  meta: string;
  children?: ReactNode;
}) {
  const attention = state === "waiting" || state === "finished";
  return (
    <div className={"child-node child-node-two-line" + (attention ? " session-attention" : "")}>
      <span className="child-node-label">{title}</span>
      <span className="child-node-meta">
        {state !== undefined && <StateWord state={state} />}
        {state !== undefined && <span>·</span>}
        <span className={state === "finished" ? "session-last-line" : "child-node-meta-branch"}>{meta}</span>
      </span>
      {children}
    </div>
  );
}

function StateWord({ state }: { state: SessionState }) {
  if (state === "waiting" || state === "finished") {
    return (
      <span className="session-attention-word session-state">
        <span className="session-dot" />
        {state}
      </span>
    );
  }
  if (state === "busy") {
    return (
      <span className="session-state session-state-busy">
        <span className="session-dot" />
        busy
      </span>
    );
  }
  return <span className="session-state session-state-muted">{state}</span>;
}

/** An edge line in the canvas's look; a cooperate edge is its 3-px line with the middle drawn over. */
export function EdgeLine({ kind, d, className, failed }: { kind: "context" | "cooperate"; d: string; className?: string; failed?: boolean }) {
  return (
    <g className={"react-flow__edge" + (className === undefined ? "" : ` ${className}`)}>
      <path className={(failed === true ? "attention " : "") + `link-line link-${kind}`} d={d} />
      {kind === "cooperate" && <path className="link-cooperate-gap" d={d} fill="none" />}
    </g>
  );
}
