import { describe, expect, it } from "vitest";
import type { ChildNode, Project, ProjectStatusMap } from "../ipc";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CHILD_GAP,
  CHILD_HEIGHT,
  CHILD_WIDTH,
  COLUMN_INDENT,
  COLUMN_TOP,
  DRAG_THRESHOLD,
  LIVE_SESSIONS,
  REVEAL_MARGIN,
  REVEAL_PAN_MS,
  aheadBehind,
  cardTopLeft,
  chevronCommandId,
  childFlowId,
  columnSlot,
  dropTarget,
  flowIdOf,
  layoutChildren,
  nearestInDirection,
  nearestToPoint,
  nodeRects,
  panToReveal,
  parseFlowId,
  physicalToClient,
  rightClickTarget,
  shortenPath,
  statusLine,
  toFlowNodes,
  type FlowInputs,
  type NodeRect,
  type ProjectFlowNode,
} from "./nodes";

function project(id: string, path: string, x = 0, y = 0, expanded = false): Project {
  return {
    id,
    path,
    label: path.split(/[\\/]/).pop() ?? path,
    position: { x, y },
    expanded,
    color: null,
    launchDefaults: null,
  };
}

function stub(index: number, projectId: string, position: ChildNode["position"] = null): ChildNode {
  return { id: `stub-${index}-${projectId}`, projectId, kind: "session", label: `session ${index}`, detail: "stub", position };
}

function inputs(over: Partial<FlowInputs> = {}): FlowInputs {
  return { projects: [], statuses: {}, flashed: [], children: [], selection: null, dragging: {}, ...over };
}

/** Narrow a node to a project node (and fail loudly otherwise). */
function asProject(node: ReturnType<typeof toFlowNodes>[number] | undefined): ProjectFlowNode {
  if (node === undefined || node.type !== "project") throw new Error(`not a project node: ${node?.id}`);
  return node;
}

