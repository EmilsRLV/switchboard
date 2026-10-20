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
  ELEVATED_Z,
  REVEAL_MARGIN,
  REVEAL_PAN_MS,
  aheadBehind,
  cardTopLeft,
  chevronCommandId,
  childFlowId,
  columnSlot,
  dropTarget,
  flowIdOf,
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
import {
  SHOW_LIMIT,
  formatAge,
  moreFlowId,
  moreLabel,
  rightClickAction,
  childAriaLabel,
  branchAriaLabel,
  branchCardParts,
  branchCardTitle,
  BRANCHES_UNAVAILABLE,
  groupOf,
  hasBranchSecondLine,
  MISSING_WORKTREE,
  projectColumn,
  nestedSlot,
  moreTarget,
  worktreeChipText,
  sessionCardMeta,
  sessionCardTitle,
  sessionHoverText,
  sessionMetaLine,
  sessionStateTone,
  visibleChildren,
  FORK_LINE_BOW,
  STOPPING_WORD,
  forkLinePath,
  forkLines,
  forkedFromText,
} from "./nodes";
import type { BranchMeta, LiveSession, SessionMeta, SessionState } from "../ipc";

function project(id: string, path: string, x = 0, y = 0, expanded = false): Project {
  return {
    id,
    path,
    label: path.split(/[\\/]/).pop() ?? path,
    position: { x, y },
    expanded,
    color: null,
    launchDefaults: null,
    showBranches: false,
  };
}

