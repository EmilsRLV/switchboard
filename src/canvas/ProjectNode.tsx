import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { LIVE_SESSIONS, aheadBehind, shortenPath, statusLine, type ProjectFlowNode } from "./nodes";

/**
 * A project node: a compact card with the folder name, a shortened path (full path on
 * hover), the git line (`branch · N changed`, or why there is none), `↑n ↓m` when the
 * upstream differs, a live-session badge (hidden at 0; wired in Epic 3) and, for git repos
 * only, a "branches" affordance that does nothing until Epic 5. Inert otherwise: dragging,
 * selection and the context menu arrive in 2.3/2.4.
 */
export const ProjectNode = memo(function ProjectNode({ data }: NodeProps<ProjectFlowNode>) {
  const { project, status, flashed } = data;
  const line = statusLine(status);
  const divergence = aheadBehind(status);
  const isRepo = status?.kind === "repo";
  return (
    <div className={"project-node" + (flashed ? " is-flash" : "")} role="group" aria-label={`Project ${project.label}`}>
      <div className="project-node-head">
        <span className="project-node-label">{project.label}</span>
        {LIVE_SESSIONS > 0 && (
          <span className="project-node-live" title="live sessions">
            {LIVE_SESSIONS} live
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
