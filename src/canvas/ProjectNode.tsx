import { memo, type MouseEvent as ReactMouseEvent } from "react";
import type { NodeProps } from "@xyflow/react";
import { commandHint } from "../commands/keybindings";
import { runCommand } from "../commands/registry";
import { useUiStore } from "../state/ui";
import { LinkHandles } from "./LinkHandles";
import { NodeToolbar, useHover } from "./NodeToolbar";
import { aheadBehind, BRANCHES_UNAVAILABLE, branchesChipShown, chevronCommandId, shortenPath, statusLine, type ProjectFlowNode } from "./nodes";

/**
 * A project node: a compact card with the folder name, a shortened path (full path on
 * hover), the git line (`branch · N changed`, or why there is none), `↑n ↓m` when the
 * upstream differs, a live-session badge (`N live`: its busy, idle or unrecognised sessions
 * from the live poll; hidden at 0) and, for git repos
 * only (or while branches are on, so they can be turned off), the "branches" chip: a toggle button
 * named "branches" whose state is `aria-pressed` alone (`project.toggleBranches`, Story 5.1) that lists
 * the local branches under the sessions, expanding a collapsed card. While a branch read fails
 * the path row reads `branches unavailable` (muted, the cause on hover). When the project has
 * children, a chevron (with the count while collapsed) selects the card and runs
 * `project.expand` / `project.collapse`. Dragging, selection and the right-click menu are
 * the canvas's; the selected card shows an outline in `--fg`. While any of its sessions is
 * `finished` or `waiting` the card glows: a pulsing accent outline outside the selection's
 * (`project-glow`, Story 3.3). The card's edge handle (Story 6.1) sits on its right edge. While
 * the card is hovered or selected (and not dragged), its node toolbar (Story 11.2) hangs to the
 * right of it.
 */
export const ProjectNode = memo(function ProjectNode({ data, dragging }: NodeProps<ProjectFlowNode>) {
  const [hovered, hover] = useHover();
  const { project, status, flashed, selected, childCount, liveCount, attention, branchesError } = data;
  const line = statusLine(status);
  const divergence = aheadBehind(status);
  const isRepo = status?.kind === "repo";

  const toggle = (event: ReactMouseEvent) => {
    // The card's own click handler (xyflow → `onNodeClick`) would select too; one is enough.
    event.stopPropagation();
    useUiStore.getState().select({ kind: "project", id: project.id });
    runCommand(chevronCommandId(project));
  };

  const toggleBranches = (event: ReactMouseEvent) => {
    event.stopPropagation();
    useUiStore.getState().select({ kind: "project", id: project.id });
    runCommand("project.toggleBranches");
  };

  return (
    <div className="node-hover" {...hover}>
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
              title={commandHint(chevronCommandId(project))}
              onClick={toggle}
            >
              <span className="project-node-chevron" aria-hidden="true">
                {project.expanded ? "▾" : "▸"}
              </span>
              {!project.expanded && <span className="project-node-badge">{childCount}</span>}
            </button>
          )}
          <span className="project-node-label" title={branchesError === null ? undefined : project.path}>
            {project.label}
          </span>
          {liveCount > 0 && (
            <span className="project-node-live" title="live sessions">
              {liveCount} live
            </span>
          )}
        </div>
        {branchesError === null ? (
          <div className="project-node-path" title={project.path}>
            {shortenPath(project.path)}
          </div>
        ) : (
          <div className="project-node-path" title={branchesError}>
            {BRANCHES_UNAVAILABLE}
          </div>
        )}
        <div className="project-node-status">
          <span className={line.tone === "muted" ? "project-node-muted" : undefined} title={line.title}>
            {line.text}
          </span>
          {divergence !== null && <span className="project-node-ab">{divergence}</span>}
          {branchesChipShown(project, isRepo) && (
            // `nodrag`: a press on the chip never starts a drag of the card.
            <button
              type="button"
              className={"project-node-branches nodrag" + (project.showBranches ? " is-on" : "")}
              aria-pressed={project.showBranches}
              title={commandHint("project.toggleBranches", project.showBranches ? "Hide branches" : "Show branches")}
              onClick={toggleBranches}
            >
              branches
            </button>
          )}
        </div>
      </div>
      <LinkHandles source shown={selected} />
      <NodeToolbar target={{ kind: "project", id: project.id }} shown={(hovered || selected) && dragging !== true} />
    </div>
  );
});