function stub(index: number, projectId: string, position: ChildNode["position"] = null): ChildNode {
  return { id: `stub-${index}-${projectId}`, projectId, kind: "session", label: `session ${index}`, detail: "stub", position, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
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
    const branch: ChildNode = { id: "br1", projectId: "a", kind: "branch", label: "main", detail: "/p/a/.worktrees/x", position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
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

  it("lifts the selected node and every dragged node above their siblings, and only those", () => {
    const expanded = [project("a", "/p/a", 0, 0, true), projects[1]!];
    const children = [stub(1, "a"), stub(2, "a"), stub(3, "a")];
    const none = toFlowNodes(inputs({ projects: expanded, children }));
    expect(none.map((n) => n.zIndex)).toEqual([0, 0, 0, 0, 0]);
    // Dragging `session 3` (over `session 1`) while `session 1` is selected: both lifted.
    const dragged = toFlowNodes(
      inputs({
        projects: expanded,
        children,
        selection: { kind: "session", id: "stub-1-a" },
        dragging: { "session:stub-3-a": { x: 16, y: 92 } },
      }),
      none,
    );
    expect(dragged.map((n) => n.zIndex)).toEqual([0, ELEVATED_Z, 0, ELEVATED_Z + 1, 0]);
    // The reverse: dragging `session 1` while `session 3` is selected; the dragged one is higher.
    const reverse = toFlowNodes(
      inputs({
        projects: expanded,
        children,
        selection: { kind: "session", id: "stub-3-a" },
        dragging: { "session:stub-1-a": { x: 16, y: 188 } },
      }),
    );
    expect(reverse.map((n) => n.zIndex)).toEqual([0, ELEVATED_Z + 1, 0, ELEVATED_Z, 0]);
    // The layer is part of a node's identity: the lifted nodes are new, the rest reused.
    expect(dragged.map((n, i) => n === none[i])).toEqual([true, false, true, false, true]);
    const projectLifted = toFlowNodes(inputs({ projects: expanded, children, selection: { kind: "project", id: "b" } }));
    expect(projectLifted.map((n) => n.zIndex)).toEqual([0, 0, 0, 0, ELEVATED_Z]);
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

describe("projectColumn / columnSlot", () => {
  it("places children 16 px in and 40+8 px apart from y 92, keeping a dragged child's own position", () => {
    expect([CHILD_WIDTH, CHILD_HEIGHT, CHILD_GAP, COLUMN_INDENT, COLUMN_TOP]).toEqual([208, 40, 8, 16, 92]);
    expect(columnSlot(0)).toEqual({ x: 16, y: 92 });
    expect(columnSlot(2)).toEqual({ x: 16, y: 188 });
    const dragged = { x: -30, y: 300 };
    const positions = projectColumn("p", [stub(1, "p"), stub(2, "p", dragged), stub(3, "p")], []).drawn.map((d) => d.position);
    expect(positions).toEqual([
      { x: 16, y: 92 },
      { x: -30, y: 300 },
      { x: 16, y: 188 },
    ]);
    expect(positions[1]).not.toBe(dragged);
    expect(projectColumn("p", [], [])).toEqual({ drawn: [], mores: [] });
  });
});

describe("rightClickAction", () => {
  it("opens the menu for a project, session or branch card with enabled entries, else only selects", () => {
    expect(rightClickAction({ kind: "project", id: "a" }, true)).toBe("menu");
    expect(rightClickAction({ kind: "session", id: "s" }, true)).toBe("menu");
    expect(rightClickAction({ kind: "session", id: "historic" }, false)).toBe("select");
    expect(rightClickAction({ kind: "project", id: "a" }, false)).toBe("select");
    expect(rightClickAction({ kind: "branch", id: "b" }, true)).toBe("menu");
    expect(rightClickAction({ kind: "branch", id: "b" }, false)).toBe("select");
    expect(rightClickAction({ kind: "more", id: "a" }, true)).toBe("select");
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

  it("the live badge counts the project's session children in a live state, by session id", () => {
    const projects = [project("a", "/p/a"), project("b", "/p/b", 300)];
    const session = (state: SessionState, project_id: string | null): LiveSession => ({
      state,
      source: "poll",
      pid: 1,
      kind: "interactive",
      name: null,
      project_id,
      cwd: "/x",
      started_at: 0,
      attention_since: null,
      last_line: null,
      detail: null,
    });
    const child = (id: string, projectId: string): ChildNode => ({ ...stub(1, projectId), id });
    const children = [child("s1", "a"), child("s2", "a"), child("s3", "a"), child("s4", "a"), child("historic", "a"), child("moved", "a")];
    const live: Record<string, LiveSession> = {
      s1: session({ kind: "busy" }, "a"),
      s2: session({ kind: "idle" }, "a"),
      s3: session({ kind: "other", raw: "compacting" }, "a"),
      s4: session({ kind: "exited" }, "a"),
      // Its transcript sits under `a`, its live cwd maps to `b`: it counts where it is drawn.
      moved: session({ kind: "busy" }, "b"),
      elsewhere: session({ kind: "busy" }, null),
    };
    const nodes = toFlowNodes(inputs({ projects, children, live }));
    expect(asProject(nodes[0]).data.liveCount).toBe(4);
    expect(asProject(nodes[1]).data.liveCount).toBe(0);
    expect(asProject(toFlowNodes(inputs({ projects, children }))[0]).data.liveCount).toBe(0);
  });

  it("a session in finished or waiting puts its card in attention and its project in the glow, collapsed or not", () => {
    const session = (state: SessionState, project_id = "a"): LiveSession => ({
      state,
      source: "poll",
      pid: 1,
      kind: "interactive",
      name: null,
      project_id,
      cwd: "/p/a",
      started_at: 0,
      attention_since: state.kind === "finished" ? 5 : null,
      last_line: null,
      detail: null,
    });
    const children = [stub(1, "a"), stub(2, "a"), stub(1, "b")];
    const collapsed = [project("a", "/p/a"), project("b", "/p/b", 300)];
    const live = { "stub-1-a": session({ kind: "busy" }), "stub-2-a": session({ kind: "finished" }), "stub-1-b": session({ kind: "idle" }, "b") };
    const nodes = toFlowNodes(inputs({ projects: collapsed, children, live }));
    expect(asProject(nodes[0]).data.attention).toBe(true);
    expect(asProject(nodes[0]).data.childCount, "the badge is unchanged").toBe(2);
    expect(asProject(nodes[1]).data.attention).toBe(false);

    const expanded = [project("a", "/p/a", 0, 0, true)];
    const open = toFlowNodes(inputs({ projects: expanded, children, live }));
    expect(asProject(open[0]).data.attention).toBe(true);
    const kids = open.filter((n) => n.type === "session");
    expect(kids.map((n) => (n.type === "session" ? n.data.attention : null))).toEqual([false, true]);

    // Acknowledged (idle): the glow and the accent go, and only the nodes that changed re-render.
    const acked = toFlowNodes(
      inputs({ projects: expanded, children, live: { ...live, "stub-2-a": { ...session({ kind: "idle" }), source: "ack" } } }),
      open,
    );
    expect(asProject(acked[0]).data.attention).toBe(false);
    expect(acked[0]).not.toBe(open[0]);
    expect(acked[1], "the busy sibling is untouched").toBe(open[1]);
    expect(acked[2]).not.toBe(open[2]);

    // Waiting counts too; exited does not.
    const waiting = toFlowNodes(inputs({ projects: collapsed, children, live: { "stub-1-a": session({ kind: "waiting" }) } }));
    expect(asProject(waiting[0]).data.attention).toBe(true);
    const exited = toFlowNodes(inputs({ projects: collapsed, children, live: { "stub-1-a": session({ kind: "exited" }) } }));
    expect(asProject(exited[0]).data.attention).toBe(false);
  });

  it("a session child carries its live state, and a state flip re-renders only that child", () => {
    const expanded = [project("a", "/p/a", 0, 0, true)];
    const children = [stub(1, "a"), stub(2, "a")];
    const session = (state: SessionState): LiveSession => ({
      state,
      source: "poll",
      pid: 1,
      kind: "interactive",
      name: null,
      project_id: "a",
      cwd: "/p/a",
      started_at: 0,
      attention_since: null,
      last_line: null,
      detail: null,
    });
    const first = toFlowNodes(inputs({ projects: expanded, children, live: { "stub-1-a": session({ kind: "busy" }) } }));
    const kid = (nodes: typeof first, i: number) => {
      const node = nodes[i];
      if (node === undefined || node.type !== "session") throw new Error("not a session node");
      return node;
    };
    expect(kid(first, 1).data.state).toEqual({ kind: "busy" });
    expect(kid(first, 2).data.state).toBeNull();
    const same = toFlowNodes(inputs({ projects: expanded, children, live: { "stub-1-a": session({ kind: "busy" }) } }), first);
    expect(same[1]).toBe(first[1]);
    const flipped = toFlowNodes(inputs({ projects: expanded, children, live: { "stub-1-a": session({ kind: "idle" }) } }), first);
    expect(flipped[1]).not.toBe(first[1]);
    expect(kid(flipped, 1).data.state).toEqual({ kind: "idle" });
    expect(flipped[2]).toBe(first[2]);
    // busy -> idle is still one live session: the card keeps its identity.
    expect(flipped[0]).toBe(first[0]);
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
    const branch: ChildNode = { id: "br", projectId: "projects", kind: "branch", label: "main", detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
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

function session(id: string, projectId: string, lastActive = "2026-10-16T10:00:00.000Z", meta: Partial<SessionMeta> = {}): ChildNode {
  return {
    id,
    projectId,
    kind: "session",
    label: `title ${id}`,
    detail: null,
    position: null,
    session: { startedAt: "2026-10-16T09:00:00.000Z", lastActive, branch: "main", messages: 3, ...meta },
    branchId: null, forkedFrom: null, hasTranscript: false, branch: null,
  };
}

function sessions(count: number, projectId: string): ChildNode[] {
  return Array.from({ length: count }, (_, i) => session(`s${i + 1}`, projectId));
}

describe("show all: the visible-children cut and the more row", () => {
  const ide = project("ide", "/p/ide", 100, 50, true);

  it("visibleChildren keeps the first ten and flags the rest; at ten or fewer there is no more row", () => {
    expect(SHOW_LIMIT).toBe(10);
    const fifteen = sessions(15, "ide");
    expect(visibleChildren(fifteen, false).visible.map((c) => c.id)).toEqual(fifteen.slice(0, 10).map((c) => c.id));
    expect(visibleChildren(fifteen, false).more).toBe(true);
    expect(visibleChildren(fifteen, true).visible).toHaveLength(15);
    expect(visibleChildren(fifteen, true).more).toBe(true);
    expect(visibleChildren(sessions(10, "ide"), false)).toEqual({ visible: sessions(10, "ide"), more: false, slotted: 10, total: 10 });
    expect(visibleChildren(fifteen, false)).toMatchObject({ slotted: 10, total: 15 });
    expect(visibleChildren(sessions(9, "ide"), true).more).toBe(false);
  });

  it("fifteen sessions: ten cards and `show all (15)` in the eleventh slot; the badge counts fifteen", () => {
    const children = sessions(15, "ide");
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(nodes.map((n) => n.id)).toEqual(["ide", ...children.slice(0, 10).map((c) => `session:${c.id}`), "more:ide"]);
    const more = nodes[11];
    if (more?.type !== "more") throw new Error("no more node");
    expect(more.parentId).toBe("ide");
    expect(more.position).toEqual(columnSlot(10));
    expect(more.draggable).toBe(false);
    expect(more.data).toEqual({ projectId: "ide", group: "sessions", total: 15, showingAll: false, selected: false });
    expect(moreLabel(more.data.total, more.data.showingAll)).toBe("show all (15)");
    expect(asProject(nodes[0]).data.childCount).toBe(15);

    const collapsed = toFlowNodes(inputs({ projects: [{ ...ide, expanded: false }], children }));
    expect(collapsed.map((n) => n.id)).toEqual(["ide"]);
    expect(asProject(collapsed[0]).data.childCount).toBe(15);
  });

  it("with showAll every child shows and the row reads `show fewer` after the last one", () => {
    const children = sessions(15, "ide");
    const nodes = toFlowNodes(inputs({ projects: [ide], children, showAll: ["ide"] }));
    expect(nodes).toHaveLength(1 + 15 + 1);
    const more = nodes[16];
    if (more?.type !== "more") throw new Error("no more node");
    expect(more.position).toEqual(columnSlot(15));
    expect(more.data.showingAll).toBe(true);
    expect(moreLabel(more.data.total, more.data.showingAll)).toBe("show fewer");
  });

  it("nine sessions: no more row", () => {
    const nodes = toFlowNodes(inputs({ projects: [ide], children: sessions(9, "ide") }));
    expect(nodes.some((n) => n.type === "more")).toBe(false);
  });

  it("a selected more row is marked and elevated; it keeps its identity while nothing changes", () => {
    const children = sessions(12, "ide");
    const first = toFlowNodes(inputs({ projects: [ide], children, selection: { kind: "more", id: "ide" } }));
    const more = first.find((n) => n.type === "more");
    expect(more?.data).toMatchObject({ selected: true });
    expect(more?.zIndex).toBe(ELEVATED_Z);
    const again = toFlowNodes(inputs({ projects: [ide], children, selection: { kind: "more", id: "ide" } }), first);
    expect(again.find((n) => n.type === "more")).toBe(more);
    const grown = toFlowNodes(inputs({ projects: [ide], children: sessions(13, "ide"), selection: { kind: "more", id: "ide" } }), first);
    expect(grown.find((n) => n.type === "more")).not.toBe(more);
  });

  it("a dragged child past the tenth is drawn at its position; the others past ten hide; slots stay by index", () => {
    // Thirteen sessions; s3 (inside the ten) and s12 (past them) were dragged.
    const children = sessions(13, "ide");
    children[2] = { ...children[2]!, position: { x: 300, y: 0 } };
    children[11] = { ...children[11]!, position: { x: 400, y: 0 } };
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(nodes.find((n) => n.id === "session:s3")?.position).toEqual({ x: 300, y: 0 });
    expect(nodes.find((n) => n.id === "session:s4")?.position).toEqual(columnSlot(3)); // s3's slot stays empty
    expect(nodes.find((n) => n.id === "session:s12")?.position).toEqual({ x: 400, y: 0 });
    expect(nodes.some((n) => n.id === "session:s11")).toBe(false);
    expect(nodes.some((n) => n.id === "session:s13")).toBe(false);
    const more = nodes.find((n) => n.type === "more");
    if (more?.type !== "more") throw new Error("no more node");
    expect(more.data.total).toBe(13);
    expect(more.position).toEqual(columnSlot(10));
    expect(asProject(nodes[0]).data.childCount).toBe(13);
    const rects = nodeRects([ide], children);
    expect(rects.some((r) => r.target.id === "s12")).toBe(true);
    expect(rects.some((r) => r.target.id === "s13")).toBe(false);
    expect(rects.find((r) => r.target.kind === "more")?.y).toBe(50 + columnSlot(10).y);

    // Showing all: every child in its own slot, the row after the last.
    const all = toFlowNodes(inputs({ projects: [ide], children, showAll: ["ide"] }));
    expect(all.find((n) => n.id === "session:s13")?.position).toEqual(columnSlot(12));
    expect(all.find((n) => n.type === "more")?.position).toEqual(columnSlot(13));
  });

  it("a session card re-renders when its meta changes (age or count), not otherwise", () => {
    const children = [session("s1", "ide")];
    const first = toFlowNodes(inputs({ projects: [ide], children }));
    const same = toFlowNodes(inputs({ projects: [ide], children: [session("s1", "ide")] }), first);
    expect(same[1]).toBe(first[1]);
    const more = toFlowNodes(inputs({ projects: [ide], children: [session("s1", "ide", undefined, { messages: 4 })] }), first);
    expect(more[1]).not.toBe(first[1]);
    const later = toFlowNodes(inputs({ projects: [ide], children: [session("s1", "ide", "2026-10-16T10:05:00.000Z")] }), first);
    expect(later[1]).not.toBe(first[1]);
    const branched = toFlowNodes(inputs({ projects: [ide], children: [{ ...session("s1", "ide"), branchId: "b1" }] }), first);
    expect(branched[1]).not.toBe(first[1]);
  });

  it("flow ids round-trip for the more row", () => {
    expect(moreFlowId("ide")).toBe("more:ide");
    expect(parseFlowId("more:ide")).toEqual({ kind: "more", id: "ide" });
    expect(flowIdOf({ kind: "more", id: "ide" })).toBe("more:ide");
  });

  it("nodeRects: the more row is a child-sized rect in its slot; hidden children are not candidates", () => {
    const children = sessions(12, "ide");
    const rects = nodeRects([ide], children);
    expect(rects.map((r) => `${r.target.kind}:${r.target.id}`)).toEqual([
      "project:ide",
      ...children.slice(0, 10).map((c) => `session:${c.id}`),
      "more:ide",
    ]);
    const slot = columnSlot(10);
    expect(rects[11]).toEqual({ target: { kind: "more", id: "ide" }, x: 100 + slot.x, y: 50 + slot.y, width: CHILD_WIDTH, height: CHILD_HEIGHT });
    const all = nodeRects([ide], children, ["ide"]);
    expect(all).toHaveLength(1 + 12 + 1);
    expect(all[13]?.y).toBe(50 + columnSlot(12).y);
  });
});

describe("formatAge / sessionMetaLine", () => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads now, minutes, hours and days, then the local date", () => {
    expect(formatAge(ago(0), now)).toBe("now");
    expect(formatAge(ago(59_000), now)).toBe("now");
    expect(formatAge(ago(-60_000), now)).toBe("now"); // a clock a little ahead
    expect(formatAge(ago(60_000), now)).toBe("1m");
    expect(formatAge(ago(5 * 60_000 + 30_000), now)).toBe("5m");
    expect(formatAge(ago(59 * 60_000), now)).toBe("59m");
    expect(formatAge(ago(3 * 3_600_000), now)).toBe("3h");
    expect(formatAge(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe("23h");
    expect(formatAge(ago(2 * 86_400_000), now)).toBe("2d");
    expect(formatAge(ago(6 * 86_400_000), now)).toBe("6d");
    // A week and more: the local date, with the year only when it differs from now's.
    const old = new Date(2026, 9, 1, 12, 0, 0).getTime();
    expect(formatAge(new Date(old).toISOString(), new Date(2026, 9, 12, 12).getTime())).toBe("1 Oct");
    const lastYear = new Date(2025, 9, 12, 12, 0, 0).getTime();
    expect(formatAge(new Date(lastYear).toISOString(), now)).toBe("12 Oct 2025");
    expect(formatAge("not a time", now)).toBe("?");
  });

  it("the meta line is branch · N msgs · age, without the branch when there is none", () => {
    const meta: SessionMeta = { startedAt: ago(7_200_000), lastActive: ago(3 * 3_600_000), branch: "master", messages: 12 };
    expect(sessionMetaLine(meta, now)).toBe("master · 12 msgs · 3h");
    expect(sessionMetaLine({ ...meta, branch: null }, now)).toBe("12 msgs · 3h");
    expect(sessionMetaLine({ ...meta, branch: "", messages: 1 }, now)).toBe("1 msg · 3h");
  });

  it("sessionCardMeta splits the line into its parts; no age without a last activity", () => {
    const meta: SessionMeta = { startedAt: ago(0), lastActive: ago(0), branch: "HEAD", messages: 455 };
    expect(sessionCardMeta(meta, now, { kind: "busy" })).toEqual({
      state: { word: "busy", tone: "busy", dot: true },
      branch: "HEAD",
      count: "455 msgs",
      age: "now",
      lastLine: null,
    });
    expect(sessionCardMeta(meta, now, { kind: "other", raw: "compacting" }).state).toEqual({ word: "compacting", tone: "muted", dot: false });
    expect(sessionCardMeta(meta, now, { kind: "exited" }).state).toEqual({ word: "exited", tone: "muted", dot: false });
    expect(sessionCardMeta({ ...meta, branch: "", messages: 1 }, now, null)).toEqual({ state: null, branch: null, count: "1 msg", age: "now", lastLine: null });
    const liveOnly: SessionMeta = { startedAt: "", lastActive: "", branch: null, messages: 0 };
    expect(sessionCardMeta(liveOnly, now, { kind: "idle" }).age).toBeNull();
    expect(sessionMetaLine(liveOnly, now, { kind: "idle" })).toBe("idle · 0 msgs");
    expect(sessionHoverText("new session", liveOnly)).toBe("new session");
    const started = { ...liveOnly, startedAt: "2026-10-16T09:00:00.000Z" };
    expect(sessionHoverText("t", started)).toBe(`t\nstarted ${new Date("2026-10-16T09:00:00.000Z").toLocaleString()}`);
  });

  it("a finished card shows the last line in place of branch, count and age; only while finished", () => {
    const meta: SessionMeta = { startedAt: ago(0), lastActive: ago(0), branch: "master", messages: 12 };
    expect(sessionCardMeta(meta, now, { kind: "finished" }, "Done.").lastLine).toBe("Done.");
    expect(sessionCardMeta(meta, now, { kind: "finished" }, "  ").lastLine).toBeNull();
    expect(sessionCardMeta(meta, now, { kind: "finished" }).lastLine).toBeNull();
    expect(sessionCardMeta(meta, now, { kind: "busy" }, "Done.").lastLine, "a stale line never shows").toBeNull();
  });

  it("the card title leads with a waiting session's detail and adds a finished one's last line", () => {
    const meta: SessionMeta = { startedAt: "", lastActive: "", branch: null, messages: 0 };
    const child = { ...stub(1, "a"), label: "fix login" };
    expect(sessionCardTitle({ child, attention: true, detail: "permission: Bash", lastLine: null }, meta)).toBe("permission: Bash\nfix login\nneeds you");
    expect(sessionCardTitle({ child, attention: true, detail: null, lastLine: "Done." }, meta)).toBe("fix login\nDone.\nneeds you");
    expect(sessionCardTitle({ child, attention: false, detail: null, lastLine: null }, meta)).toBe("fix login");
  });

  it("the accessible name carries the waiting reason and the finished last line", () => {
    const child = { ...stub(1, "a"), label: "fix login" };
    expect(childAriaLabel("session", { child, attention: true, detail: "permission: Bash", lastLine: null })).toBe(
      "Session fix login, waiting: permission: Bash, needs you",
    );
    expect(childAriaLabel("session", { child, attention: true, detail: null, lastLine: "Done." })).toBe(
      "Session fix login, last line: Done., needs you",
    );
    expect(childAriaLabel("branch", { child, attention: false, detail: null, lastLine: null })).toBe("Branch fix login");
  });

  it("a hooked session's card carries the last line while finished and the detail while waiting", () => {
    const expanded = [project("a", "/p/a", 0, 0, true)];
    const children = [stub(1, "a"), stub(2, "a")];
    const session = (state: SessionState, extra: Partial<LiveSession> = {}): LiveSession => ({
      state,
      source: "hook",
      pid: 1,
      kind: "interactive",
      name: null,
      project_id: "a",
      cwd: "/p/a",
      started_at: 0,
      attention_since: 5,
      last_line: null,
      detail: null,
      ...extra,
    });
    const live = {
      "stub-1-a": session({ kind: "finished" }, { last_line: "Done." }),
      "stub-2-a": session({ kind: "waiting" }, { detail: "permission: Bash", last_line: "stale" }),
    };
    const nodes = toFlowNodes(inputs({ projects: expanded, children, live }));
    const kids = nodes.filter((n) => n.type === "session");
    expect(kids.map((n) => (n.type === "session" ? [n.data.lastLine, n.data.detail] : null))).toEqual([
      ["Done.", null],
      [null, "permission: Bash"],
    ]);
    // A new last line re-renders that card only.
    const next = toFlowNodes(inputs({ projects: expanded, children, live: { ...live, "stub-1-a": session({ kind: "finished" }, { last_line: "Next." }) } }), nodes);
    expect(next[1]).not.toBe(nodes[1]);
    expect(next[2]).toBe(nodes[2]);
  });

  it("the meta line starts with the state word when the session is live or exited", () => {
    const meta: SessionMeta = { startedAt: ago(0), lastActive: ago(0), branch: "master", messages: 12 };
    expect(sessionMetaLine(meta, now, { kind: "busy" })).toBe("busy · master · 12 msgs · now");
    expect(sessionMetaLine(meta, now, { kind: "exited" })).toBe("exited · master · 12 msgs · now");
    expect(sessionMetaLine(meta, now, { kind: "other", raw: "compacting" })).toBe("compacting · master · 12 msgs · now");
    expect(sessionMetaLine(meta, now, null)).toBe("master · 12 msgs · now");
    expect(sessionStateTone({ kind: "busy" })).toBe("busy");
    expect(sessionStateTone({ kind: "idle" })).toBe("muted");
    // A session the app just launched reads muted, exactly like idle: no glow, no dot.
    expect(sessionStateTone({ kind: "starting" })).toBe("muted");
    expect(sessionMetaLine(meta, now, { kind: "starting" })).toBe("starting · master · 12 msgs · now");
    expect(sessionCardMeta(meta, now, { kind: "starting" }).state).toEqual({ word: "starting", tone: "muted", dot: false });
    expect(sessionStateTone({ kind: "exited" })).toBe("muted");
    expect(sessionStateTone({ kind: "other", raw: "compacting" })).toBe("muted");
    expect(sessionStateTone(null)).toBeNull();
  });

  it("finished and waiting read in the attention tone with the pulsing dot", () => {
    const meta: SessionMeta = { startedAt: ago(0), lastActive: ago(0), branch: "master", messages: 12 };
    expect(sessionStateTone({ kind: "finished" })).toBe("attention");
    expect(sessionStateTone({ kind: "waiting" })).toBe("attention");
    expect(sessionCardMeta(meta, now, { kind: "finished" }).state).toEqual({ word: "finished", tone: "attention", dot: true });
    expect(sessionCardMeta(meta, now, { kind: "waiting" }).state).toEqual({ word: "waiting", tone: "attention", dot: true });
    expect(sessionMetaLine(meta, now, { kind: "finished" })).toBe("finished · master · 12 msgs · now");
  });

  it("the hover text carries the full title and both times", () => {
    const meta: SessionMeta = { startedAt: "2026-10-16T09:00:00.000Z", lastActive: "2026-10-16T10:00:00.000Z", branch: null, messages: 0 };
    const text = sessionHoverText("A very long title that the card cuts", meta);
    const lines = text.split("\n");
    expect(lines[0]).toBe("A very long title that the card cuts");
    expect(lines[1]).toBe(`started ${new Date("2026-10-16T09:00:00.000Z").toLocaleString()}`);
    expect(lines[2]).toBe(`last active ${new Date("2026-10-16T10:00:00.000Z").toLocaleString()}`);
  });
});

describe("fork lines and the stopping word (Story 4.4)", () => {
  const ide = project("ide", "/p/ide", 100, 50, true);
  const orig = session("orig", "ide");
  const fork: ChildNode = { ...session("fork", "ide"), forkedFrom: "orig" };
  const liveOf = (states: Record<string, SessionState>): Record<string, LiveSession> =>
    Object.fromEntries(
      Object.entries(states).map(([id, state]) => [
        id,
        { state, source: "poll", pid: null, kind: null, name: null, project_id: "ide", cwd: "/p/ide", started_at: null, attention_since: null, last_line: null, detail: null } as LiveSession,
      ]),
    );

  it("a fork card carries its original's title; forkLines joins the two drawn cards", () => {
    const nodes = toFlowNodes(inputs({ projects: [ide], children: [fork, orig] }));
    const forkNode = nodes.find((n) => n.id === "session:fork");
    if (forkNode === undefined || forkNode.type !== "session") throw new Error("no fork node");
    expect(forkNode.data.forkedFromTitle).toBe("title orig");
    expect(forkLines(nodes)).toEqual([{ id: "fork:fork", source: "session:fork", target: "session:orig" }]);
  });

  it("no line when the original is not drawn (collapsed, hidden or not listed), and none for a self-reference", () => {
    const collapsed = { ...ide, expanded: false };
    expect(forkLines(toFlowNodes(inputs({ projects: [collapsed], children: [fork, orig] })))).toEqual([]);
    const alone = toFlowNodes(inputs({ projects: [ide], children: [fork] }));
    expect(forkLines(alone)).toEqual([]);
    const lone = alone.find((n) => n.id === "session:fork");
    if (lone === undefined || lone.type !== "session") throw new Error("no fork node");
    expect(lone.data.forkedFromTitle).toBeNull();
    // Past the tenth child the original is hidden: no line.
    const many = [fork, ...sessions(10, "ide"), orig];
    expect(forkLines(toFlowNodes(inputs({ projects: [ide], children: many })))).toEqual([]);
    expect(forkLines(toFlowNodes(inputs({ projects: [ide], children: many, showAll: ["ide"] })))).toHaveLength(1);
    const selfie: ChildNode = { ...session("x", "ide"), forkedFrom: "x" };
    expect(forkLines(toFlowNodes(inputs({ projects: [ide], children: [selfie] })))).toEqual([]);
  });

  it("a card is re-made when its stopping or forked-from changes, and reused when neither does", () => {
    const live = liveOf({ orig: { kind: "busy" }, fork: { kind: "idle" } });
    const base = inputs({ projects: [ide], children: [orig, fork], live });
    const first = toFlowNodes(base);
    const same = toFlowNodes(base, first);
    const byId = (nodes: ReturnType<typeof toFlowNodes>, id: string) => nodes.find((n) => n.id === id);
    expect(byId(same, "session:orig")).toBe(byId(first, "session:orig"));
    expect(byId(same, "session:fork")).toBe(byId(first, "session:fork"));
    // Stopping the original: only its card changes.
    const stopping = toFlowNodes({ ...base, stopping: ["orig"] }, same);
    expect(byId(stopping, "session:orig")).not.toBe(byId(same, "session:orig"));
    expect(byId(stopping, "session:fork")).toBe(byId(same, "session:fork"));
    // The fork's link goes (its ref was pruned): its card changes.
    const unlinked = toFlowNodes({ ...base, children: [orig, { ...fork, forkedFrom: null }] }, same);
    expect(byId(unlinked, "session:fork")).not.toBe(byId(same, "session:fork"));
    // The original is renamed: the fork's "forked from" title changes with it.
    const renamed = toFlowNodes({ ...base, children: [{ ...orig, label: "renamed" }, fork] }, same);
    const forkNode = byId(renamed, "session:fork");
    expect(forkNode).not.toBe(byId(same, "session:fork"));
    if (forkNode === undefined || forkNode.type !== "session") throw new Error("no fork node");
    expect(forkNode.data.forkedFromTitle).toBe("renamed");
  });

  it("the line bows left of both anchors", () => {
    expect(forkLinePath(16, 112, 16, 160)).toBe(`M 16,112 C ${16 - FORK_LINE_BOW},112 ${16 - FORK_LINE_BOW},160 16,160`);
    expect(forkLinePath(40, 0, 10, 50)).toBe(`M 40,0 C ${10 - FORK_LINE_BOW},0 ${10 - FORK_LINE_BOW},50 10,50`);
  });

  it("a live session being stopped reads stopping, muted with no dot; an exited one does not", () => {
    const meta: SessionMeta = { startedAt: "2026-10-16T09:00:00.000Z", lastActive: "2026-10-16T10:00:00.000Z", branch: "main", messages: 3 };
    const now = Date.parse("2026-10-16T10:00:30.000Z");
    expect(STOPPING_WORD).toBe("stopping");
    for (const state of [{ kind: "busy" }, { kind: "idle" }, { kind: "waiting" }] as SessionState[]) {
      expect(sessionCardMeta(meta, now, state, null, true).state, state.kind).toEqual({ word: "stopping", tone: "muted", dot: false });
    }
    expect(sessionCardMeta(meta, now, { kind: "finished" }, "Done.", true).lastLine).toBeNull();
    expect(sessionCardMeta(meta, now, { kind: "exited" }, null, true).state?.word).toBe("exited");
    expect(sessionCardMeta(meta, now, null, null, true).state).toBeNull();

    const nodes = toFlowNodes(inputs({ projects: [ide], children: [orig, fork], live: liveOf({ orig: { kind: "busy" }, fork: { kind: "exited" } }), stopping: ["orig", "fork"] }));
    const data = (id: string) => {
      const node = nodes.find((n) => n.id === `session:${id}`);
      if (node === undefined || node.type !== "session") throw new Error(id);
      return node.data;
    };
    expect(data("orig").stopping).toBe(true);
    expect(data("fork").stopping, "already exited").toBe(false);
  });

  it("the fork's tooltip and accessible name say what it was forked from; a stopping card says so", () => {
    const meta = fork.session;
    if (meta === null) throw new Error("no meta");
    const base = { child: fork, attention: false, detail: null, lastLine: null };
    expect(forkedFromText("ide-59cd")).toBe("forked from ide-59cd");
    expect(childAriaLabel("session", { ...base, forkedFromTitle: "ide-59cd" })).toBe("Session title fork, forked from ide-59cd");
    expect(childAriaLabel("session", { ...base, forkedFromTitle: null, stopping: true })).toBe("Session title fork, stopping");
    expect(sessionCardTitle({ ...base, forkedFromTitle: "ide-59cd" }, meta).split("\n")).toContain("forked from ide-59cd");
    expect(sessionCardTitle({ ...base, forkedFromTitle: null }, meta)).not.toContain("forked from");
  });
});

// --- Story 5.1: branch children ---------------------------------------------------------------

function branchMeta(over: Partial<BranchMeta> = {}): BranchMeta {
  return { head: false, upstream: null, ahead: 0, behind: 0, upstreamGone: false, worktree: null, ...over };
}

function branchChild(name: string, projectId: string, meta: Partial<BranchMeta> = {}, position: ChildNode["position"] = null): ChildNode {
  return {
    id: `${projectId}:${name}`,
    projectId,
    kind: "branch",
    label: name,
    detail: null,
    position,
    session: null,
    branchId: null,
    forkedFrom: null,
    hasTranscript: false,
    branch: branchMeta(meta),
  };
}

function branches(count: number, projectId: string): ChildNode[] {
  return Array.from({ length: count }, (_, i) => branchChild(`b${i + 1}`, projectId, { head: i === 0 }));
}

describe("branch children (Story 5.1)", () => {
  const ide = { ...project("ide", "/p/ide", 0, 0, true), showBranches: true };

  it("branches follow the sessions as a second group with their own cut: 3 sessions and 25 branches", () => {
    const children = [...sessions(3, "ide"), ...branches(25, "ide")];
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(nodes.map((n) => n.id)).toEqual([
      "ide",
      ...children.slice(0, 3).map((c) => `session:${c.id}`),
      ...children.slice(3, 13).map((c) => `branch:${c.id}`),
      "more-branches:ide",
    ]);
    expect(nodes.find((n) => n.id === "branch:ide:b1")?.position).toEqual(columnSlot(3));
    const more = nodes.find((n) => n.type === "more");
    if (more?.type !== "more") throw new Error("no more node");
    expect(more.position).toEqual(columnSlot(13));
    expect(more.data).toEqual({ projectId: "ide", group: "branches", total: 25, showingAll: false, selected: false });
    expect(moreLabel(more.data.total, more.data.showingAll)).toBe("show all (25)");

    // Showing all branches shows all 25; the sessions are untouched.
    const all = toFlowNodes(inputs({ projects: [ide], children, showAllBranches: ["ide"] }));
    expect(all.filter((n) => n.type === "branch")).toHaveLength(25);
    expect(all.find((n) => n.type === "more")?.position).toEqual(columnSlot(3 + 25));
  });

  it("sessions and branches never push each other out: 15 sessions and 12 branches give two more rows", () => {
    const children = [...sessions(15, "ide"), ...branches(12, "ide")];
    const { drawn, mores } = projectColumn("ide", children, []);
    expect(drawn.filter((d) => d.child.kind === "session")).toHaveLength(10);
    expect(drawn.filter((d) => d.child.kind === "branch")).toHaveLength(10);
    expect(mores.map((m) => [m.group, m.position.y])).toEqual([
      ["sessions", columnSlot(10).y],
      ["branches", columnSlot(21).y],
    ]);
    // The first branch sits right after the session group's more row.
    expect(drawn.find((d) => d.child.id === "ide:b1")?.position).toEqual(columnSlot(11));
    // Showing all sessions moves the branch group down, its cut unchanged.
    const opened = projectColumn("ide", children, ["ide"]);
    expect(opened.drawn.find((d) => d.child.id === "ide:b1")?.position).toEqual(columnSlot(16));
    expect(opened.drawn.filter((d) => d.child.kind === "branch")).toHaveLength(10);
    // The rects the arrow keys search hold both rows, told apart by their group.
    const rects = nodeRects([ide], children);
    expect(rects.filter((r) => r.target.kind === "more").map((r) => r.target)).toEqual([
      { kind: "more", id: "ide" },
      { kind: "more", id: "ide", group: "branches" },
    ]);
    // Only the selected group's row is marked selected.
    const selected = toFlowNodes(inputs({ projects: [ide], children, selection: moreTarget("ide", "branches") }));
    expect(selected.filter((n) => n.type === "more").map((n) => n.data.selected)).toEqual([false, true]);
  });

  it("a dragged branch keeps its position; the rest keep their slots", () => {
    const children = [branchChild("main", "ide", { head: true }), branchChild("feat", "ide", {}, { x: 300, y: 5 }), branchChild("x", "ide")];
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(nodes.slice(1).map((n) => n.position)).toEqual([columnSlot(0), { x: 300, y: 5 }, columnSlot(2)]);
  });

  it("the more row of the branch group has its own flow id and parses back; no project id can collide", () => {
    expect(moreFlowId("p", "branches")).toBe("more-branches:p");
    expect(parseFlowId("more-branches:p")).toEqual({ kind: "more", id: "p", group: "branches" });
    expect(flowIdOf(moreTarget("p", "branches"))).toBe("more-branches:p");
    expect(flowIdOf(moreTarget("p", "sessions"))).toBe("more:p");
    // A project whose id looks like a group prefix is still its own sessions row.
    expect(parseFlowId(moreFlowId("branches:p"))).toEqual({ kind: "more", id: "branches:p" });
    expect(parseFlowId("branch:p:feature/x")).toEqual({ kind: "branch", id: "p:feature/x" });
    expect(groupOf({ kind: "branch" })).toBe("branches");
    expect(groupOf({ kind: "session" })).toBe("sessions");
  });

  it("the second line: counts with zero parts left out, upstream gone, the worktree chip", () => {
    expect(branchCardParts(branchMeta({ upstream: "origin/m", ahead: 2, behind: 1 })).counts).toBe("↑2 ↓1");
    expect(branchCardParts(branchMeta({ upstream: "origin/m", ahead: 2 })).counts).toBe("↑2");
    expect(branchCardParts(branchMeta({ upstream: "origin/m", behind: 4 })).counts).toBe("↓4");
    const synced = branchCardParts(branchMeta({ upstream: "origin/m" }));
    expect(synced.counts).toBeNull();
    expect(hasBranchSecondLine(synced)).toBe(false);
    const local = branchCardParts(branchMeta());
    expect(local).toEqual({ counts: null, gone: false, chip: null });
    expect(hasBranchSecondLine(local)).toBe(false);
    const gone = branchCardParts(branchMeta({ upstream: "origin/old", upstreamGone: true }));
    expect(gone.gone).toBe(true);
    expect(gone.counts).toBeNull();
    const wt = branchCardParts(branchMeta({ worktree: { path: "C:\\src\\ide\\.worktrees\\feat", missing: false } }));
    expect(wt.chip).toEqual({ text: "…/.worktrees/feat", path: "C:\\src\\ide\\.worktrees\\feat", missing: false });
    expect(hasBranchSecondLine(wt)).toBe(true);
    const missing = branchCardParts(branchMeta({ worktree: { path: "/tmp/wt", missing: true } }));
    expect(missing.chip?.text).toBe(MISSING_WORKTREE);
  });

  it("worktreeChipText keeps the last two segments", () => {
    expect(worktreeChipText("/home/me/src/wt")).toBe("…/src/wt");
    expect(worktreeChipText("C:/a/b")).toBe("…/a/b");
    expect(worktreeChipText("/wt")).toBe("wt");
    expect(worktreeChipText("a/b")).toBe("a/b");
  });

  it("the accessible name and tooltip say current, counts, gone and the worktree", () => {
    const meta = branchMeta({ head: true, upstream: "origin/main", ahead: 2, behind: 1, worktree: { path: "/w/main", missing: false } });
    expect(branchAriaLabel("main", meta)).toBe("Branch main, current, 2 ahead, 1 behind, worktree /w/main");
    expect(branchAriaLabel("old", branchMeta({ upstream: "origin/old", upstreamGone: true, worktree: { path: "/w/o", missing: true } }))).toBe(
      "Branch old, upstream gone, worktree missing /w/o",
    );
    expect(childAriaLabel("branch", { child: branchChild("x", "p"), attention: false, detail: null, lastLine: null })).toBe("Branch x");
    expect(branchCardTitle("main", meta)).toBe("main\nupstream origin/main\nworktree /w/main");
  });

  it("the project card carries the branch read failure only while branches are on", () => {
    const off = { ...ide, showBranches: false };
    const errors = { ide: "fatal: broken" };
    expect(asProject(toFlowNodes(inputs({ projects: [ide], branchErrors: errors }))[0]).data.branchesError).toBe("fatal: broken");
    expect(asProject(toFlowNodes(inputs({ projects: [off], branchErrors: errors }))[0]).data.branchesError).toBeNull();
    expect(asProject(toFlowNodes(inputs({ projects: [ide] }))[0]).data.branchesError).toBeNull();
    expect(BRANCHES_UNAVAILABLE).toBe("branches unavailable");
  });

  it("a branch card re-renders when its facts change and keeps its identity otherwise", () => {
    const before = toFlowNodes(inputs({ projects: [ide], children: [branchChild("main", "ide", { upstream: "o/m", ahead: 1 })] }));
    const same = toFlowNodes(inputs({ projects: [ide], children: [branchChild("main", "ide", { upstream: "o/m", ahead: 1 })] }), before);
    expect(same[1]).toBe(before[1]);
    const changed = toFlowNodes(inputs({ projects: [ide], children: [branchChild("main", "ide", { upstream: "o/m", ahead: 2 })] }), before);
    expect(changed[1]).not.toBe(before[1]);
    const toggled = toFlowNodes(inputs({ projects: [{ ...ide, showBranches: false }], children: [] }), before);
    expect(toggled[0]).not.toBe(before[0]);
  });
});

describe("sessions on a branch (Story 5.3)", () => {
  const ide = { ...project("ide", "/p/ide", 0, 0, true), showBranches: true };
  const onBranch = (id: string, branch: string, position: ChildNode["position"] = null): ChildNode => ({
    ...session(id, "ide"),
    branchId: `ide:${branch}`,
    position,
  });

  it("a session whose branch card is listed is drawn right under it, indented, in the branch group", () => {
    const children = [session("plain", "ide"), onBranch("w1", "feat"), onBranch("w2", "feat"), onBranch("m1", "main"), branchChild("main", "ide", { head: true }), branchChild("feat", "ide")];
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(nodes.map((n) => n.id)).toEqual(["ide", "session:plain", "branch:ide:main", "session:m1", "branch:ide:feat", "session:w1", "session:w2"]);
    const at = (id: string) => nodes.find((n) => n.id === id)?.position;
    expect(at("session:plain")).toEqual(columnSlot(0));
    expect(at("branch:ide:main")).toEqual(columnSlot(1));
    expect(at("session:m1")).toEqual(nestedSlot(2));
    expect(nestedSlot(2)).toEqual({ x: columnSlot(2).x + COLUMN_INDENT, y: columnSlot(2).y });
    expect(at("branch:ide:feat")).toEqual(columnSlot(3));
    expect(at("session:w1")).toEqual(nestedSlot(4));
    expect(at("session:w2")).toEqual(nestedSlot(5));
    // Moving and selecting work as for any session card.
    const moved = toFlowNodes(inputs({ projects: [ide], children: children.map((c) => (c.id === "w1" ? { ...c, position: { x: 400, y: 7 } } : c)) }));
    expect(moved.find((n) => n.id === "session:w1")?.position).toEqual({ x: 400, y: 7 });
    expect(moved.find((n) => n.id === "session:w2")?.position).toEqual(nestedSlot(5)); // its slot stays reserved
    const selected = toFlowNodes(inputs({ projects: [ide], children, selection: { kind: "session", id: "w2" } }));
    expect(selected.find((n) => n.id === "session:w2")?.data).toMatchObject({ selected: true });
    expect(selected.find((n) => n.id === "session:w2")?.parentId).toBe("ide");
  });

  it("stays in the session group when its branch is not listed (branches off, or the branch gone)", () => {
    const children = [onBranch("w1", "feat"), session("plain", "ide"), branchChild("main", "ide", { head: true })];
    const { drawn } = projectColumn("ide", children, []);
    expect(drawn.map((d) => [d.child.id, d.position])).toEqual([
      ["w1", columnSlot(0)],
      ["plain", columnSlot(1)],
      ["ide:main", columnSlot(2)],
    ]);
    // Branches off: Rust lists no branch cards.
    const off = projectColumn("ide", [onBranch("w1", "feat"), session("plain", "ide")], []);
    expect(off.drawn.map((d) => d.position)).toEqual([columnSlot(0), columnSlot(1)]);
  });

  it("counts toward neither group's limit", () => {
    const children = [...sessions(10, "ide"), onBranch("w1", "b1"), ...branches(12, "ide")];
    const { drawn, mores } = projectColumn("ide", children, []);
    // Ten sessions show and no session more row: the nested one is not in that group.
    expect(drawn.filter((d) => d.child.kind === "session" && d.child.branchId === null)).toHaveLength(10);
    expect(mores.map((m) => [m.group, m.total])).toEqual([["branches", 12]]);
    // b1 then its session, the other branches after them; the more row after the tenth branch.
    expect(drawn.find((d) => d.child.id === "ide:b1")?.position).toEqual(columnSlot(10));
    expect(drawn.find((d) => d.child.id === "w1")?.position).toEqual(nestedSlot(11));
    expect(drawn.find((d) => d.child.id === "ide:b2")?.position).toEqual(columnSlot(12));
    expect(mores[0]?.position).toEqual(columnSlot(10 + 10 + 1));
    // The project's count still holds every child.
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(asProject(nodes[0]).data.childCount).toBe(children.length);
  });

  it("follows its branch card when the card is dragged, in its slot or past the limit", () => {
    const step = CHILD_HEIGHT + CHILD_GAP;
    const dragged = { x: 400, y: 30 };
    const children = [onBranch("w1", "feat"), onBranch("w2", "feat"), branchChild("main", "ide", { head: true }), branchChild("feat", "ide", {}, dragged), branchChild("x", "ide")];
    const { drawn } = projectColumn("ide", children, []);
    expect(drawn.map((d) => [d.child.id, d.position])).toEqual([
      ["ide:main", columnSlot(0)],
      ["ide:feat", dragged],
      ["w1", { x: dragged.x + COLUMN_INDENT, y: dragged.y + step }],
      ["w2", { x: dragged.x + COLUMN_INDENT, y: dragged.y + 2 * step }],
      // The dragged card keeps its slot; its sessions take none.
      ["ide:x", columnSlot(2)],
    ]);
    // Past the limit: a dragged b12 is drawn, and its undragged session under it.
    const past = [...branches(12, "ide").map((b) => (b.id === "ide:b12" ? { ...b, position: dragged } : b)), onBranch("w12", "b12")];
    const cut = projectColumn("ide", past, []);
    expect(cut.drawn.find((d) => d.child.id === "ide:b12")?.position).toEqual(dragged);
    expect(cut.drawn.find((d) => d.child.id === "w12")?.position).toEqual({ x: dragged.x + COLUMN_INDENT, y: dragged.y + step });
    expect(cut.mores.map((m) => m.group)).toEqual(["branches"]);
  });

  it("falls back to the session group while its branch card is cut by the limit", () => {
    const children = [session("plain", "ide"), onBranch("w12", "b12"), ...branches(12, "ide")];
    const { drawn } = projectColumn("ide", children, []);
    expect(drawn.slice(0, 2).map((d) => [d.child.id, d.position])).toEqual([
      ["plain", columnSlot(0)],
      ["w12", columnSlot(1)],
    ]);
    expect(drawn.find((d) => d.child.id === "ide:b1")?.position).toEqual(columnSlot(2));
    // Showing all branches draws b12, with its session under it.
    const all = projectColumn("ide", children, [], ["ide"]);
    const b12 = all.drawn.findIndex((d) => d.child.id === "ide:b12");
    expect(all.drawn[b12 + 1]?.child.id).toBe("w12");
    expect(all.drawn[b12 + 1]?.position).toEqual(nestedSlot(1 + 12));
    // A live session there is still drawn, so it can glow and be reached.
    const nodes = toFlowNodes(inputs({ projects: [ide], children }));
    expect(nodes.some((n) => n.id === "session:w12")).toBe(true);
  });

  it("the arrow keys follow the drawn order: down from a branch card reaches its session first", () => {
    const children = [onBranch("w1", "feat"), branchChild("main", "ide", { head: true }), branchChild("feat", "ide"), branchChild("x", "ide")];
    const rects = nodeRects([ide], children);
    expect(rects.map((r) => r.target.id)).toEqual(["ide", "ide:main", "ide:feat", "w1", "ide:x"]);
    const down = nearestInDirection(rectOf(rects, "branch", "ide:feat"), rects, "down");
    expect(down?.target).toEqual({ kind: "session", id: "w1" });
    expect(nearestInDirection(rectOf(rects, "session", "w1"), rects, "down")?.target).toEqual({ kind: "branch", id: "ide:x" });
    expect(nearestInDirection(rectOf(rects, "session", "w1"), rects, "up")?.target).toEqual({ kind: "branch", id: "ide:feat" });
  });
});
