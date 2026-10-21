import { describe, expect, it } from "vitest";
import type { ChildNode, Edge, NodeRef, Project } from "../ipc";
import {
  LINK_SOURCE_HANDLE,
  LINK_SOURCE_LEFT_HANDLE,
  LINK_TARGET_HANDLE,
  LINK_TARGET_RIGHT_HANDLE,
  REFUSE_DUPLICATE,
  REFUSE_NOT_A_NODE,
  REFUSE_FOLDER,
  REFUSE_FROM_BRANCH,
  REFUSE_PROJECT_TO_SESSION,
  REFUSE_SELF,
  checkFlowLink,
  checkLink,
  drawnFlowIds,
  edgeAriaLabel,
  edgeChoices,
  isEdgeDrawn,
  edgeSides,
  edgeKindFor,
  endText,
  flowIdOfRef,
  isDuplicateEdge,
  linkFlowEdges,
  linkTargets,
  nodeRefOf,
  nodeRefOfFlowId,
} from "./edges";
import { SHOW_LIMIT, flowIdOf, parseFlowId, toFlowNodes } from "./nodes";

const project = (id: string, expanded = true, x = 0): Project => ({
  id,
  path: `/p/${id}`,
  label: id,
  position: { x, y: 0 },
  expanded,
  color: null,
  launchDefaults: null,
  showBranches: false,
});

const session = (id: string, projectId: string, label = id): ChildNode => ({
  id,
  projectId,
  kind: "session",
  label,
  detail: "stub",
  position: null,
  session: null,
  branchId: null,
  forkedFrom: null,
  hasTranscript: false,
  branch: null,
});

const branch = (projectId: string, name: string): ChildNode => ({
  ...session(`${projectId}:${name}`, projectId, name),
  kind: "branch",
  detail: null,
  branch: { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null },
});

const ref = (type: NodeRef["type"], id: string): NodeRef => ({ type, id });

const edge = (id: string, from: NodeRef, to: NodeRef, kind: Edge["kind"] = "context", label: string | null = null): Edge => ({
  id,
  from,
  to,
  kind,
  label,
  createdAt: "2026-10-21T10:00:00.000Z",
});

describe("edgeKindFor (Rust's graph::edge_kind, mirrored)", () => {
  it("picks context or cooperate from the pair and refuses the rest with Rust's words", () => {
    expect(edgeKindFor(ref("session", "s"), ref("project", "p")).kind).toBe("context");
    expect(edgeKindFor(ref("session", "s"), ref("branch", "p:b")).kind).toBe("context");
    expect(edgeKindFor(ref("project", "p"), ref("project", "q")).kind).toBe("context");
    expect(edgeKindFor(ref("project", "p"), ref("branch", "q:b")).kind).toBe("context");
    expect(edgeKindFor(ref("session", "a"), ref("session", "b")).kind).toBe("cooperate");
    expect(edgeKindFor(ref("project", "p"), ref("session", "s"))).toEqual({ kind: null, reason: "can't link a project to a session" });
    expect(REFUSE_PROJECT_TO_SESSION).toBe("can't link a project to a session");
    for (const to of ["project", "branch", "session"] as const) {
      expect(edgeKindFor(ref("branch", "p:b"), ref(to, "x")).reason).toBe(REFUSE_FROM_BRANCH);
    }
    expect(edgeKindFor(ref("session", "s"), ref("session", "s")).reason).toBe(REFUSE_SELF);
    expect(edgeKindFor(ref("project", "p"), ref("project", "p")).reason).toBe(REFUSE_SELF);
    expect(edgeKindFor(ref("session", "s"), ref("folder", "/x")).reason).toBe(REFUSE_FOLDER);
    expect(edgeKindFor(ref("folder", "/x"), ref("project", "p")).reason).toBe(REFUSE_FOLDER);
  });

  it("refuses a duplicate: the same kind and ends, either direction for cooperate", () => {
    const edges = [edge("c", ref("session", "b"), ref("session", "a"), "cooperate"), edge("x", ref("project", "p"), ref("project", "q"))];
    expect(isDuplicateEdge(edges, "cooperate", ref("session", "a"), ref("session", "b"))).toBe(true);
    expect(checkLink(edges, ref("session", "a"), ref("session", "b"))).toEqual({ kind: null, reason: REFUSE_DUPLICATE });
    expect(checkLink(edges, ref("session", "b"), ref("session", "a")).reason).toBe("already linked");
    expect(checkLink(edges, ref("project", "p"), ref("project", "q")).reason).toBe("already linked");
    expect(checkLink(edges, ref("project", "q"), ref("project", "p")).kind).toBe("context");
    expect(checkLink(edges, ref("session", "a"), ref("session", "c")).kind).toBe("cooperate");
  });

  it("maps flow ids to edge ends and back; a more row or an edge is no end", () => {
    expect(nodeRefOfFlowId("p1")).toEqual(ref("project", "p1"));
    expect(nodeRefOfFlowId("session:s1")).toEqual(ref("session", "s1"));
    expect(nodeRefOfFlowId("branch:p1:main")).toEqual(ref("branch", "p1:main"));
    expect(nodeRefOfFlowId("more:p1")).toBeNull();
    expect(nodeRefOfFlowId("edge:e1")).toBeNull();
    expect(nodeRefOf(null)).toBeNull();
    expect(flowIdOfRef(ref("project", "p1"))).toBe("p1");
    expect(flowIdOfRef(ref("session", "s1"))).toBe("session:s1");
    expect(flowIdOfRef(ref("branch", "p1:main"))).toBe("branch:p1:main");
    expect(flowIdOfRef(ref("folder", "/x"))).toBeNull();
    expect(parseFlowId("edge:e1")).toEqual({ kind: "edge", id: "e1" });
    expect(flowIdOf({ kind: "edge", id: "e1" })).toBe("edge:e1");
    expect(checkFlowLink([], "session:s1", "p1").kind).toBe("context");
    expect(checkFlowLink([], "p1", "session:s1").reason).toBe(REFUSE_PROJECT_TO_SESSION);
    // A drop on a `more` row is refused with no notice to show.
    expect(checkFlowLink([], "session:s1", "more:p1")).toEqual({ kind: null, reason: REFUSE_NOT_A_NODE });
    expect(REFUSE_NOT_A_NODE).toBe("");
  });
});

