// Story 12.2: agent cards on the canvas and their commands -- the toolbar set, the node menu, the
// project's live count and glow, the card's words, and the terminal tab's state text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMeta, ChildNode, Project, TermInfo, WorkspaceSnapshot } from "../ipc";
import { nodeRefOf } from "../canvas/edges";
import {
  agentAriaLabel,
  agentCardTitle,
  agentStateWord,
  childFlowId,
  parseFlowId,
  toFlowNodes,
  type FlowInputs,
  type ProjectFlowNode,
} from "../canvas/nodes";
import { EMPTY_LIVE, useLiveStore } from "../state/live";
import { usePaletteStore } from "../state/palette";
import { useStatusStore } from "../state/status";
import { agentTerminalId, isTerminalRestartable, stoppingSessionIds, terminalStateText, useTerminalStore } from "../state/terminals";
import { useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { registerBuiltins } from "./builtins";
import { nodeMenuCommands, TOOLBAR_KINDS, toolbarCommands } from "./nodes";
import { clearCommands, runCommand } from "./registry";

function project(id: string, expanded = true): Project {
  return { id, path: `/p/${id}`, label: id, position: { x: 0, y: 0 }, expanded, color: null, launchDefaults: null, showBranches: false };
}

function agentCard(id: string, meta: Partial<AgentMeta> = {}, projectId = "ide"): ChildNode {
  return {
    id,
    projectId,
    kind: "agent",
    label: `kimi-${id}`,
    detail: null,
    position: null,
    session: null,
    branchId: null,
    forkedFrom: null,
    hasTranscript: false,
    branch: null,
    agent: { agent: "kimi", startedAt: "2026-11-23T10:00:00.000Z", exited: null, attention: false, ...meta },
  };
}

function snapshotWith(projects: Project[], children: ChildNode[]): WorkspaceSnapshot {
  return {
    path: null,
    workspace: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, projects, branches: [], sessions: [], edges: [], defaults: { model: null, effort: null, permissionMode: null } },
    banners: [],
    revision: 1,
    branchErrors: {},
    children,
  } as WorkspaceSnapshot;
}

function termInfo(id: string, exited: number | null, stopping = false): TermInfo {
  return { id: agentTerminalId(id), kind: "agent", project_id: "ide", title: `kimi-${id}`, cwd: "/p/ide", exited, error: null, cols: 80, rows: 24, stopping };
}

function inputs(over: Partial<FlowInputs> = {}): FlowInputs {
  return { projects: [], statuses: {}, flashed: [], children: [], selection: null, dragging: {}, ...over };
}

function asProject(node: ReturnType<typeof toFlowNodes>[number] | undefined): ProjectFlowNode {
  if (node === undefined || node.type !== "project") throw new Error(`not a project node: ${node?.id}`);
  return node;
}

describe("agent cards on the canvas", () => {
  it("are agent flow nodes with their own flow id, and never an edge end", () => {
    const card = agentCard("a1");
    expect(childFlowId(card)).toBe("agent:a1");
    expect(parseFlowId("agent:a1")).toEqual({ kind: "agent", id: "a1" });
    expect(nodeRefOf({ kind: "agent", id: "a1" })).toBeNull();
    const nodes = toFlowNodes(inputs({ projects: [project("ide")], children: [card] }));
    expect(nodes.map((n) => [n.id, n.type])).toEqual([
      ["ide", "project"],
      ["agent:a1", "agent"],
    ]);
  });

  it("count toward the project's N live while running", () => {
    const children = [agentCard("a1"), agentCard("a2", { exited: 0 }), agentCard("a3"), agentCard("b1", {}, "other")];
    const nodes = toFlowNodes(inputs({ projects: [project("ide"), project("other", false)], children }));
    expect(asProject(nodes.find((n) => n.id === "ide")).data.liveCount).toBe(2);
    expect(asProject(nodes.find((n) => n.id === "other")).data.liveCount).toBe(1);
  });

  it("an unseen exit is the card's attention and the project's glow, collapsed or not", () => {
    const seen = toFlowNodes(inputs({ projects: [project("ide")], children: [agentCard("a1", { exited: 0 })] }));
    expect(asProject(seen[0]).data.attention).toBe(false);
    expect(seen[1]?.data).toMatchObject({ attention: false });

    const card = agentCard("a1", { exited: 0, attention: true });
    const nodes = toFlowNodes(inputs({ projects: [project("ide")], children: [card] }));
    expect(asProject(nodes[0]).data.attention).toBe(true);
    expect(asProject(nodes[0]).data.attentionText).toBe("kimi-a1 exited (0)");
    expect(nodes[1]?.data).toMatchObject({ attention: true });
    const collapsed = toFlowNodes(inputs({ projects: [project("ide", false)], children: [card] }));
    expect(asProject(collapsed[0]).data.attention).toBe(true);
    expect(collapsed).toHaveLength(1);
  });

  it("read running, stopping or exited (code), and name the agent", () => {
    const running = agentCard("a1").agent as AgentMeta;
    expect(agentStateWord(running)).toBe("running");
    expect(agentStateWord(running, true)).toBe("stopping");
    expect(agentStateWord({ ...running, exited: 130 }, true)).toBe("exited (130)");
    const data = { child: agentCard("a1", { exited: 0, attention: true }), attention: true, stopping: false };
    expect(agentAriaLabel(data)).toBe("Agent kimi-a1 (kimi), exited (0), needs you");
    expect(agentCardTitle(data).split("\n")[0]).toBe("exited (0)");
    expect(agentCardTitle(data)).toContain("kimi-a1 · kimi");
  });

  it("show stopping while their terminal is being stopped", () => {
    const infos = { [agentTerminalId("a1")]: termInfo("a1", null, true), [agentTerminalId("a2")]: termInfo("a2", 0, true) };
    expect(stoppingSessionIds(infos)).toEqual(["a1"]);
    const nodes = toFlowNodes(inputs({ projects: [project("ide")], children: [agentCard("a1")], stopping: ["a1"] }));
    expect(nodes[1]?.data).toMatchObject({ stopping: true });
  });
});

