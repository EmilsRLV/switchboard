import { memo, type MouseEvent as ReactMouseEvent } from "react";
import type { NodeProps } from "@xyflow/react";
import { runCommand } from "../commands/registry";
import { useUiStore } from "../state/ui";
import { aheadBehind, chevronCommandId, shortenPath, statusLine, type ProjectFlowNode } from "./nodes";

/**
 * A project node: a compact card with the folder name, a shortened path (full path on
 * hover), the git line (`branch · N changed`, or why there is none), `↑n ↓m` when the
 * upstream differs, a live-session badge (`N live`: its busy, idle or unrecognised sessions
 * from the live poll; hidden at 0) and, for git repos
 * only, a "branches" affordance that does nothing until Epic 5. When the project has
 * children, a chevron (with the count while collapsed) selects the card and runs
 * `project.expand` / `project.collapse`. Dragging, selection and the right-click menu are
 * the canvas's; the selected card shows an outline in `--fg`. While any of its sessions is
 * `finished` or `waiting` the card glows: a pulsing accent outline outside the selection's
 * (`project-glow`, Story 3.3).
 */
export const ProjectNode = memo(function ProjectNode({ data }: NodeProps<ProjectFlowNode>) {
  const { project, status, flashed, selected, childCount, liveCount, attention } = data;
  const line = statusLine(status);
  const divergence = aheadBehind(status);
  const isRepo = status?.kind === "repo";

  const toggle = (event: ReactMouseEvent) => {
    // The card's own click handler (xyflow → `onNodeClick`) would select too; one is enough.
    event.stopPropagation();
    useUiStore.getState().select({ kind: "project", id: project.id });
    runCommand(chevronCommandId(project));
  };

  return (
    <div
      className={
        "project-node" + (flashed ? " is-flash" : "") + (selected ? " is-selected" : "") + (attention ? " project-glow" : "")
      }
      role="group"
      aria-label={`Project ${project.label}${attention ? ", needs you" : ""}`}
      title={attention ? `${project.label}: a session needs you` : undefined}
    >
      <div className="project-node-head">
        {childCount > 0 && (
          // `nodrag`: a press on the chevron never starts a drag of the card.
          <button
            type="button"
            className="project-node-toggle nodrag"
            aria-expanded={project.expanded}
            aria-label={project.expanded ? "Collapse children" : `Expand ${childCount} children`}
            title={project.expanded ? "Collapse" : "Expand"}
            onClick={toggle}
          >
            <span className="project-node-chevron" aria-hidden="true">
              {project.expanded ? "▾" : "▸"}
            </span>
            {!project.expanded && <span className="project-node-badge">{childCount}</span>}
          </button>
        )}
        <span className="project-node-label">{project.label}</span>
        {liveCount > 0 && (
          <span className="project-node-live" title="live sessions">
            {liveCount} live
          </span>
        )}
      </div>
      <div className="project-node-path" title={project.path}>
        {shortenPath(project.path)}
      </div>
      <div className="project-node-status">
        <span className={line.tone === "muted" ? "project-node-muted" : undefined} title={line.title}>
          {line.text}
        </span>
        {divergence !== null && <span className="project-node-ab">{divergence}</span>}
        {isRepo && (
          <button type="button" className="project-node-branches" aria-disabled="true" tabIndex={-1} title="Branches (Epic 5)">
            branches
          </button>
        )}
      </div>
    </div>
  );
});
