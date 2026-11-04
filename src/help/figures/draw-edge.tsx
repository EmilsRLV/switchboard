// The draw-edge figure (Story 11.4, Edges): a session card's handle appears, a dashed line is
// pulled to a project card and settles as a context edge; then two session cards are joined by a
// cooperate edge's double line. An 8-s loop that holds its end frame (both edges drawn, the
// handle of the last drag shown) for the last third; the end frame alone under reduced motion.
// Stage coordinates match the canvas's px.

import { EdgeLine, Figure, Handle, Place, ProjectCard, SessionCard, type FigureProps } from "./parts";

export default function DrawEdgeFigure({ alt }: FigureProps) {
  return (
    <Figure name="draw-edge" alt={alt}>
      <svg className="help-figure-edges" width="540" height="160" viewBox="0 0 540 160">
        <EdgeLine kind="context" d="M208,60 C254,60 254,40 300,40" className="help-anim help-anim-context" />
        <path className="react-flow__connection-path help-anim help-anim-drag help-anim-drag-context" d="M208,60 L300,40" />
        <EdgeLine kind="cooperate" d="M208,140 C270,140 270,140 332,140" className="help-anim help-anim-cooperate" />
        <path className="react-flow__connection-path help-anim help-anim-drag help-anim-drag-cooperate" d="M208,140 L332,140" />
      </svg>
      <Place x={0} y={40}>
        <SessionCard title="fix login" state="idle" meta="main · 9 msgs" />
        {/* Its hover ends when the next drag starts: the end frame shows only the last drag's handle. */}
        <Handle hidden className="help-anim help-anim-handle-context" />
      </Place>
      <Place x={300} y={0}>
        <ProjectCard label="shared-lib" path="~/projects/shared-lib" git="main · clean" />
      </Place>
      <Place x={0} y={120}>
        <SessionCard title="api client" state="busy" meta="main · 4 msgs" />
        <Handle className="help-anim help-anim-handle-cooperate" />
      </Place>
      <Place x={332} y={120}>
        <SessionCard title="web app" state="idle" meta="main · 7 msgs" />
      </Place>
    </Figure>
  );
}
