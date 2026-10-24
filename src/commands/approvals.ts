// The actions behind Story 7.2's approvals: the operator's answer to an agent's request (the
// toast's buttons, and "Allow agent request" / "Deny agent request" for the oldest one), the
// workspace's "Agent actions: allow all" / "Agent actions: ask", and Revoke of an edge's
// "Always". Rust decides, launches and stores; these only send the operator's choice, and a
// refusal is the notice.

import { approvalAnswer, edgeSetAgentAllowed, workspaceSetAgentActions, type AgentActions, type ApprovalAnswer } from "../ipc";
import { oldestUnanswered, useApprovalsStore } from "../state/approvals";
import { useWorkspaceStore } from "../state/workspace";
import { selectedEdge } from "./edges";
import { notify } from "./navigation";
import { mutate } from "./nodes";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Send the operator's answer to request `id`; resolves whether Rust took it (a refusal is the notice). */
export async function answerRequest(id: string, answer: ApprovalAnswer): Promise<boolean> {
  const store = useApprovalsStore.getState();
  if (store.answering.includes(id)) return false;
  store.setAnswering(id, true);
  try {
    await approvalAnswer(id, answer);
    return true;
  } catch (err) {
    useApprovalsStore.getState().setAnswering(id, false);
    notify(describe(err));
    return false;
  }
}

/** The `when` of "Allow agent request" / "Deny agent request": a request with no answer on its way is pending. */
export function hasPendingRequest(): boolean {
  return oldestUnanswered() !== null;
}

/** "Allow agent request" / "Deny agent request": answer the oldest pending request with no answer on its way. */
export async function answerOldest(answer: "allow" | "deny"): Promise<boolean> {
  const request = oldestUnanswered();
  return request === null ? false : answerRequest(request.id, answer);
}

/** The workspace's policy for the agents' act tools (absent: `ask`). */
export function agentActions(): AgentActions {
  return useWorkspaceStore.getState().snapshot?.workspace.agentActions ?? "ask";
}

/** Whether the workspace is loaded (the policy commands need it). */
function hasWorkspace(): boolean {
  return useWorkspaceStore.getState().snapshot !== null;
}

/** The `when` of "Agent actions: allow all": the workspace asks now. */
export function canAllowAllAgentActions(): boolean {
  return hasWorkspace() && agentActions() === "ask";
}

/** The `when` of "Agent actions: ask": the workspace allows all now. */
export function canAskAgentActions(): boolean {
  return hasWorkspace() && agentActions() === "allowAll";
}

/** "Agent actions: allow all" / "Agent actions: ask": store the workspace's policy. */
export async function setAgentActions(mode: AgentActions): Promise<boolean> {
  const done = await mutate("agent actions", () => workspaceSetAgentActions(mode));
  if (done) notify(mode === "allowAll" ? "agent actions: allowed without asking" : "agent actions: ask each time");
  return done;
}

/** The `when` of "Revoke agent policy": the selected edge carries "Always". */
export function canRevokeEdgePolicy(): boolean {
  return selectedEdge()?.agentAllowed === true;
}

/** Revoke an edge's "Always": the next act across it asks again. */
export async function revokeEdgePolicy(id: string): Promise<boolean> {
  return mutate("revoke agent policy", () => edgeSetAgentAllowed(id, false));
}

/** "Revoke agent policy" on the selected edge. */
export async function revokeSelectedEdgePolicy(): Promise<boolean> {
  const edge = selectedEdge();
  return edge === null || edge.agentAllowed !== true ? false : revokeEdgePolicy(edge.id);
}