describe("toFlowNodes", () => {
  const projects = [project("a", "B:\\projects\\ide", 10, 20), project("b", "/home/me/src", -5, 7)];
  const statuses: ProjectStatusMap = {
    a: { kind: "repo", branch: "master", detached: false, dirty: 3, ahead: 0, behind: 0 },
  };

  it("makes one draggable, never xyflow-selectable project node per workspace project at its stored position", () => {
    const nodes = toFlowNodes(inputs({ projects, statuses }));
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(nodes[0]?.type).toBe("project");
    expect(nodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(nodes[1]?.position).toEqual({ x: -5, y: 7 });
    expect(nodes[0]?.draggable).toBe(true);
    expect(nodes[0]?.selectable).toBe(false);
    expect(nodes[0]?.connectable).toBe(false);
    expect(nodes[0]?.parentId).toBeUndefined();
    expect(asProject(nodes[0]).data.project).toBe(projects[0]);
    expect(asProject(nodes[0]).data.childCount).toBe(0);
    expect(asProject(nodes[0]).data.selected).toBe(false);
  });

  it("attaches the project's status, or null while unpolled, and the flash flag", () => {
    const nodes = toFlowNodes(inputs({ projects, statuses, flashed: ["b"] }));
    expect(asProject(nodes[0]).data.status).toEqual(statuses.a);
    expect(asProject(nodes[1]).data.status).toBeNull();
    expect(asProject(nodes[0]).data.flashed).toBe(false);
    expect(asProject(nodes[1]).data.flashed).toBe(true);
  });

  it("is empty for an empty workspace", () => {
    expect(toFlowNodes(inputs())).toEqual([]);
  });

  it("counts a collapsed project's children on the card and lists none of them", () => {
    const children = [stub(1, "a"), stub(2, "a"), stub(3, "a"), stub(1, "b")];
    const nodes = toFlowNodes(inputs({ projects, children }));
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(asProject(nodes[0]).data.childCount).toBe(3);
    expect(asProject(nodes[1]).data.childCount).toBe(1);
  });

  it("lays an expanded project's children out in a column under it, relative to the card, with parentId", () => {
    const expanded = [project("a", "B:\\projects\\ide", 10, 20, true), projects[1]!];
    const children = [stub(1, "a"), stub(2, "a"), stub(3, "a"), stub(1, "b")];
    const nodes = toFlowNodes(inputs({ projects: expanded, children }));
    expect(nodes.map((n) => n.id)).toEqual(["a", "session:stub-1-a", "session:stub-2-a", "session:stub-3-a", "b"]);
    const kids = nodes.slice(1, 4);
    expect(kids.map((n) => n.type)).toEqual(["session", "session", "session"]);
    expect(kids.map((n) => n.parentId)).toEqual(["a", "a", "a"]);
    expect(kids.map((n) => n.position)).toEqual([
      { x: 16, y: 92 },
      { x: 16, y: 140 },
      { x: 16, y: 188 },
    ]);
    expect(kids.every((n) => n.draggable === true && n.selectable === false && n.connectable === false)).toBe(true);
    expect(kids[1]?.type === "session" && kids[1].data.child).toBe(children[1]);
    expect(asProject(nodes[0]).data.childCount).toBe(3);
  });

  it("a dragged child keeps its stored (relative) position while the others keep their slots", () => {
    const expanded = [project("a", "/p/a", 0, 0, true)];
    const children = [stub(1, "a"), stub(2, "a", { x: 260, y: 40 }), stub(3, "a")];
    const nodes = toFlowNodes(inputs({ projects: expanded, children }));
    expect(nodes.slice(1).map((n) => n.position)).toEqual([
      { x: 16, y: 92 },
      { x: 260, y: 40 },
      { x: 16, y: 188 },
    ]);
  });

  it("branch children come as branch nodes with their own flow id", () => {
    const expanded = [project("a", "/p/a", 0, 0, true)];
    const branch: ChildNode = { id: "br1", projectId: "a", kind: "branch", label: "main", detail: "/p/a/.worktrees/x", position: null };
    const nodes = toFlowNodes(inputs({ projects: expanded, children: [stub(1, "a"), branch] }));
    expect(nodes[2]?.id).toBe("branch:br1");
    expect(nodes[2]?.type).toBe("branch");
    expect(nodes[2]?.position).toEqual({ x: 16, y: 140 });
  });

  it("marks exactly the selected node, project or child", () => {
    const expanded = [project("a", "/p/a", 0, 0, true), projects[1]!];
    const children = [stub(1, "a"), stub(2, "a")];
    const projectSelected = toFlowNodes(inputs({ projects: expanded, children, selection: { kind: "project", id: "a" } }));
    expect(projectSelected.map((n) => n.data.selected)).toEqual([true, false, false, false]);
    const childSelected = toFlowNodes(inputs({ projects: expanded, children, selection: { kind: "session", id: "stub-2-a" } }));
    expect(childSelected.map((n) => n.data.selected)).toEqual([false, false, true, false]);
    // A child id that happens to equal a project id is not confused with it.
    const other = toFlowNodes(inputs({ projects: expanded, children, selection: { kind: "session", id: "a" } }));
    expect(other.map((n) => n.data.selected)).toEqual([false, false, false, false]);
    expect(projectSelected.every((n) => n.selected === undefined)).toBe(true);
  });

  it("drag overrides win over stored positions, by flow id", () => {
    const expanded = [project("a", "/p/a", 10, 20, true), projects[1]!];
    const children = [stub(1, "a"), stub(2, "a", { x: 260, y: 40 })];
    const nodes = toFlowNodes(
      inputs({ projects: expanded, children, dragging: { a: { x: 130, y: 20 }, "session:stub-2-a": { x: 5, y: 5 } } }),
    );
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 130, y: 20 },
      { x: 16, y: 92 },
      { x: 5, y: 5 },
      { x: -5, y: 7 },
    ]);
  });

  it("reads overrides as own properties, so an id like `constructor` finds none", () => {
    const odd = [project("constructor", "/p/c", 3, 4), project("toString", "/p/t", 5, 6)];
    const nodes = toFlowNodes(inputs({ projects: odd }));
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
    expect(dropTarget("constructor", {}, { x: 1, y: 2 })).toEqual([{ kind: "project", id: "constructor" }, { x: 1, y: 2 }]);
  });

  it("reuses a project node only when every rendered field is unchanged", () => {
    const base = project("a", "/p/a", 10, 20);
    const first = toFlowNodes(inputs({ projects: [base] }));
    const changed: Partial<Project>[] = [{ label: "renamed" }, { path: "/p/moved" }, { expanded: true }, { color: "#abc" }];
    for (const change of changed) {
      const next = toFlowNodes(inputs({ projects: [{ ...base, ...change }] }), first);
      expect(next[0], JSON.stringify(change)).not.toBe(first[0]);
    }
    const sameCard = toFlowNodes(inputs({ projects: [{ ...base, launchDefaults: { model: "opus", effort: null, permissionMode: null } }] }), first);
    expect(sameCard[0]).toBe(first[0]);
  });

  it("keeps the identity of every node whose inputs did not change", () => {
    const expanded = [project("a", "/p/a", 10, 20, true), projects[1]!];
    const children = [stub(1, "a"), stub(2, "a")];
    const first = toFlowNodes(inputs({ projects: expanded, children, statuses }));

    // The same inputs, spelled with fresh objects (a new snapshot): every node is reused.
    const again = toFlowNodes(
      inputs({
        projects: expanded.map((p) => ({ ...p, position: { ...p.position } })),
        children: children.map((c) => ({ ...c })),
        statuses: { a: { ...statuses.a! } },
      }),
      first,
    );
    expect(again).not.toBe(first);
    again.forEach((node, index) => expect(node).toBe(first[index]));

    // A drag frame moves one child: only that node object is new.
    const dragged = toFlowNodes(inputs({ projects: expanded, children, statuses, dragging: { "session:stub-2-a": { x: 1, y: 1 } } }), first);
    expect(dragged[0]).toBe(first[0]);
    expect(dragged[1]).toBe(first[1]);
    expect(dragged[2]).not.toBe(first[2]);
    expect(dragged[3]).toBe(first[3]);

    // A status tick for `a` touches `a` alone; selecting `b` touches `b` alone.
    const polled = toFlowNodes(inputs({ projects: expanded, children, statuses: { a: { kind: "not_repo" } } }), first);
    expect(polled.map((n, i) => n === first[i])).toEqual([false, true, true, true]);
    const selected = toFlowNodes(inputs({ projects: expanded, children, statuses, selection: { kind: "project", id: "b" } }), first);
    expect(selected.map((n, i) => n === first[i])).toEqual([true, true, true, false]);
    // Collapsing `a` changes `a` (chevron) and drops its children.
    const collapsed = toFlowNodes(inputs({ projects: [project("a", "/p/a", 10, 20), projects[1]!], children, statuses }), first);
    expect(collapsed.map((n) => n.id)).toEqual(["a", "b"]);
    expect(collapsed[0]).not.toBe(first[0]);
    expect(collapsed[1]).toBe(first[3]);
  });
});

