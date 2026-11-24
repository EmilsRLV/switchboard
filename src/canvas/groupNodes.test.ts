// Story 12.3: the group frame and the collapsed group card as `toFlowNodes` and `nodeRects` derive them.
import { describe, expect, it } from "vitest";
import type { ChildNode, Group, LiveSession, Project, SessionState } from "../ipc";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CHILD_HEIGHT,
  CHILD_WIDTH,
  GROUP_FRAME_Z,
  GROUP_LABEL_HEIGHT,
  GROUP_PADDING,
  columnSlot,
  flowIdOf,
  groupCountText,
  groupRect,
  nodeRects,
  offsetMembers,
  parseFlowId,
  toFlowNodes,
  type FlowInputs,
  type GroupCardFlowNode,
  type GroupFrameFlowNode,
} from "./nodes";

function project(id: string, x: number, y: number, groupId: string | null = null, expanded = false): Project {
  return { id, path: `/p/${id}`, label: id, position: { x, y }, expanded, color: null, launchDefaults: null, showBranches: false, groupId };
}

function session(id: string, projectId: string): ChildNode {
  return { id, projectId, kind: "session", label: id, detail: null, position: null, session: null, branchId: null, forkedFrom: null, hasTranscript: false, branch: null };
}

function group(id: string, label: string, collapsed = false, color: string | null = null): Group {
  return { id, label, color, collapsed };
}

function liveRow(state: SessionState): LiveSession {
  return { state, source: "poll", pid: 1, kind: "interactive", name: "x", project_id: "a", cwd: "/p/a", started_at: 1, attention_since: 5, last_line: null, detail: null };
}

function inputs(over: Partial<FlowInputs> = {}): FlowInputs {
  return { projects: [], statuses: {}, flashed: [], children: [], selection: null, dragging: {}, ...over };
}

describe("groupRect", () => {
  it("bounds the members' cards plus the padding, with room for the label on top", () => {
    const rect = groupRect([project("a", 0, 0), project("b", 300, 100)], []);
    expect(rect).toEqual({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING - GROUP_LABEL_HEIGHT,
      width: 300 + CARD_WIDTH + 2 * GROUP_PADDING,
      height: 100 + CARD_HEIGHT + 2 * GROUP_PADDING + GROUP_LABEL_HEIGHT,
    });
    expect(groupRect([], [])).toBeNull();
  });

  it("takes in an expanded member's drawn children, and follows drag overrides", () => {
    const kids = [session("s1", "a"), session("s2", "a")];
    const slot = columnSlot(1);
    const rect = groupRect([project("a", 0, 0, "g", true)], kids)!;
    expect(rect.height).toBe(slot.y + CHILD_HEIGHT + 2 * GROUP_PADDING + GROUP_LABEL_HEIGHT);
    // Collapsed: the children are not drawn, so they do not count.
    expect(groupRect([project("a", 0, 0, "g", false)], kids)!.height).toBe(CARD_HEIGHT + 2 * GROUP_PADDING + GROUP_LABEL_HEIGHT);
    // A member dragged far right grows the frame live; a child dragged too.
    const dragged = groupRect([project("a", 0, 0), project("b", 10, 0)], [], [], [], { b: { x: 500, y: 0 } })!;
    expect(dragged.width).toBe(500 + CARD_WIDTH + 2 * GROUP_PADDING);
    const child = groupRect([project("a", 0, 0, "g", true)], kids, [], [], { "session:s2": { x: 600, y: 0 } })!;
    expect(child.width).toBe(600 + CHILD_WIDTH + 2 * GROUP_PADDING);
  });
});

