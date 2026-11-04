import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import type { AppStateSnapshot, ChildNode, Project, WorkspaceSnapshot } from "../ipc";
import { registerBuiltins } from "../commands/builtins";
import { clearCommands } from "../commands/registry";
import { resetChecklist, useChecklistStore } from "../state/checklist";
import { resetHints, useHintsStore } from "../state/hints";
import { EMPTY_LIVE, useLiveStore } from "../state/live";
import { useStatusStore } from "../state/status";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { SessionNode } from "./ChildNode";
import { HintCaption, isTransientDrop, leavingAfter, NodeHint } from "./NodeHint";
import type { ProjectFlowNode, SessionFlowNode } from "./nodes";
import { ProjectNode } from "./ProjectNode";

function project(id: string): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded: true, color: null, launchDefaults: null, showBranches: false };
}

function session(id: string): ChildNode {
  return { id, projectId: "a", kind: "session", label: id, detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: true, branch: null };
}

function workspace(): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: [project("a"), project("b")],
      branches: [],
      sessions: [],
      edges: [],
      defaults: { model: null, effort: null, permissionMode: null },
    },
    banners: [],
    revision: 1,
    branchErrors: {},
    children: [session("s1"), session("s2")],
  };
}

function state(over: Partial<AppStateSnapshot["checklist"]> = {}, hidden: boolean | null = null): AppStateSnapshot {
  return { firstRun: true, checklist: { shown: true, dismissed: false, done: ["palette", "project"], ...over }, version: "0.1.0", lastSeenVersion: "0.1.0", hints: { hidden } };
}

function nodeProps<N extends Node>(props: { data: unknown; dragging: boolean }): NodeProps<N> {
  return props as unknown as NodeProps<N>;
}

const render = (node: ReactNode) => renderToStaticMarkup(<ReactFlowProvider>{node}</ReactFlowProvider>);

const projectData = (id: string, selected: boolean) => ({
  project: project(id),
  status: null,
  flashed: false,
  selected,
  childCount: 2,
  liveCount: 1,
  attention: false,
  branchesError: null,
});

const sessionData = (id: string, selected: boolean) => ({
  child: session(id),
  selected,
  state: { kind: "busy" },
  attention: false,
  lastLine: null,
  detail: null,
  stopping: false,
  forkedFromTitle: null,
});

const projectCard = (id: string, selected = false) => render(<ProjectNode {...nodeProps<ProjectFlowNode>({ data: projectData(id, selected), dragging: false })} />);
const sessionCard = (id: string, selected = false) => render(<SessionNode {...nodeProps<SessionFlowNode>({ data: sessionData(id, selected), dragging: false })} />);

describe("inline hints on the cards (Story 11.3)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    resetChecklist();
    resetHints();
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false, openTerminals: [], activeTerminal: null });
    useStatusStore.setState({ statuses: {} } as never);
    useWorkspaceStore.setState({ snapshot: workspace(), loadError: null });
    useLiveStore.setState({ snapshot: { ...EMPTY_LIVE, sessions: { s2: { state: { kind: "busy" } } } } as never, received: true, loadError: null });
    useChecklistStore.getState().load(state());
    useHintsStore.getState().load(state());
  });
  afterEach(() => {
    clearCommands();
    useWorkspaceStore.setState({ snapshot: null });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
  });

  it("the first project shows the project hint under it; the second none", () => {
    expect(projectCard("a")).toContain('<span class="node-hint node-hint-project" aria-hidden="true">n new session · hover for more</span>');
    expect(projectCard("b")).not.toContain("node-hint");
  });

  it("the first project, selected (handle showing), shows the handle hint instead", () => {
    const html = projectCard("a", true);
    expect(html).toContain('<span class="node-hint node-hint-handle" aria-hidden="true">drag to link · e</span>');
    expect(html).not.toContain("node-hint-project");
  });

  it("the first live session shows the review hint, not while its toolbar shows; other sessions none", () => {
    expect(sessionCard("s2")).toContain('<span class="node-hint node-hint-review" aria-hidden="true">r review changes</span>');
    expect(sessionCard("s2", true)).not.toContain("node-hint");
    expect(sessionCard("s1")).not.toContain("node-hint");
  });

  it("none while a pane is open", () => {
    useUiStore.setState({ pane: "help" });
    expect(projectCard("a")).not.toContain("node-hint");
    expect(sessionCard("s2")).not.toContain("node-hint");
  });

  it("none with the card dismissed and hidden null; back after hints.show (false)", () => {
    useChecklistStore.getState().dismiss();
    expect(projectCard("a")).not.toContain("node-hint");
    useHintsStore.getState().setHidden(false);
    expect(projectCard("a")).toContain("node-hint-project");
  });

  it("none once hidden, or once their steps are done", () => {
    useHintsStore.getState().setHidden(true);
    expect(projectCard("a")).not.toContain("node-hint");
    useHintsStore.getState().setHidden(null);
    useChecklistStore.getState().latch(["session", "review"]);
    expect(projectCard("a")).not.toContain("node-hint");
    expect(sessionCard("s2")).not.toContain("node-hint");
  });

  it("NodeHint alone renders the caption, and nothing when not drawn", () => {
    expect(renderToStaticMarkup(<NodeHint target={{ kind: "project", id: "a" }} handleShown={false} />)).toBe(
      '<span class="node-hint node-hint-project" aria-hidden="true">n new session · hover for more</span>',
    );
    expect(renderToStaticMarkup(<NodeHint target={{ kind: "session", id: "s2" }} handleShown={false} drawn={false} />)).toBe("");
  });

  it("a leaving caption carries is-leaving", () => {
    const hint = { target: { kind: "project", id: "a" }, kind: "project", text: "x" } as const;
    expect(renderToStaticMarkup(<HintCaption hint={hint} leaving />)).toBe('<span class="node-hint node-hint-project is-leaving" aria-hidden="true">x</span>');
  });
});

