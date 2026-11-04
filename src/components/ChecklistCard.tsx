import { useEffect, useReducer } from "react";
import { commandHint } from "../commands/keybindings";
import { isCommandEnabled, runCommand } from "../commands/registry";
import { CHECKLIST_STEPS, subscribeSources, type StepId } from "../help/checklist";
import { useCanvasStore } from "../state/canvas";
import { cardVisible, isChecklistComplete, useChecklistStore } from "../state/checklist";

/**
 * Re-render whenever a store that decides a step command's `when` (or a tick) changes, so a row's
 * button appears and goes as its command is enabled.
 */
export function useStepCommandsRefresh(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stopSources = subscribeSources(bump);
    const stopCanvas = useCanvasStore.subscribe(bump);
    return () => {
      stopSources();
      stopCanvas();
    };
  }, []);
}

/**
 * The six steps (Story 10.3), on the card and on the Help page: a step whose command is enabled
 * now is a button that runs it, otherwise plain text; a ticked step shows a muted `✓`.
 */
export function ChecklistRows({ done }: { done: readonly StepId[] }) {
  return (
    <ol className="checklist-rows">
      {CHECKLIST_STEPS.map((step) => {
        const ticked = done.includes(step.id);
        return (
          <li key={step.id} className={ticked ? "checklist-row is-done" : "checklist-row"}>
            {ticked ? (
              <span className="checklist-tick" role="img" aria-label="done">
                ✓
              </span>
            ) : (
              <span className="checklist-tick" aria-hidden="true" />
            )}
            {isCommandEnabled(step.command) ? (
              <button type="button" className="checklist-step" title={commandHint(step.command, step.title)} onClick={() => runCommand(step.command)}>
                {step.title}
              </button>
            ) : (
              <span className="checklist-step-text">{step.title}</span>
            )}
            {step.keys !== null && <span className="checklist-keys">{step.keys}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The card itself: title, the rows (or `All done`), Dismiss. */
export function ChecklistCardView({ done }: { done: readonly StepId[] }) {
  return (
    <section className="checklist-card" aria-label="Getting started">
      <header className="checklist-header">
        <h2 className="checklist-title">Getting started</h2>
        <button type="button" className="btn checklist-dismiss" title={commandHint("checklist.dismiss")} onClick={() => runCommand("checklist.dismiss")}>
          Dismiss
        </button>
      </header>
      {isChecklistComplete(done) ? <p className="checklist-all-done">All done</p> : <ChecklistRows done={done} />}
    </section>
  );
}

/**
 * The Getting started card (Story 10.3) at the canvas's top-right, under the notice line: over
 * the canvas, below panes, the palette, the menu and toasts. Information, not a wizard: no
 * overlay, no accent, no motion. It shows on a fresh profile until dismissed, and after all six
 * steps reads `All done` until the next launch.
 */
export function ChecklistCard() {
  const visible = useChecklistStore(cardVisible);
  return visible ? <ShownChecklistCard /> : null;
}

/** The card while it shows: only then does it follow the stores its rows' commands read. */
function ShownChecklistCard() {
  const done = useChecklistStore((s) => s.done);
  useStepCommandsRefresh();
  return <ChecklistCardView done={done} />;
}
