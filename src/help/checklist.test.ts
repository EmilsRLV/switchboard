import { describe, expect, it } from "vitest";
import type { LiveSession, SessionState, TermInfo } from "../ipc";
import { CHECKLIST_STEPS, detectSteps, isStepId, normaliseSteps, STEP_IDS, type ChecklistSources } from "./checklist";

function sources(over: Partial<ChecklistSources> = {}): ChecklistSources {
  return { paletteOpen: false, projectCount: 0, edgeCount: 0, terminals: {}, sessions: {}, pane: null, reviewTarget: false, ...over };
}

function term(id: string, kind: TermInfo["kind"], over: Partial<TermInfo> = {}): TermInfo {
  return { id, kind, project_id: "p1", title: "t", cwd: "/x", exited: null, error: null, cols: 80, rows: 24, stopping: false, ...over };
}

function live(state: SessionState): LiveSession {
  return { state, source: "app", pid: 1, kind: null, name: null, project_id: "p1", cwd: "/x", started_at: null, attention_since: null, last_line: null, detail: null };
}

const detected = (s: ChecklistSources) => [...detectSteps(s)].sort();

describe("the Getting started steps", () => {
  it("are the six steps in order, with their keys and commands", () => {
    expect(CHECKLIST_STEPS.map((s) => [s.id, s.title, s.keys, s.command])).toEqual([
      ["palette", "Open the command palette", "ctrl+k", "palette.toggle"],
      ["project", "Add a project", "ctrl+o or drop a folder", "project.add"],
      ["session", "Start a session", "n on a project node", "project.newSession"],
      ["terminal", "Open a plain terminal", null, "project.terminal"],
      ["edge", "Link two nodes", "e", "edge.link"],
      ["review", "Review changes", "r", "review.changes"],
    ]);
    expect(STEP_IDS).toEqual(["palette", "project", "session", "terminal", "edge", "review"]);
    expect(isStepId("edge")).toBe(true);
    expect(isStepId("wizard")).toBe(false);
    expect(normaliseSteps(["review", "nope", "palette", "review"])).toEqual(["palette", "review"]);
  });

  it("nothing is ticked on an empty app", () => {
    expect(detected(sources())).toEqual([]);
  });

  it("palette: the palette is open (as a pick list too)", () => {
    expect(detected(sources({ paletteOpen: true }))).toEqual(["palette"]);
  });

  it("project: a project is on the canvas", () => {
    expect(detected(sources({ projectCount: 1 }))).toEqual(["project"]);
  });

  it("session: a Switchboard session terminal whose session got past starting, by any route", () => {
    const terminals = { "session:s1": term("session:s1", "session") };
    for (const kind of ["busy", "idle", "waiting", "finished"] as const) {
      expect(detected(sources({ terminals, sessions: { s1: live({ kind }) } })), kind).toEqual(["session"]);
    }
  });

  it("session: starting alone does not count, nor exited, nor a session with no terminal of ours", () => {
    const terminals = { "session:s1": term("session:s1", "session") };
    expect(detected(sources({ terminals, sessions: { s1: live({ kind: "starting" }) } }))).toEqual([]);
    expect(detected(sources({ terminals, sessions: { s1: live({ kind: "exited" }) } }))).toEqual([]);
    expect(detected(sources({ terminals, sessions: {} }))).toEqual([]);
    expect(detected(sources({ sessions: { s1: live({ kind: "busy" }) } }))).toEqual([]);
  });

  it("terminal: a plain terminal was opened (one whose shell could not start does not count)", () => {
    expect(detected(sources({ terminals: { "plain-p1": term("plain-p1", "plain") } }))).toEqual(["terminal"]);
    expect(detected(sources({ terminals: { "plain-p1": term("plain-p1", "plain", { exited: 0 }) } }))).toEqual(["terminal"]);
    expect(detected(sources({ terminals: { "plain-p1": term("plain-p1", "plain", { error: "could not start sh: x", exited: -1 }) } }))).toEqual([]);
  });

  it("edge: an edge is drawn", () => {
    expect(detected(sources({ edgeCount: 2 }))).toEqual(["edge"]);
  });

  it("review: the Review pane shows a target", () => {
    expect(detected(sources({ pane: "review", reviewTarget: true }))).toEqual(["review"]);
    expect(detected(sources({ pane: "review", reviewTarget: false }))).toEqual([]);
    expect(detected(sources({ pane: "help", reviewTarget: true }))).toEqual([]);
  });
});
