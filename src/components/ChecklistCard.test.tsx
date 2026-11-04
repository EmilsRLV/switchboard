import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { clearCommands } from "../commands/registry";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { resetChecklist, useChecklistStore } from "../state/checklist";
import { resetTour, useTourStore } from "../state/tour";
import { cardOnCanvas, ChecklistCard, ChecklistCardView, ChecklistRows } from "./ChecklistCard";

describe("the Getting started card (Story 10.3)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    usePaletteStore.setState({ isOpen: false, pick: null, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false });
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
  });
  afterEach(() => clearCommands());

  it("has the title, the six rows and Dismiss; an enabled step is a button, the rest plain text", () => {
    const html = renderToStaticMarkup(<ChecklistCardView done={["palette"]} />);
    expect(html).toContain('<section class="checklist-card" aria-label="Getting started">');
    expect(html).toContain(">Getting started</h2>");
    expect(html).toContain(">Dismiss</button>");
    expect(html.match(/<li /g)).toHaveLength(6);
    // The palette always opens: a button, ticked with the muted ✓.
    expect(html).toMatch(/<li class="checklist-row is-done"><span class="checklist-tick" role="img" aria-label="done">✓<\/span><button type="button" class="checklist-step" title="Open the command palette · ctrl\+k">Open the command palette<\/button><span class="checklist-keys">ctrl\+k<\/span><\/li>/);
    // Nothing is selected, so "Start a session" cannot run now: plain text, not ticked.
    expect(html).toMatch(/<li class="checklist-row"><span class="checklist-tick" aria-hidden="true"><\/span><span class="checklist-step-text">Start a session<\/span>/);
    expect(html).toContain('<span class="checklist-step-text">Open a plain terminal</span></li>');
    expect(html).not.toContain("All done");
  });

  it("reads All done after the sixth step", () => {
    const html = renderToStaticMarkup(<ChecklistCardView done={["palette", "project", "session", "terminal", "edge", "review"]} />);
    expect(html).toContain('<p class="checklist-all-done">All done</p>');
    expect(html).not.toContain("<li");
    expect(html).toContain(">Dismiss</button>");
  });

  it("a step becomes a button when its command is enabled", () => {
    useUiStore.setState({ selection: { kind: "project", id: "p1" } as never });
    useWorkspaceStore.setState({ snapshot: { workspace: { projects: [{ id: "p1" }], edges: [] } } as never });
    const html = renderToStaticMarkup(<ChecklistRows done={[]} />);
    // Story 11.1: its tooltip is the step and the command's key (none here).
    expect(html).toContain('<button type="button" class="checklist-step" title="Open a plain terminal">Open a plain terminal</button>');
  });

  it("Story 11.6: a tour link in the header while the tour was never taken; held back while the tour is on", () => {
    const withLink = renderToStaticMarkup(<ChecklistCardView done={[]} tourDone={false} />);
    expect(withLink).toContain('<h2 class="checklist-title">Getting started</h2><button type="button" class="checklist-tour" title="Take the tour">tour</button>');
    expect(renderToStaticMarkup(<ChecklistCardView done={[]} tourDone />)).not.toContain("checklist-tour");

    // The card itself: shown with the link, nothing while the tour is on, no link once taken.
    resetChecklist();
    resetTour();
    useChecklistStore.setState({ loaded: true, shown: true, dismissed: false, allDoneAtLoad: false });
    expect(renderToStaticMarkup(<ChecklistCard />)).toContain("checklist-tour");
    useTourStore.setState({ on: true });
    expect(renderToStaticMarkup(<ChecklistCard />)).toBe("");
    useTourStore.setState({ on: false, done: true });
    const after = renderToStaticMarkup(<ChecklistCard />);
    expect(after).toContain('aria-label="Getting started"');
    expect(after).not.toContain("checklist-tour");
    resetChecklist();
    resetTour();
    // Held back while the tour is on; back (as Story 10.3 says) when it ends.
    expect(cardOnCanvas(true, false)).toBe(true);
    expect(cardOnCanvas(true, true)).toBe(false);
    expect(cardOnCanvas(false, false)).toBe(false);
  });
});