describe("layoutChildren / columnSlot", () => {
  it("places children 16 px in and 40+8 px apart from y 92, keeping a dragged child's own position", () => {
    expect([CHILD_WIDTH, CHILD_HEIGHT, CHILD_GAP, COLUMN_INDENT, COLUMN_TOP]).toEqual([208, 40, 8, 16, 92]);
    expect(columnSlot(0)).toEqual({ x: 16, y: 92 });
    expect(columnSlot(2)).toEqual({ x: 16, y: 188 });
    const dragged = { x: -30, y: 300 };
    const positions = layoutChildren([stub(1, "p"), stub(2, "p", dragged), stub(3, "p")]);
    expect(positions).toEqual([
      { x: 16, y: 92 },
      { x: -30, y: 300 },
      { x: 16, y: 188 },
    ]);
    expect(positions[1]).not.toBe(dragged);
    expect(layoutChildren([])).toEqual([]);
  });
});

describe("rightClickTarget", () => {
  const press = (flowId: string | null, x = 100, y = 100) => ({ x, y, flowId });

  it("is the pressed node when the pointer moved at most the threshold, for any node kind", () => {
    expect(DRAG_THRESHOLD).toBe(4);
    expect(rightClickTarget(press("ide"), { x: 100, y: 100 })).toEqual({ kind: "project", id: "ide" });
    expect(rightClickTarget(press("ide"), { x: 102, y: 103 })).toEqual({ kind: "project", id: "ide" });
    // Exactly the threshold still counts as a click (xyflow drags only beyond it).
    expect(rightClickTarget(press("ide"), { x: 104, y: 100 })).toEqual({ kind: "project", id: "ide" });
    expect(rightClickTarget(press("session:stub-2-ide"), { x: 101, y: 101 })).toEqual({ kind: "session", id: "stub-2-ide" });
    expect(rightClickTarget(press("branch:b1"), { x: 100, y: 100 })).toEqual({ kind: "branch", id: "b1" });
  });

  it("is null for a pan, a press on empty canvas, or no press at all", () => {
    expect(rightClickTarget(press("ide"), { x: 105, y: 100 })).toBeNull();
    expect(rightClickTarget(press("ide"), { x: 103, y: 103 })).toBeNull(); // hypot ≈ 4.24
    expect(rightClickTarget(press("ide"), { x: 220, y: 100 })).toBeNull();
    expect(rightClickTarget(press(null), { x: 100, y: 100 })).toBeNull();
    expect(rightClickTarget(null, { x: 100, y: 100 })).toBeNull();
  });
});

