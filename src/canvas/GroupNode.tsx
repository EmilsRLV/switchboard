import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { GROUP_COLORS } from "../ipc";
import { GROUP_FRAME_HANDLE, groupCountText, liveBadgeText, type GroupCardFlowNode, type GroupFrameFlowNode } from "./nodes";

/** The class that draws a group's colour as its 2-px left rule; nothing for no (or an unknown) colour. */
export function groupColorClass(color: string | null): string {
  return color !== null && (GROUP_COLORS as readonly string[]).includes(color) ? ` group-color-${color}` : "";
}

/**
 * Story 12.3: an expanded group's frame, behind its members: a 1-px `--border` rectangle around
 * their cards and drawn children with a fixed padding (`groupRect`), its label top-left in mono
 * `--text-xs`. A set colour shows only as a 2-px left rule. Only the label takes the pointer: a
 * click on it selects the group (the canvas's `onNodeClick`), a drag of it moves every member
 * (the frame is the xyflow node, the label its drag handle); the rest of the frame lets clicks
 * through to the canvas and the cards.
 */
export const GroupFrameNode = memo(function GroupFrameNode({ data }: NodeProps<GroupFrameFlowNode>) {
  const { group, width, height, selected } = data;
  return (
    <div
      className={"group-frame" + groupColorClass(group.color) + (selected ? " is-selected" : "")}
      style={{ width, height }}
      role="group"
      aria-label={`Group ${group.label}`}
    >
      <div className={GROUP_FRAME_HANDLE} title={group.label}>
        {group.label}
      </div>
    </div>
  );
});

/**
 * Story 12.3: a collapsed group as one project-sized card at its frame's top-left: the label,
 * `N projects`, the members' summed `N live`, and the project glow while any member's node needs
 * the operator. Its members and their children are not drawn. Dragging it moves the members by
 * the same offset; Enter (or Expand group) opens it again.
 */
export const GroupCardNode = memo(function GroupCardNode({ data }: NodeProps<GroupCardFlowNode>) {
  const { group, memberCount, liveCount, attention, attentionText, selected } = data;
  const glow = attention ? (attentionText ?? "a session needs you") : null;
  const count = groupCountText(memberCount);
  return (
    <div
      className={
        "project-node group-card" + groupColorClass(group.color) + (selected ? " is-selected" : "") + (attention ? " project-glow" : "")
      }
      role="group"
      aria-label={`Group ${group.label}, collapsed, ${count}${liveCount > 0 ? `, ${liveBadgeText(liveCount)}` : ""}${glow === null ? "" : `, ${glow}`}`}
      title={glow ?? undefined}
    >
      <div className="project-node-head">
        <span className="project-node-label">{group.label}</span>
        {liveCount > 0 && (
          <span className="project-node-live" title={liveBadgeText(liveCount)}>
            {liveCount} live
          </span>
        )}
      </div>
      <div className="project-node-path">{count}</div>
      <div className="project-node-status">
        <span className="project-node-muted">group</span>
      </div>
    </div>
  );
});