describe("an agent terminal", () => {
  it("reads exited (N) and is restarted from its card, never as a plain terminal", () => {
    expect(terminalStateText(termInfo("a1", null))).toBe("running");
    expect(terminalStateText(termInfo("a1", 2))).toBe("exited (2)");
    useTerminalStore.setState({ infos: { [agentTerminalId("a1")]: termInfo("a1", 0) }, pendingExits: {} });
    expect(isTerminalRestartable(agentTerminalId("a1"))).toBe(false);
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
  });
});

describe("the agent card commands", () => {
  const words = (id: string) => toolbarCommands({ kind: "agent", id }).map((c) => c.short);

  beforeEach(() => {
    clearCommands();
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false, openTerminals: [], activeTerminal: null, notice: null });
    useLiveStore.setState({ snapshot: EMPTY_LIVE, received: false, loadError: null });
    useStatusStore.setState({ statuses: {} } as never);
    useTerminalStore.setState({ infos: { [agentTerminalId("run")]: termInfo("run", null), [agentTerminalId("done")]: termInfo("done", 0) }, pendingExits: {} });
    useWorkspaceStore.setState({ snapshot: snapshotWith([project("ide")], [agentCard("run"), agentCard("done", { exited: 0 })]), loadError: null });
    registerBuiltins();
  });
  afterEach(() => {
    clearCommands();
    vi.unstubAllGlobals();
    useTerminalStore.setState({ infos: {}, pendingExits: {} });
  });

  it("the toolbar is term, stop, restart and remove", () => {
    expect(TOOLBAR_KINDS.agent).toEqual(["agent.showTerminal", "agent.stop", "agent.restart", "agent.remove"]);
    expect(words("run")).toEqual(["term", "stop"]);
    expect(words("done")).toEqual(["term", "restart", "remove"]);
  });

  it("the node menu lists only the agent commands: no resume, fork, link or review", () => {
    useUiStore.getState().select({ kind: "agent", id: "done" });
    expect(nodeMenuCommands().map((c) => c.id)).toEqual(["agent.showTerminal", "agent.restart", "agent.remove"]);
    useUiStore.getState().select({ kind: "agent", id: "run" });
    expect(nodeMenuCommands().map((c) => c.id)).toEqual(["agent.showTerminal", "agent.stop"]);
  });

  it("selecting an agent card tells Rust, and leaving it says so", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    useUiStore.getState().select({ kind: "agent", id: "done" });
    expect(invoke).toHaveBeenLastCalledWith("agent_acknowledge", { id: "done" }, undefined);
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(invoke).toHaveBeenLastCalledWith("agent_acknowledge", { id: null }, undefined);
    invoke.mockClear();
    useUiStore.getState().select({ kind: "project", id: "ide" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("Stop, Restart and Remove reach their wire names for the selected card", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "agent_stop") return termInfo("run", null, true);
      if (cmd === "agent_restart") return termInfo("done", null);
      if (cmd === "agent_remove") return { ...snapshotWith([project("ide")], [agentCard("run")]), revision: 2 };
      return true;
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    useUiStore.getState().select({ kind: "agent", id: "run" });
    expect(runCommand("agent.stop")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("agent_stop", { id: "run" }, undefined);
    expect(useTerminalStore.getState().infos[agentTerminalId("run")]?.stopping).toBe(true);
    expect(runCommand("agent.restart")).toBe(false);

    useUiStore.getState().select({ kind: "agent", id: "done" });
    expect(runCommand("agent.restart")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("agent_restart", { id: "done", cols: null, rows: null }, undefined);

    useWorkspaceStore.setState({ snapshot: snapshotWith([project("ide")], [agentCard("run"), agentCard("done", { exited: 0 })]) });
    expect(runCommand("agent.remove")).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("agent_remove", { id: "done" }, undefined);
    expect(useWorkspaceStore.getState().snapshot?.children.map((c) => c.id)).toEqual(["run"]);
    expect(useTerminalStore.getState().infos[agentTerminalId("done")]).toBeUndefined();
    expect(useUiStore.getState().selection).toBeNull();
  });
});
