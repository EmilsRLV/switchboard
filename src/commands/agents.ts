// The agent card commands of Story 12.2. An agent card is a run of another coding agent from
// `settings.agents` (Kimi Code, Qwen Code, …), started from the launch sheet in a Switchboard
// terminal and tracked by its process only (`running`, then `exited (<code>)`). Its commands are
// the node menu's (and the card's toolbar's): Show terminal, Stop (Ctrl+C, a second Ctrl+C after
// 300 ms, a kill after 5 s; a second Stop kills at once), Restart (an exited card, in the same
// tab) and Remove (an exited card: the card and its terminal go). Nothing else applies to it: no
// history, resume, fork, edges or review. Rust owns the runs; a refusal is the notice.

import { agentRemove, agentRestart, agentStop, type ChildNode } from "../ipc";
import { agentTerminalId, terminalInfo, useTerminalStore } from "../state/terminals";
import { currentSelection, isPoppedOut, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { disposeView, restore } from "../terminal/registry";
import { notify } from "./navigation";
import { mutate } from "./nodes";
import type { Command } from "./registry";
import { forgetTerminal, returnToPane, showTerminal } from "./terminal";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The selected agent card, or `null`. */
export function selectedAgent(): ChildNode | null {
  const selection = currentSelection();
  if (selection === null || selection.kind !== "agent") return null;
  return useWorkspaceStore.getState().snapshot?.children.find((c) => c.kind === "agent" && c.id === selection.id) ?? null;
}

/** True while agent card `child` runs (Rust's `exited` is `null`). */
function running(child: ChildNode | null): child is ChildNode {
  return child !== null && child.agent !== undefined && child.agent !== null && child.agent.exited === null;
}

/** True once agent card `child` has exited. */
function exited(child: ChildNode | null): child is ChildNode {
  return child !== null && child.agent !== undefined && child.agent !== null && child.agent.exited !== null;
}

/** The `when` of `agent.showTerminal`: the selected agent card's terminal is known. */
export function canShowAgentTerminal(): boolean {
  const child = selectedAgent();
  return child !== null && terminalInfo(agentTerminalId(child.id)) !== null;
}

/** `agent.showTerminal` ("Show terminal"): the pane on the selected agent card's terminal, focused. */
export async function showSelectedAgentTerminal(): Promise<boolean> {
  const child = selectedAgent();
  return child === null ? false : showTerminal(agentTerminalId(child.id));
}

/** The `when` of `agent.stop`: the selected agent card runs. */
export function canStopAgent(): boolean {
  return running(selectedAgent());
}

/** `agent.stop` ("Stop"): its card reads `stopping` until it exits; a second Stop kills at once. */
export async function stopSelectedAgent(): Promise<boolean> {
  const child = selectedAgent();
  if (!running(child)) return false;
  try {
    const info = await agentStop(child.id);
    // An exit that overtook the reply stands.
    if (terminalInfo(info.id)?.exited === null) useTerminalStore.getState().upsert(info);
    return true;
  } catch (err) {
    notify(describe(err));
    return false;
  }
}

/** The `when` of `agent.restart` and `agent.remove`: the selected agent card has exited. */
export function canRestartAgent(): boolean {
  return exited(selectedAgent());
}

/** Agent card ids a Restart was sent for and has not replied yet. */
const restarting = new Set<string>();

/**
 * `agent.restart` ("Restart"): the same agent, args and env again, in the same tab and under the
 * same card. The new run's view starts afresh; the pane opens on it, focused. A refusal is the
 * notice, and the earlier run's view comes back.
 */
export async function restartSelectedAgent(): Promise<boolean> {
  const child = selectedAgent();
  if (!exited(child) || restarting.has(child.id)) return false;
  const termId = agentTerminalId(child.id);
  const previous = terminalInfo(termId);
  restarting.add(child.id);
  // The new run's output counts from 0 again: the old view and info go before any of it arrives.
  if (previous !== null) {
    disposeView(termId);
    useTerminalStore.getState().remove([termId]);
  }
  try {
    const info = await agentRestart(child.id);
    if (isPoppedOut(termId)) await returnToPane(termId);
    useTerminalStore.getState().upsert(info);
    await showTerminal(info.id);
    return true;
  } catch (err) {
    notify(describe(err));
    if (previous !== null && terminalInfo(termId) === null) {
      useTerminalStore.getState().upsert(previous);
      void restore(termId);
    }
    return false;
  } finally {
    restarting.delete(child.id);
  }
}

/** `agent.remove` ("Remove"): the exited card and its terminal go; the selection with them. */
export async function removeSelectedAgent(): Promise<boolean> {
  const child = selectedAgent();
  if (!exited(child)) return false;
  const removed = await mutate("remove agent", () => agentRemove(child.id));
  if (!removed) return false;
  forgetTerminal(agentTerminalId(child.id));
  const ui = useUiStore.getState();
  if (ui.selection?.kind === "agent" && ui.selection.id === child.id) ui.clearSelection();
  return true;
}

/** The agent card commands: the node menu's (and the toolbar's) for an agent card. */
export function agentCommands(): Command[] {
  return [
    {
      id: "agent.showTerminal",
      title: "Show terminal",
      menu: "node",
      menuOrder: 9,
      toolbar: 1,
      short: "term",
      when: canShowAgentTerminal,
      run: async () => {
        await showSelectedAgentTerminal();
      },
    },
    {
      id: "agent.stop",
      title: "Stop",
      menu: "node",
      menuOrder: 12,
      toolbar: 2,
      short: "stop",
      when: canStopAgent,
      run: async () => {
        await stopSelectedAgent();
      },
    },
    {
      id: "agent.restart",
      title: "Restart",
      menu: "node",
      menuOrder: 13,
      toolbar: 2,
      short: "restart",
      when: canRestartAgent,
      run: async () => {
        await restartSelectedAgent();
      },
    },
    {
      id: "agent.remove",
      title: "Remove",
      menu: "node",
      menuOrder: 40,
      toolbar: 3,
      short: "remove",
      when: canRestartAgent,
      run: async () => {
        await removeSelectedAgent();
      },
    },
  ];
}