describe("dropTarget", () => {
  it("prefers the drag override over the node's position and parses the flow id", () => {
    const dragging = { "session:stub-2-ide": { x: 260, y: 40 }, ide: { x: 130, y: 20 } };
    expect(dropTarget("session:stub-2-ide", dragging, { x: 16, y: 140 })).toEqual([
      { kind: "session", id: "stub-2-ide" },
      { x: 260, y: 40 },
    ]);
    expect(dropTarget("ide", dragging, { x: 0, y: 0 })).toEqual([{ kind: "project", id: "ide" }, { x: 130, y: 20 }]);
    expect(dropTarget("session:stub-1-ide", dragging, { x: 16, y: 92 })).toEqual([
      { kind: "session", id: "stub-1-ide" },
      { x: 16, y: 92 },
    ]);
    const nodePosition = { x: 1, y: 2 };
    expect(dropTarget("branch:b1", {}, nodePosition)[1]).not.toBe(nodePosition);
  });
});

describe("chevronCommandId", () => {
  it("is Expand for a collapsed project and Collapse for an expanded one", () => {
    expect(chevronCommandId({ expanded: false })).toBe("project.expand");
    expect(chevronCommandId({ expanded: true })).toBe("project.collapse");
  });
});

describe("flow ids", () => {
  it("prefix children by kind and leave project ids bare, both ways", () => {
    expect(childFlowId({ kind: "session", id: "stub-1-p" })).toBe("session:stub-1-p");
    expect(childFlowId({ kind: "branch", id: "b1" })).toBe("branch:b1");
    expect(flowIdOf({ kind: "project", id: "p" })).toBe("p");
    expect(flowIdOf({ kind: "session", id: "s" })).toBe("session:s");
    expect(parseFlowId("p")).toEqual({ kind: "project", id: "p" });
    expect(parseFlowId("session:stub-1-p")).toEqual({ kind: "session", id: "stub-1-p" });
    expect(parseFlowId("branch:b1")).toEqual({ kind: "branch", id: "b1" });
    expect(parseFlowId("branch:a:b")).toEqual({ kind: "branch", id: "a:b" });
  });
});

describe("cardTopLeft", () => {
  it("offsets a centre by half the card so the card sits centred on it", () => {
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([240, 80]);
    expect(cardTopLeft({ x: 500, y: 300 })).toEqual({ x: 380, y: 260 });
    expect(cardTopLeft({ x: 0, y: 0 })).toEqual({ x: -120, y: -40 });
  });
});

