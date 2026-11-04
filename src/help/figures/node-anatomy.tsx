// The node-anatomy figure (Story 11.4, Projects): a still project card with its parts named by
// leader labels: chevron and count, label, `N live`, path, git line, the branches chip and the
// handle. The card sits at (80, 35) on a 400 × 150 stage, unscaled, so the labels keep the
// figure look's `--text-xs`.

import { Figure, Handle, LiveBadge, Place, ProjectCard, type FigureProps } from "./parts";

/** A label: its text's left edge (or right edge, `end`) at x, its middle at y. */
const LABELS: readonly { text: string; x: number; y: number; end?: boolean }[] = [
  { text: "chevron · count", x: 40, y: 10 },
  { text: "label", x: 150, y: 10 },
  { text: "path", x: 72, y: 66, end: true },
  { text: "git line", x: 72, y: 100, end: true },
  { text: "N live", x: 338, y: 40 },
  { text: "handle", x: 338, y: 75 },
  { text: "branches", x: 338, y: 108 },
];

/** The leader lines, from each label to its part: [x1, y1, x2, y2]. */
const LEADERS: readonly (readonly [number, number, number, number])[] = [
  [86, 17, 96, 46],
  [162, 17, 160, 46],
  [76, 66, 90, 72],
  [76, 100, 90, 92],
  [334, 40, 312, 50],
  [334, 75, 325, 75],
  [334, 108, 312, 93],
];

export default function NodeAnatomyFigure({ alt }: FigureProps) {
  return (
    <Figure name="node-anatomy" alt={alt}>
      <svg className="help-figure-edges" width="400" height="150" viewBox="0 0 400 150">
        {LEADERS.map(([x1, y1, x2, y2], index) => (
          <line key={index} className="help-figure-leader" x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </svg>
      <Place x={80} y={35}>
        <ProjectCard
          label="switchboard"
          path="~/projects/switchboard"
          git="main · 3 changed"
          chevron={{ expanded: false, count: 3 }}
          live={<LiveBadge count={2} />}
          branches
        />
        <Handle />
      </Place>
      {LABELS.map(({ text, x, y, end }) => (
        <span key={text} className={"help-figure-label help-figure-callout" + (end === true ? " help-figure-callout-end" : "")} style={{ left: x, top: y }}>
          {text}
        </span>
      ))}
    </Figure>
  );
}
