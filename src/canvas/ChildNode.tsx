import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { ChildKind } from "../ipc";
import type { BranchFlowNode, ChildNodeData, SessionFlowNode } from "./nodes";

/**
 * One child card (208 × 40): the label and a muted detail. `SessionNode` and `BranchNode`
 * are thin wrappers so xyflow has a type per child kind; Epics 3 and 5 fill them in. A child
 * has no menu yet; selection is an outline in `--fg`, never the accent.
 */
function ChildCard({ data, kind }: { data: ChildNodeData; kind: ChildKind }) {
  const { child, selected } = data;
  return (
    <div
      className={`child-node child-node-${kind}` + (selected ? " is-selected" : "")}
      role="group"
      aria-label={`${kind === "session" ? "Session" : "Branch"} ${child.label}`}
    >
      <span className="child-node-label">{child.label}</span>
      {child.detail !== null && (
        <span className="child-node-detail" title={child.detail}>
          {child.detail}
        </span>
      )}
    </div>
  );
}

export const SessionNode = memo(function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  return <ChildCard data={data} kind="session" />;
});

export const BranchNode = memo(function BranchNode({ data }: NodeProps<BranchFlowNode>) {
  return <ChildCard data={data} kind="branch" />;
});