describe("shortenPath", () => {
  it("leaves a short path alone", () => {
    expect(shortenPath("B:\\projects\\ide")).toBe("B:\\projects\\ide");
    expect(shortenPath("/home/me/src")).toBe("/home/me/src");
  });

  it("elides the middle, keeping the drive and as many trailing folders as fit", () => {
    const long = "B:\\projects\\some\\quite\\deep\\tree\\guild-auth";
    expect(long.length).toBeGreaterThan(36);
    // Exactly 36 characters with one folder elided: fits.
    expect(shortenPath(long)).toBe("B:\\…\\some\\quite\\deep\\tree\\guild-auth");
    expect(shortenPath(long, 35)).toBe("B:\\…\\quite\\deep\\tree\\guild-auth");
    expect(shortenPath(long, 18)).toBe("B:\\…\\guild-auth");
    expect(shortenPath(long, 20)).toBe("B:\\…\\tree\\guild-auth");
  });

  it("keeps the last folder even when it alone is too long, and handles unix roots", () => {
    const unix = "/home/emils/projects/an-extremely-long-folder-name-here";
    expect(shortenPath(unix, 30)).toBe("/…/an-extremely-long-folder-name-here");
    expect(shortenPath("/a-very-long-single-component-path-x", 10)).toBe("/a-very-long-single-component-path-x");
  });
});

describe("statusLine / aheadBehind", () => {
  it("renders the branch and changed count for a repo", () => {
    expect(statusLine({ kind: "repo", branch: "master", detached: false, dirty: 0, ahead: 0, behind: 0 })).toEqual({
      text: "master · 0 changed",
      tone: "normal",
    });
    expect(statusLine({ kind: "repo", branch: "5ff9de9", detached: true, dirty: 2, ahead: 0, behind: 0 }).text).toBe(
      "5ff9de9 detached · 2 changed",
    );
  });

  it("renders the muted non-repo states and a placeholder while unpolled", () => {
    expect(statusLine({ kind: "not_repo" })).toEqual({ text: "not a git repo", tone: "muted" });
    expect(statusLine({ kind: "missing" })).toEqual({ text: "folder missing", tone: "muted" });
    expect(statusLine({ kind: "git_unavailable" })).toEqual({ text: "git unavailable", tone: "muted" });
    expect(statusLine(null)).toEqual({ text: "…", tone: "muted" });
  });

  it("renders a git failure as 'git error' with the message as hover text", () => {
    expect(statusLine({ kind: "git_error", message: "fatal: detected dubious ownership" })).toEqual({
      text: "git error",
      tone: "muted",
      title: "fatal: detected dubious ownership",
    });
  });

  it("aheadBehind shows only when the upstream differs", () => {
    expect(aheadBehind({ kind: "repo", branch: "m", detached: false, dirty: 0, ahead: 0, behind: 0 })).toBeNull();
    expect(aheadBehind({ kind: "repo", branch: "m", detached: false, dirty: 0, ahead: 3, behind: 0 })).toBe("↑3 ↓0");
    expect(aheadBehind({ kind: "repo", branch: "m", detached: false, dirty: 0, ahead: 0, behind: 12 })).toBe("↑0 ↓12");
    expect(aheadBehind({ kind: "not_repo" })).toBeNull();
    expect(aheadBehind({ kind: "git_error", message: "x" })).toBeNull();
    expect(aheadBehind(null)).toBeNull();
  });

  it("the live badge is wired to 0 until Epic 3", () => {
    expect(LIVE_SESSIONS).toBe(0);
  });
});

