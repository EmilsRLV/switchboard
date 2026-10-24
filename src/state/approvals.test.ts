import { beforeEach, describe, expect, it } from "vitest";
import type { PendingRequest, WorkspaceSnapshot } from "../ipc";
import { answerOldest, answerRequest, agentActions, canAllowAllAgentActions, canAskAgentActions, canRevokeEdgePolicy, hasPendingRequest } from "../commands/approvals";
import { alwaysTitle, oldestRequest, oldestUnanswered, requestTitle, secondsLeft, selectApprovalsBanners, useApprovalsStore } from "./approvals";
import { useUiStore } from "./ui";
import { useWorkspaceStore } from "./workspace";

function request(id: string, extra: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id,
    caller: "s1",
    callerName: "api-1",
    tool: "start_session",
    action: "start a session on ui",
    detail: "claude --session-id x",
    argv: ["claude", "--session-id", "x"],
    always: false,
    target: null,
    createdAt: 1_000,
    deadline: 121_000,
    ...extra,
  };
}

function workspace(agentActions?: "ask" | "allowAll", agentAllowed?: boolean): WorkspaceSnapshot {
  return {
    path: null,
    workspace: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects: ["api", "ui"].map((id, i) => ({
        id,
        path: `/p/${id}`,
        label: id,
        position: { x: i * 300, y: 0 },
        expanded: false,
        color: null,
        launchDefaults: null,
        showBranches: false,
      })),
      branches: [],
      sessions: [],
      edges: [
        {
          id: "e1",
          from: { type: "project", id: "api" },
          to: { type: "project", id: "ui" },
          kind: "context",
          label: null,
          createdAt: "x",
          ...(agentAllowed === undefined ? {} : { agentAllowed }),
        },
      ],
      defaults: { model: null, effort: null, permissionMode: null },
      ...(agentActions === undefined ? {} : { agentActions }),
    },
    banners: [],
    revision: 1,
    children: [],
    branchErrors: {},
  };
}

describe("approvals store (Story 7.2)", () => {
  beforeEach(() => {
    useApprovalsStore.setState({ pending: [], received: false, loadError: null, answering: [] });
    useWorkspaceStore.setState({ snapshot: null, loadError: null });
    useUiStore.setState({ selection: null, notice: null });
  });

  it("mirrors Rust's list oldest first and drops the answering mark of a request that left", () => {
    expect(oldestRequest()).toBeNull();
    expect(hasPendingRequest()).toBe(false);
    useApprovalsStore.getState().applySnapshot([request("a1"), request("a2", { always: true })]);
    expect(oldestRequest()?.id).toBe("a1");
    expect(hasPendingRequest()).toBe(true);
    useApprovalsStore.getState().setAnswering("a1", true);
    useApprovalsStore.getState().setAnswering("a1", true);
    expect(useApprovalsStore.getState().answering).toEqual(["a1"]);
    useApprovalsStore.getState().applySnapshot([request("a2")]);
    expect(useApprovalsStore.getState().answering).toEqual([]);
    expect(useApprovalsStore.getState().received).toBe(true);
  });

  it("the palette answers the oldest request with no answer on its way", () => {
    useApprovalsStore.getState().applySnapshot([request("a1"), request("a2")]);
    useApprovalsStore.getState().setAnswering("a1", true);
    expect(oldestUnanswered()?.id).toBe("a2");
    useApprovalsStore.getState().setAnswering("a2", true);
    expect(oldestUnanswered()).toBeNull();
    expect(hasPendingRequest()).toBe(false);
  });

  it("a failed load is a banner, like the other mirrors' failures", () => {
    expect(selectApprovalsBanners(useApprovalsStore.getState())).toEqual([]);
    useApprovalsStore.getState().setLoadError("approvals load failed: boom");
    expect(selectApprovalsBanners(useApprovalsStore.getState())).toEqual([{ id: "approvals.load", text: "approvals load failed: boom" }]);
  });

  it("words the toast and counts down to the deadline", () => {
    expect(requestTitle(request("a1"))).toBe("api-1 wants to start a session on ui");
    expect(alwaysTitle(request("a1", { always: true, target: "ui" }))).toBe("Every agent action from api-1 on ui runs without asking until revoked");
    expect(secondsLeft(request("a1"), 1_000)).toBe(120);
    expect(secondsLeft(request("a1"), 120_500)).toBe(1);
    expect(secondsLeft(request("a1"), 500_000)).toBe(0);
  });

  it("an answer that Rust cannot take is the notice and frees the buttons", async () => {
    useApprovalsStore.getState().applySnapshot([request("a1")]);
    // No Tauri runtime under vitest: the call rejects.
    expect(await answerOldest("allow")).toBe(false);
    expect(useApprovalsStore.getState().answering).toEqual([]);
    expect(useUiStore.getState().notice?.text).toMatch(/no Tauri runtime/);
    expect(await answerRequest("a1", "deny")).toBe(false);
    useApprovalsStore.getState().applySnapshot([]);
    expect(await answerOldest("deny")).toBe(false);
  });

  it("the policy commands follow the workspace's agentActions and the selected edge's Always", () => {
    expect([canAllowAllAgentActions(), canAskAgentActions()]).toEqual([false, false]);
    useWorkspaceStore.setState({ snapshot: workspace() });
    expect(agentActions()).toBe("ask");
    expect([canAllowAllAgentActions(), canAskAgentActions()]).toEqual([true, false]);
    useWorkspaceStore.setState({ snapshot: workspace("allowAll") });
    expect([canAllowAllAgentActions(), canAskAgentActions()]).toEqual([false, true]);
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(canRevokeEdgePolicy()).toBe(false);
    useWorkspaceStore.setState({ snapshot: workspace("ask", true) });
    useUiStore.getState().select({ kind: "edge", id: "e1" });
    expect(canRevokeEdgePolicy()).toBe(true);
  });
});
