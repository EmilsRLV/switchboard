import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTourStore } from "../state/tour";
import type { SessionState, WorkspaceSnapshot } from "../ipc";
import { resetChecklist, useChecklistStore } from "../state/checklist";
import { resetHints, useHintsStore } from "../state/hints";
import { EMPTY_LIVE, useLiveStore } from "../state/live";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { registerBuiltins } from "../commands/builtins";
import { applyBindingOverrides, clearBindingOverrides, clearCommands } from "../commands/registry";
import { anyHintStepUndone, firstLiveSession, hintKeys, hintsFor, hintText, MAX_HINTS, subscribeHintSources, type HintChild, type HintSources } from "./hints";
import type { StepId } from "./checklist";

const KEYS = { project: "n", handle: "e", review: "r" } as const;

function sources(over: Partial<HintSources> = {}): HintSources {
  return {
    projects: [
      { id: "a", expanded: true },
      { id: "b", expanded: true },
    ],
    children: [],
    sessions: {},
    showAll: [],
    showAllBranches: [],
    handleShown: false,
    cardVisible: true,
    paneOpen: false,
    keys: KEYS,
    ...over,
  };
}

const busy: SessionState = { kind: "busy" };
const exited: SessionState = { kind: "exited" };

function child(id: string, kind: HintChild["kind"] = "session", projectId = "a"): HintChild {
  return { id, kind, projectId, position: null, branchId: null };
}

/** Two sessions under `a`: `s1` exited, `s2` busy; a branch between them. */
const LIVE: Partial<HintSources> = {
  children: [child("s1"), child("br", "branch"), child("s2"), child("s3")],
  sessions: { s1: { state: exited }, s2: { state: busy }, s3: { state: busy } },
};

const short = (s: HintSources, done: readonly StepId[] = [], hidden: boolean | null = null) =>
  hintsFor(s, done, hidden).map((h) => [h.kind, `${h.target.kind}:${h.target.id}`, h.text]);

describe("hintsFor (Story 11.3)", () => {
  it("project: under the first project, until session is done", () => {
    expect(short(sources())).toEqual([["project", "project:a", "n new session · hover for more"]]);
    expect(short(sources(), ["session"])).toEqual([]);
  });

  it("handle: on the first project while its handle shows, replacing the project hint, until edge is done", () => {
    expect(short(sources({ handleShown: true }))).toEqual([["handle", "project:a", "drag to link · e"]]);
    // Edge done: the project hint is back while the handle shows.
    expect(short(sources({ handleShown: true }), ["edge"])).toEqual([["project", "project:a", "n new session · hover for more"]]);
    expect(short(sources({ handleShown: true }), ["edge", "session"])).toEqual([]);
    // Session done but not edge: the handle hint still shows on hover, nothing otherwise.
    expect(short(sources({ handleShown: true }), ["session"])).toEqual([["handle", "project:a", "drag to link · e"]]);
    expect(short(sources(), ["session"])).toEqual([]);
  });

  it("review: right of the first session child in a live state (snapshot order), until review is done", () => {
    expect(short(sources(LIVE))).toEqual([
      ["project", "project:a", "n new session · hover for more"],
      ["review", "session:s2", "r review changes"],
    ]);
    expect(short(sources(LIVE), ["session", "review"])).toEqual([]);
    expect(firstLiveSession({ ...sources(LIVE), sessions: {} })).toBeNull();
  });

  it("review: only on a drawn card -- not under a collapsed project, nor one cut by show all", () => {
    // `s2` under a collapsed `a`: the first drawn live session is `t1` under `b`.
    const collapsed = sources({
      ...LIVE,
      projects: [
        { id: "a", expanded: false },
        { id: "b", expanded: true },
      ],
      children: [...LIVE.children!, child("t1", "session", "b")],
      sessions: { ...LIVE.sessions, t1: { state: busy } },
    });
    expect(firstLiveSession(collapsed)).toBe("t1");
    expect(firstLiveSession({ ...collapsed, children: LIVE.children! })).toBeNull();
    // Eleven sessions under `a`, only the eleventh live: cut by the ten-row limit until show all.
    const many = Array.from({ length: 11 }, (_, i) => child(`m${i}`));
    const cut = sources({ children: many, sessions: { m10: { state: busy } } });
    expect(firstLiveSession(cut)).toBeNull();
    expect(firstLiveSession({ ...cut, showAll: ["a"] })).toBe("m10");
  });

  it("at most one per card and three in all; never on a non-first card", () => {
    const hints = hintsFor(sources({ ...LIVE, handleShown: true }), [], null);
    expect(hints.length).toBeLessThanOrEqual(MAX_HINTS);
    const targets = hints.map((h) => `${h.target.kind}:${h.target.id}`);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).not.toContain("project:b");
    expect(targets).not.toContain("session:s3");
  });

  it("nothing to compute once session, edge and review are done", () => {
    expect(anyHintStepUndone(["session", "edge"])).toBe(true);
    expect(anyHintStepUndone(["palette", "session", "edge", "review"])).toBe(false);
  });

  it("latched steps end their hints for good", () => {
    expect(short(sources({ ...LIVE, handleShown: true }), ["session", "edge", "review"])).toEqual([]);
  });

  it("hidden: null follows the card, false shows without it, true hides", () => {
    expect(short(sources({ cardVisible: false }), [], null)).toEqual([]);
    expect(short(sources({ cardVisible: false }), [], false)).toHaveLength(1);
    expect(short(sources(), [], true)).toEqual([]);
    expect(short(sources(), [], false)).toHaveLength(1);
  });

  it("none while a pane is open", () => {
    expect(short(sources({ ...LIVE, paneOpen: true }))).toEqual([]);
    expect(short(sources({ paneOpen: true }), [], false)).toEqual([]);
  });

  it("no projects: no project hint", () => {
    expect(short(sources({ projects: [] }))).toEqual([]);
  });

  it("texts without a key leave just the words", () => {
    expect(hintText("project", null)).toBe("new session · hover for more");
    expect(hintText("handle", null)).toBe("drag to link");
    expect(hintText("review", null)).toBe("review changes");
  });
});

