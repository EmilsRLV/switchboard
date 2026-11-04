// The panes figure (Story 11.4, Canvas): a miniature canvas. A pane slides in from the right, then
// the command palette appears over the dimmed view. The app's own pane and palette classes, sized
// down for the stage (`figures.css`), on a 480 × 220 stage scaled to fit. A 6-s loop that holds the
// end frame (pane open, palette over it) for its second half; that frame alone under reduced motion.

import { Figure, Place, ProjectCard, SessionCard, type FigureProps } from "./parts";

export default function PanesFigure({ alt }: FigureProps) {
  return (
    <Figure name="panes" alt={alt}>
      <div className="help-figure-canvas">
        <Place x={24} y={20}>
          <ProjectCard label="switchboard" path="~/projects/switchboard" git="main · 3 changed" chevron={{ expanded: true }} />
        </Place>
        <Place x={40} y={112}>
          <SessionCard title="fix login" state="idle" meta="main · 9 msgs" />
        </Place>
        <Place x={40} y={160}>
          <SessionCard title="api client" state="idle" meta="main · 4 msgs" />
        </Place>
        <div className="pane help-anim help-anim-pane">
          <div className="pane-header">
            <span className="pane-title">Help</span>
          </div>
          <div className="pane-section">
            <span className="pane-heading">Contents</span>
            <span className="help-figure-bar" />
            <span className="help-figure-bar help-figure-bar-short" />
            <span className="help-figure-bar" />
            <span className="help-figure-bar help-figure-bar-short" />
          </div>
        </div>
        <div className="palette-backdrop help-anim help-anim-palette">
          <div className="palette">
            <div className="palette-input">new</div>
            <ul className="palette-list">
              <li className="palette-row is-selected">
                <span className="palette-row-title">New session…</span>
                <span className="palette-row-key">n</span>
              </li>
              <li className="palette-row">
                <span className="palette-row-title">New worktree…</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </Figure>
  );
}