describe("toFlowNodes with groups", () => {
  it("draws an expanded group as a frame behind its members, first in the list, below every card", () => {
    const projects = [project("a", 0, 0, "g"), project("b", 300, 0, "g"), project("c", 900, 0)];
    const nodes = toFlowNodes(inputs({ projects, groups: [group("g", "web")] }));
    expect(nodes.map((n) => n.id)).toEqual(["group:g", "a", "b", "c"]);
    const frame = nodes[0] as GroupFrameFlowNode;
    expect(frame.type).toBe("groupFrame");
    expect(frame.zIndex).toBe(GROUP_FRAME_Z);
    expect(frame.zIndex).toBeLessThan(0);
    expect(frame.dragHandle).toBe(".group-frame-label");
    expect(frame.position).toEqual({ x: -GROUP_PADDING, y: -GROUP_PADDING - GROUP_LABEL_HEIGHT });
    expect(frame.data.width).toBe(300 + CARD_WIDTH + 2 * GROUP_PADDING);
    expect(frame.data.group.label).toBe("web");
  });

  it("leaves a collapsed group's members and their children out and draws one card at the frame's top-left", () => {
    const projects = [project("a", 0, 0, "g", true), project("b", 300, 0, "g"), project("c", 900, 0)];
    const children = [session("s1", "a"), session("s2", "b"), session("s3", "c")];
    const nodes = toFlowNodes(inputs({ projects, children, groups: [group("g", "web", true)] }));
    expect(nodes.map((n) => n.id)).toEqual(["c", "group:g"]);
    const card = nodes[1] as GroupCardFlowNode;
    expect(card.type).toBe("groupCard");
    const rect = groupRect(projects.slice(0, 2), children)!;
    expect(card.position).toEqual({ x: rect.x, y: rect.y });
    expect(card.position).toEqual({ x: -GROUP_PADDING, y: -GROUP_PADDING - GROUP_LABEL_HEIGHT });
    expect(card.data.memberCount).toBe(2);
    expect(card.draggable).toBe(true);
  });

  it("sums the members' live counts and glows when any member's session needs the operator", () => {
    const projects = [project("a", 0, 0, "g"), project("b", 300, 0, "g")];
    const children = [session("s1", "a"), session("s2", "b"), session("s3", "b")];
    const live = { s1: liveRow({ kind: "busy" }), s2: liveRow({ kind: "idle" }), s3: liveRow({ kind: "idle" }) };
    const quiet = toFlowNodes(inputs({ projects, children, live, groups: [group("g", "web", true)] }))[0] as GroupCardFlowNode;
    expect(quiet.data.liveCount).toBe(3);
    expect(quiet.data.attention).toBe(false);
    expect(quiet.data.attentionText).toBeNull();

    const waiting = { ...live, s3: liveRow({ kind: "waiting" }) };
    const glowing = toFlowNodes(inputs({ projects, children, live: waiting, groups: [group("g", "web", true)] }))[0] as GroupCardFlowNode;
    expect(glowing.data.attention).toBe(true);
    expect(glowing.data.attentionText).toBe("s3 is waiting");
  });

  it("marks the selected group and keeps an unchanged frame's identity", () => {
    const projects = [project("a", 0, 0, "g")];
    const groups = [group("g", "web")];
    const first = toFlowNodes(inputs({ projects, groups }));
    const again = toFlowNodes(inputs({ projects, groups }), first);
    expect(again[0]).toBe(first[0]);
    const selected = toFlowNodes(inputs({ projects, groups, selection: { kind: "group", id: "g" } }), first);
    expect((selected[0] as GroupFrameFlowNode).data.selected).toBe(true);
    const renamed = toFlowNodes(inputs({ projects, groups: [group("g", "site")] }), first);
    expect(renamed[0]).not.toBe(first[0]);
  });

  it("ignores a groupId that names no group", () => {
    const nodes = toFlowNodes(inputs({ projects: [project("a", 0, 0, "ghost")], groups: [] }));
    expect(nodes.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("nodeRects with groups", () => {
  it("visits a collapsed group's card like a project card and leaves its members out", () => {
    const projects = [project("a", 0, 0, "g", true), project("b", 300, 0, "g"), project("c", 900, 0)];
    const rects = nodeRects(projects, [session("s1", "a")], [], [], [group("g", "web", true)]);
    expect(rects.map((r) => flowIdOf(r.target))).toEqual(["group:g", "c"]);
    expect(rects[0]).toMatchObject({ width: CARD_WIDTH, height: CARD_HEIGHT, x: -GROUP_PADDING, y: -GROUP_PADDING - GROUP_LABEL_HEIGHT });
    // Expanded: the members are cards again; the frame is not an arrow-key stop.
    expect(nodeRects(projects, [], [], [], [group("g", "web")]).map((r) => flowIdOf(r.target))).toEqual(["a", "b", "c"]);
  });
});

describe("group helpers", () => {
  it("round-trips a group's flow id, counts projects and offsets members", () => {
    expect(flowIdOf({ kind: "group", id: "g1" })).toBe("group:g1");
    expect(parseFlowId("group:g1")).toEqual({ kind: "group", id: "g1" });
    expect(groupCountText(1)).toBe("1 project");
    expect(groupCountText(3)).toBe("3 projects");
    expect(offsetMembers({ a: { x: 1, y: 2 }, b: { x: 10, y: 0 } }, 50, 20)).toEqual({ a: { x: 51, y: 22 }, b: { x: 60, y: 20 } });
  });
});