describe("physicalToClient", () => {
  it("divides by the device pixel ratio and tolerates a bad ratio", () => {
    expect(physicalToClient({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
    expect(physicalToClient({ x: 300, y: 150 }, 1)).toEqual({ x: 300, y: 150 });
    expect(physicalToClient({ x: 300, y: 150 }, 0)).toEqual({ x: 300, y: 150 });
    expect(physicalToClient({ x: 300, y: 150 }, Number.NaN)).toEqual({ x: 300, y: 150 });
  });
});

// --- keyboard navigation geometry (the spec's matrix: `ide` at (80,80), `projects` at (480,80)) --

const ideAt = (expanded: boolean) => project("ide", "/p/ide", 80, 80, expanded);
const projectsAt = project("projects", "/p/projects", 480, 80);
/** Two stubs in their slots under `ide`. */
const matrixChildren = [stub(1, "ide"), stub(2, "ide")];
/** The same, with `session 2` dragged to the right of the card, between the two projects. */
const draggedChildren = [stub(1, "ide"), stub(2, "ide", { x: 300, y: -20 })];

function rectOf(rects: readonly NodeRect[], kind: NodeRect["target"]["kind"], id: string): NodeRect {
  const rect = rects.find((r) => r.target.kind === kind && r.target.id === id);
  if (rect === undefined) throw new Error(`no rect for ${kind}:${id}`);
  return rect;
}

describe("nodeRects", () => {
  it("is every project card at its position, followed by an expanded project's children at parent + slot or stored position", () => {
    const rects = nodeRects([ideAt(true), projectsAt], draggedChildren);
    expect(rects).toEqual([
      { target: { kind: "project", id: "ide" }, x: 80, y: 80, width: CARD_WIDTH, height: CARD_HEIGHT },
      { target: { kind: "session", id: "stub-1-ide" }, x: 80 + COLUMN_INDENT, y: 80 + COLUMN_TOP, width: CHILD_WIDTH, height: CHILD_HEIGHT },
      { target: { kind: "session", id: "stub-2-ide" }, x: 80 + 300, y: 80 - 20, width: CHILD_WIDTH, height: CHILD_HEIGHT },
      { target: { kind: "project", id: "projects" }, x: 480, y: 80, width: CARD_WIDTH, height: CARD_HEIGHT },
    ]);
  });

  it("leaves out the children of a collapsed project, and a branch child keeps its kind", () => {
    const branch: ChildNode = { id: "br", projectId: "projects", kind: "branch", label: "main", detail: null, position: null };
    const rects = nodeRects([ideAt(false), { ...projectsAt, expanded: true }], [...matrixChildren, branch]);
    expect(rects.map((r) => r.target)).toEqual([
      { kind: "project", id: "ide" },
      { kind: "project", id: "projects" },
      { kind: "branch", id: "br" },
    ]);
    expect(nodeRects([], matrixChildren)).toEqual([]);
  });
});

describe("nearestInDirection", () => {
  const rects = nodeRects([ideAt(true), projectsAt], matrixChildren);
  const ide = rectOf(rects, "project", "ide");
  const projects = rectOf(rects, "project", "projects");

  it("→ from ide reaches projects, ← comes back, ↓ with ide expanded reaches session 1", () => {
    expect(nearestInDirection(ide, rects, "right")?.target).toEqual({ kind: "project", id: "projects" });
    expect(nearestInDirection(projects, rects, "left")?.target).toEqual({ kind: "project", id: "ide" });
    expect(nearestInDirection(ide, rects, "down")?.target).toEqual({ kind: "session", id: "stub-1-ide" });
  });

  it("is null with no candidate in that half-plane, so the selection stays", () => {
    expect(nearestInDirection(ide, rects, "left")).toBeNull();
    expect(nearestInDirection(projects, rects, "right")).toBeNull();
    expect(nearestInDirection(ide, rects, "up")).toBeNull();
    const collapsed = nodeRects([ideAt(false), projectsAt], matrixChildren);
    expect(nearestInDirection(rectOf(collapsed, "project", "ide"), collapsed, "down")).toBeNull();
    expect(nearestInDirection(ide, [ide], "right")).toBeNull();
  });

  it("uses the half-plane strictly and ranks by primary distance plus twice the perpendicular one", () => {
    // With `session 2` dragged to (380,60) 208×40 (centre 484,80), from `projects` (centre
    // 600,120): dx −116, dy −40 → score 196; `ide` (centre 200,120): dx −400 → 400. Left picks the stub.
    const dragged = nodeRects([ideAt(true), projectsAt], draggedChildren);
    const fromProjects = rectOf(dragged, "project", "projects");
    expect(nearestInDirection(fromProjects, dragged, "left")?.target).toEqual({ kind: "session", id: "stub-2-ide" });
    // Up from `projects`: the stub's centre is 40 above and 116 to the side (40 + 232 = 272),
    // the only candidate above. Right from `ide` (centre 200,120): the stub (284 + 80 = 364)
    // beats `projects` (400), so a dragged child can intercept a move between cards.
    expect(nearestInDirection(fromProjects, dragged, "up")?.target).toEqual({ kind: "session", id: "stub-2-ide" });
    expect(nearestInDirection(rectOf(dragged, "project", "ide"), dragged, "right")?.target).toEqual({ kind: "session", id: "stub-2-ide" });
    // A node exactly level is not "above" or "below": strict half-plane.
    const level = nodeRects([project("a", "/a", 0, 0), project("b", "/b", 1000, 0)], []);
    expect(nearestInDirection(rectOf(level, "project", "a"), level, "down")).toBeNull();
    expect(nearestInDirection(rectOf(level, "project", "a"), level, "right")?.target.id).toBe("b");
    // Weighting: a node 100 right and 60 off axis (score 220) loses to one 200 right on axis (200).
    const weighted = nodeRects([project("o", "/o", 0, 0), project("near-off", "/n", 100, 60), project("far-on", "/f", 200, 0)], []);
    expect(nearestInDirection(rectOf(weighted, "project", "o"), weighted, "right")?.target.id).toBe("far-on");
  });

  it("breaks an equal score by list order", () => {
    const tied = nodeRects([project("o", "/o", 0, 0), project("second", "/s", 300, 100), project("first", "/f", 300, -100)], []);
    expect(nearestInDirection(rectOf(tied, "project", "o"), tied, "right")?.target.id).toBe("second");
  });
});

describe("nearestToPoint", () => {
  it("is the rect whose centre is nearest the point, ties to the earlier one, null for none", () => {
    const rects = nodeRects([ideAt(false), projectsAt], []);
    expect(nearestToPoint(rects, { x: 150, y: 150 })?.target.id).toBe("ide");
    expect(nearestToPoint(rects, { x: 700, y: 0 })?.target.id).toBe("projects");
    // Exactly between the two centres (200,120) and (600,120): the first in the list.
    expect(nearestToPoint(rects, { x: 400, y: 120 })?.target.id).toBe("ide");
    expect(nearestToPoint([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("panToReveal", () => {
  const size = { width: 800, height: 600 };
  const rect: NodeRect = { target: { kind: "project", id: "p" }, x: 1000, y: 100, width: CARD_WIDTH, height: CARD_HEIGHT };

  it("is null when the rect is already inside the margin on both axes", () => {
    expect(panToReveal(rect, { x: -700, y: 0, zoom: 1 }, size)).toBeNull();
    expect(panToReveal(rect, { x: -1000 + REVEAL_MARGIN, y: -100 + REVEAL_MARGIN, zoom: 1 }, size)).toBeNull();
    expect(REVEAL_MARGIN).toBe(16);
    expect(REVEAL_PAN_MS).toBe(150);
  });

  it("pans by the smallest delta that brings an off-screen rect inside the margin, zoom unchanged", () => {
    // Right edge at screen 1240 with the view 800 wide: shift left by 1240 − (800 − 16) = 456.
    expect(panToReveal(rect, { x: 0, y: 0, zoom: 1 }, size)).toEqual({ x: -456, y: 0, zoom: 1 });
    // Left of the view: screen x −200 → shift right by 216 (to the 16 px margin).
    expect(panToReveal(rect, { x: -1200, y: 0, zoom: 1 }, size)).toEqual({ x: -984, y: 0, zoom: 1 });
    // Above (screen y −100 → shift down by 116) and to the right at once: both axes move.
    expect(panToReveal(rect, { x: 0, y: -200, zoom: 1 }, size)).toEqual({ x: -456, y: -84, zoom: 1 });
    // Below: bottom edge at 180·2 + 500 = 860 at zoom 2 → shift up by 860 − 584 = 276; zoom kept.
    expect(panToReveal(rect, { x: -1700, y: 500, zoom: 2 }, size)).toEqual({ x: -1700, y: 224, zoom: 2 });
  });

  it("aligns a rect wider than the view on its leading edge", () => {
    const wide: NodeRect = { ...rect, x: 0, width: 2000 };
    expect(panToReveal(wide, { x: 100, y: 0, zoom: 1 }, size)).toEqual({ x: 16, y: 0, zoom: 1 });
    expect(panToReveal(wide, { x: -100, y: 0, zoom: 1 }, size)).toEqual({ x: 16, y: 0, zoom: 1 });
    // Once there, a repeated reveal is a no-op (no alternating).
    expect(panToReveal(wide, { x: 16, y: 0, zoom: 1 }, size)).toBeNull();
  });
});
