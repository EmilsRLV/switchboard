import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { clearCommands } from "../commands/registry";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { ChecklistCardView, ChecklistRows } from "./ChecklistCard";

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
    expect(html).toMatch(/<li class="checklist-row is-done"><span class="checklist-tick" role="img" aria-label="done">✓<\/span><button type="button" class="checklist-step">Open the command palette<\/button><span class="checklist-keys">ctrl\+k<\/span><\/li>/);
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
    expect(html).toContain('<button type="button" class="checklist-step">Open a plain terminal</button>');
  });
});
