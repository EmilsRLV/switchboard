// The session-states figure (Story 11.4, Sessions): a session card under its project card steps
// starting → busy → waiting → busy → finished → idle → exited, one state a second over an 8-s
// loop, holding `exited` for the last two. The project glows on the attention states. CSS only:
// each state is its own card in one place, shown in turn by opacity (`figures.css`), and the glow
// is a second, glowing project card over the first. Under reduced motion: the `exited` card, still.

import { Figure, LiveBadge, Place, ProjectCard, SessionCard, type FigureProps, type SessionState } from "./parts";

const STEPS: readonly { state: SessionState; meta: string }[] = [
  { state: "starting", meta: "main · 0 msgs" },
  { state: "busy", meta: "main · 4 msgs · now" },
  { state: "waiting", meta: "main · 6 msgs · now" },
  { state: "busy", meta: "main · 8 msgs · now" },
  { state: "finished", meta: "Tests pass." },
  { state: "idle", meta: "main · 9 msgs · now" },
  { state: "exited", meta: "main · 9 msgs · 1m" },
];

const PROJECT = { label: "switchboard", path: "~/projects/switchboard", git: "main · 3 changed", chevron: { expanded: true } } as const;

export default function SessionStatesFigure({ alt }: FigureProps) {
  return (
    <Figure name="session-states" alt={alt}>
      <Place x={0} y={0}>
        <ProjectCard {...PROJECT} live={<LiveBadge count={1} className="help-anim help-anim-live" />} />
      </Place>
      <Place x={0} y={0} className="help-anim help-anim-glow">
        <ProjectCard {...PROJECT} live={<LiveBadge count={1} />} glow />
      </Place>
      {STEPS.map(({ state, meta }, index) => (
        <Place
          key={index}
          x={16}
          y={92}
          className={index === STEPS.length - 1 ? "help-anim help-anim-step-last" : `help-anim help-anim-step help-anim-step-${index}`}
        >
          <SessionCard title="fix login" state={state} meta={meta} />
        </Place>
      ))}
    </Figure>
  );
}
