import { useEffect, useState } from "react";
import type { NodeTarget } from "../ipc";
import { useNodeHint, type Hint } from "../help/hints";

/** How long a leaving hint fades (DESIGN.md's Motion table). */
export const HINT_FADE_MS = 300;

function sameHint(a: Hint | null, b: Hint | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.text === b.text);
}

/**
 * Whether the drawn hint going from `prev` to `next` is a transient drop, which goes at once: the
 * card's toolbar shows (`drawn` false), or the handle hint went because the handle stopped
 * showing. A pane opening is not transient: `n` and `r` open one, and their hints fade like a
 * latch.
 */
export function isTransientDrop(prev: Hint | null, next: Hint | null, ctx: { drawn: boolean; handleShown: boolean }): boolean {
  if (prev === null || next !== null) return false;
  return !ctx.drawn || (prev.kind === "handle" && !ctx.handleShown);
}

/**
 * What fades out after the drawn hint went from `prev` to `next`: `prev` when it dropped out
 * (its step latched, hints were hidden, a pane opened, or its card is no longer first); nothing
 * when another hint took its place (a project ↔ handle swap), when the drop is `transient`
 * ({@link isTransientDrop}) or under reduced motion: those go at once.
 */
export function leavingAfter(prev: Hint | null, next: Hint | null, transient: boolean, reducedMotion: boolean): Hint | null {
  if (prev === null || next !== null || transient || reducedMotion) return null;
  return prev;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Story 11.3: a card's inline hint (`useNodeHint`), a mono `--text-xs` `--fg-muted` caption outside
 * the card's box that lets clicks through. `handleShown` is the card's link handle showing
 * (hovered or selected); `drawn` is false while something else stands where the hint would (the
 * session card's toolbar, which offers `review` itself). No hint is drawn while a pane is open
 * (one shown when the pane opens fades out). A hint that drops out fades over
 * {@link HINT_FADE_MS}, then unmounts. Captions are `aria-hidden`: they repeat what the card's
 * commands and the Getting started card say.
 */
export function NodeHint({ target, handleShown, drawn = true }: { target: NodeTarget; handleShown: boolean; drawn?: boolean }) {
  const { hint, paneOpen } = useNodeHint(target, handleShown);
  const current = drawn && !paneOpen ? hint : null;
  const [shown, setShown] = useState<Hint | null>(current);
  const [leaving, setLeaving] = useState<Hint | null>(null);
  if (!sameHint(shown, current)) {
    // Adjusting state while rendering (React's documented pattern for a change of props).
    setLeaving(leavingAfter(shown, current, isTransientDrop(shown, current, { drawn, handleShown }), prefersReducedMotion()));
    setShown(current);
  }
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setLeaving(null), HINT_FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  if (current !== null) return <HintCaption hint={current} leaving={false} />;
  return leaving === null || !drawn ? null : <HintCaption hint={leaving} leaving />;
}

/** The caption itself (no hooks, so a test can render it). */
export function HintCaption({ hint, leaving }: { hint: Hint; leaving: boolean }) {
  return (
    <span className={`node-hint node-hint-${hint.kind}` + (leaving ? " is-leaving" : "")} aria-hidden="true">
      {hint.text}
    </span>
  );
}