describe("hint keys from the registry", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
  });
  afterEach(() => {
    clearBindingOverrides();
    clearCommands();
  });

  it("are the default keys, and follow a rebind", () => {
    expect(hintKeys()).toEqual({ project: "n", handle: "e", review: "r" });
    applyBindingOverrides({ "project.newSession": "ctrl+shift+n", "edge.link": null });
    expect(hintKeys()).toEqual({ project: "ctrl+shift+n", handle: null, review: "r" });
  });
});

describe("subscribeHintSources", () => {
  const workspace = { workspace: { projects: [] }, children: [] } as unknown as WorkspaceSnapshot;
  const state = { firstRun: false, checklist: { shown: true, dismissed: false, done: [] }, version: "0.1.0", lastSeenVersion: "0.1.0", hints: { hidden: null }, tour: { done: false } };

  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    resetChecklist();
    resetHints();
    useChecklistStore.getState().load(state);
    useHintsStore.getState().load(state);
  });
  afterEach(() => {
    clearBindingOverrides();
    clearCommands();
    useUiStore.setState({ pane: null });
    useWorkspaceStore.setState({ snapshot: null });
    useLiveStore.setState({ snapshot: EMPTY_LIVE });
  });

  it("fires on each source it reads, and not after unsubscribe", () => {
    const listener = vi.fn();
    const stop = subscribeHintSources(listener);
    const fired = (change: () => void) => {
      listener.mockClear();
      change();
      return listener.mock.calls.length > 0;
    };
    expect(fired(() => useChecklistStore.getState().latch(["edge"]))).toBe(true);
    expect(fired(() => useHintsStore.getState().setHidden(true))).toBe(true);
    expect(fired(() => useUiStore.setState({ pane: "help" }))).toBe(true);
    expect(fired(() => useWorkspaceStore.setState({ snapshot: workspace }))).toBe(true);
    expect(fired(() => useLiveStore.setState({ snapshot: { ...EMPTY_LIVE } }))).toBe(true);
    expect(fired(() => applyBindingOverrides({ "edge.link": "ctrl+e" }))).toBe(true);
    // Story 11.6: the tour holds hints back.
    expect(fired(() => useTourStore.setState({ on: true }))).toBe(true);
    useTourStore.setState({ on: false });
    stop();
    expect(fired(() => useUiStore.setState({ pane: null }))).toBe(false);
    expect(fired(() => applyBindingOverrides({}))).toBe(false);
  });
});