describe("linkFlowEdges", () => {
  // `a`'s column at x 80, `b`'s at x 560.
  const projects = [project("a", true, 80), project("b", true, 560)];
  const children = [session("s1", "a"), session("s2", "b"), branch("b", "main")];
  const nodes = (ps = projects, kids = children) => toFlowNodes({ projects: ps, statuses: {}, flashed: [], children: kids, selection: null, dragging: {} });

  it("draws each stored edge between drawn cards, from the link handle, with its kind, label and selection", () => {
    const edges = [
      edge("e1", ref("session", "s1"), ref("project", "b"), "context", "API shape"),
      edge("e2", ref("session", "s1"), ref("session", "s2"), "cooperate"),
      edge("e3", ref("project", "a"), ref("branch", "b:main")),
    ];
    const drawn = linkFlowEdges(edges, nodes(), { kind: "edge", id: "e2" });
    expect(drawn.map((e) => [e.id, e.source, e.target, e.type, e.className])).toEqual([
      ["edge:e1", "session:s1", "b", "context", "link-edge"],
      ["edge:e2", "session:s1", "session:s2", "cooperate", "link-edge is-selected"],
      ["edge:e3", "a", "branch:b:main", "context", "link-edge"],
    ]);
    expect(drawn[0]).toMatchObject({
      sourceHandle: LINK_SOURCE_HANDLE,
      targetHandle: LINK_TARGET_HANDLE,
      selectable: false,
      focusable: false,
      deletable: false,
      data: { edgeId: "e1", label: "API shape", selected: false },
      ariaLabel: "context edge: API shape",
    });
    expect(drawn[1]?.data).toEqual({ edgeId: "e2", label: null, selected: true });
    expect(edgeAriaLabel({ kind: "cooperate", label: null })).toBe("cooperate edge");
  });

  it("ends an edge between two cards of one column on the target's right edge, so it curves out and back", () => {
    const right = { sourceHandle: LINK_SOURCE_HANDLE, targetHandle: LINK_TARGET_HANDLE };
    const back = { sourceHandle: LINK_SOURCE_LEFT_HANDLE, targetHandle: LINK_TARGET_RIGHT_HANDLE };
    const out = { sourceHandle: LINK_SOURCE_HANDLE, targetHandle: LINK_TARGET_RIGHT_HANDLE };
    // Same column: both right, whatever the x.
    expect(edgeSides({ column: "a", x: 96 }, { column: "a", x: 80 })).toEqual(out);
    // Target column to the left: leave left, enter right.
    expect(edgeSides({ column: "b", x: 576 }, { column: "a", x: 80 })).toEqual(back);
    // Target column to the right: leave right (the handle), enter left.
    expect(edgeSides({ column: "a", x: 96 }, { column: "b", x: 560 })).toEqual(right);
    expect(edgeSides(undefined, undefined)).toEqual(right);
    const withBranch = [project("a", true, 80), { ...project("b", true, 560), showBranches: true }];
    const edges = [
      edge("own", ref("session", "s1"), ref("project", "a")),
      edge("own-branch", ref("project", "b"), ref("branch", "b:main")),
      edge("across", ref("session", "s1"), ref("session", "s2"), "cooperate"),
      edge("leftward", ref("session", "s2"), ref("project", "a")),
    ];
    const drawn = linkFlowEdges(edges, nodes(withBranch), null);
    expect(drawn.map((e) => [e.id, e.sourceHandle, e.targetHandle])).toEqual([
      ["edge:own", LINK_SOURCE_HANDLE, LINK_TARGET_RIGHT_HANDLE],
      ["edge:own-branch", LINK_SOURCE_HANDLE, LINK_TARGET_RIGHT_HANDLE],
      ["edge:across", LINK_SOURCE_HANDLE, LINK_TARGET_HANDLE],
      ["edge:leftward", LINK_SOURCE_LEFT_HANDLE, LINK_TARGET_RIGHT_HANDLE],
    ]);
  });

  it("knows which edges are drawn and lists a node's drawn edges for Select edge…", () => {
    const edges = [
      edge("e1", ref("session", "s1"), ref("project", "b"), "context", "API shape"),
      edge("e2", ref("session", "s2"), ref("session", "s1"), "cooperate"),
      edge("hidden", ref("session", "s1"), ref("branch", "b:gone")),
    ];
    const drawn = drawnFlowIds(projects, children, [], []);
    expect(isEdgeDrawn(edges[0] as Edge, drawn)).toBe(true);
    expect(isEdgeDrawn(edges[2] as Edge, drawn)).toBe(false);
    expect(edgeChoices(ref("session", "s1"), edges, drawn, projects, children)).toEqual([
      { id: "e1", title: "context: b — API shape" },
      { id: "e2", title: "cooperate: s2 (b)" },
    ]);
    expect(isEdgeDrawn(edges[0] as Edge, drawnFlowIds([project("a", false), project("b")], children, [], []))).toBe(false);
  });

  it("leaves out an edge whose end is not drawn -- collapsed, cut by the limit, unlisted or a folder -- without touching the list", () => {
    const edges = [
      edge("collapsed", ref("session", "s1"), ref("project", "b")),
      edge("unlisted", ref("project", "a"), ref("branch", "b:gone")),
      edge("folder", ref("project", "a"), ref("folder", "/x")),
      edge("p2p", ref("project", "a"), ref("project", "b")),
    ];
    const collapsed = [project("a", false), project("b")];
    expect(linkFlowEdges(edges, nodes(collapsed), null).map((e) => e.id)).toEqual(["edge:p2p"]);
    // Past the limit the eleventh session is hidden, and so is its edge.
    const many = Array.from({ length: SHOW_LIMIT + 1 }, (_, i) => session(`k${i}`, "a"));
    const cut = [edge("cut", ref("session", `k${SHOW_LIMIT}`), ref("project", "b")), edge("kept", ref("session", "k0"), ref("project", "b"))];
    expect(linkFlowEdges(cut, nodes(projects, many), null).map((e) => e.id)).toEqual(["edge:kept"]);
    expect(edges).toHaveLength(4);
  });
});