describe("leavingAfter: which drops fade", () => {
  const a = { target: { kind: "project", id: "a" }, kind: "project", text: "x" } as const;
  const b = { target: { kind: "project", id: "a" }, kind: "handle", text: "y" } as const;

  it("a hint that drops out for good fades", () => {
    expect(leavingAfter(a, null, false, false)).toBe(a);
  });

  it("a swap, a transient drop, reduced motion or nothing before: no fade", () => {
    expect(leavingAfter(a, b, false, false)).toBeNull();
    expect(leavingAfter(a, null, true, false)).toBeNull();
    expect(leavingAfter(a, null, false, true)).toBeNull();
    expect(leavingAfter(null, null, false, false)).toBeNull();
  });
});

describe("isTransientDrop: which drops go at once", () => {
  const project = { target: { kind: "project", id: "a" }, kind: "project", text: "x" } as const;
  const handle = { target: { kind: "project", id: "a" }, kind: "handle", text: "y" } as const;
  const shown = { drawn: true, handleShown: true };

  it("the toolbar showing (not drawn) and the handle hiding are transient", () => {
    expect(isTransientDrop(project, null, { drawn: false, handleShown: false })).toBe(true);
    expect(isTransientDrop(handle, null, { drawn: true, handleShown: false })).toBe(true);
  });

  it("a latch, hiding, or a pane opening (handle still showing, card drawn) is not: it fades", () => {
    expect(isTransientDrop(project, null, shown)).toBe(false);
    expect(isTransientDrop(project, null, { drawn: true, handleShown: false })).toBe(false);
    expect(isTransientDrop(handle, null, shown)).toBe(false);
    expect(leavingAfter(project, null, isTransientDrop(project, null, shown), false)).toBe(project);
  });

  it("a swap or nothing before is no drop", () => {
    expect(isTransientDrop(handle, project, { drawn: true, handleShown: false })).toBe(false);
    expect(isTransientDrop(null, null, { drawn: false, handleShown: false })).toBe(false);
    expect(leavingAfter(handle, project, false, false)).toBeNull();
  });
});

describe("the hint CSS", () => {
  let css = "";
  beforeEach(async () => {
    // The project has no Node typings: the slice of `node:fs` read here, as the design lint does.
    const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
    css = fs.readFileSync(new URL("./nodes.css", import.meta.url), "utf8");
  });

  it("lets clicks through, fades over 300 ms and is instant under reduced motion", () => {
    expect(css).toMatch(/\.node-hint \{[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.node-hint \{[^}]*color: var\(--fg-muted\);/);
    expect(css).toMatch(/\.node-hint \{[^}]*font-size: var\(--text-xs\);/);
    expect(css).toMatch(/\.node-hint\.is-leaving \{\s*animation: node-hint-fade 300ms ease-out forwards;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.node-hint\.is-leaving \{\s*animation: none;/);
  });
});
