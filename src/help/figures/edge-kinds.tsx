// The edge-kinds figure (Story 11.4, Edges): a still row of five short edges, each named under it
// in mono: a context edge, a cooperate edge, a pending edge (muted), a failed one (the attention
// accent, through the canvas's own `.attention` line) and the selected one (`--focus`).

import { EdgeLine, Figure, type FigureProps } from "./parts";

const LINE = "M4,14 C24,4 40,24 60,14";

const KINDS: readonly { label: string; kind: "context" | "cooperate"; edge?: string; failed?: boolean }[] = [
  { label: "context", kind: "context" },
  { label: "cooperate", kind: "cooperate" },
  { label: "pending", kind: "context", edge: "is-pending" },
  { label: "failed", kind: "context", failed: true },
  { label: "selected", kind: "context", edge: "is-selected" },
];

export default function EdgeKindsFigure({ alt }: FigureProps) {
  return (
    <Figure name="edge-kinds" alt={alt}>
      {KINDS.map(({ label, kind, edge, failed }) => (
        <div key={label} className="help-figure-kind">
          <svg className="help-figure-kind-line" width="64" height="28" viewBox="0 0 64 28">
            <EdgeLine kind={kind} d={LINE} className={edge} failed={failed} />
          </svg>
          <span className="help-figure-label">{label}</span>
        </div>
      ))}
    </Figure>
  );
}