describe("linkTargets and endText", () => {
  const projects = [project("a"), project("b", false)];
  const children = [session("s1", "a", "fix login"), branch("a", "main"), session("s2", "b", "api"), session("s3", "a", "docs")];

  it("lists every valid target in canvas order (projects, then their sessions, then their branches), titled kind: label (project)", () => {
    const edges = [edge("x", ref("session", "s3"), ref("session", "s1"), "cooperate")];
    const fromSession = linkTargets(ref("session", "s1"), projects, children, edges);
    expect(fromSession.map((t) => t.title)).toEqual([
      "context: a (a)",
      "context: main (a)",
      "context: b (b)",
      "cooperate: api (b)",
    ]);
    expect(fromSession[1]).toEqual({ id: "branch:a:main", to: ref("branch", "a:main"), kind: "context", title: "context: main (a)" });
    // A project links to projects and branches only, never itself or a session.
    expect(linkTargets(ref("project", "a"), projects, children, []).map((t) => t.title)).toEqual(["context: main (a)", "context: b (b)"]);
  });

  it("names an edge end by its label and project", () => {
    expect(endText(ref("project", "a"), projects, children)).toEqual({ label: "a", project: null });
    expect(endText(ref("session", "s2"), projects, children)).toEqual({ label: "api", project: "b" });
    expect(endText(ref("branch", "a:main"), projects, children)).toEqual({ label: "main", project: "a" });
    expect(endText(ref("session", "gone"), projects, children)).toEqual({ label: "session gone", project: null });
  });
});
