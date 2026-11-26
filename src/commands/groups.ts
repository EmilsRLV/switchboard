// Project groups (Story 12.3). A group is a named set of projects: expanded, a frame behind its
// members whose label drags them all; collapsed, one card with the members' live count and
// attention. Rust owns every change (`group_*`, `workspace_move_nodes`); here are the commands
// (Add to group… `g`, Remove from group, the selected group's Rename / Set colour / Collapse /
// Expand / Delete, and one runtime "Go to group: <label>" per group), Enter's collapse toggle,
// and the frame or card drag that moves the members together.

import { groupMembers, groupRect, offsetMembers, CARD_HEIGHT, CARD_WIDTH, type Rect } from "../canvas/nodes";
import {
  GROUP_COLORS,
  groupAdd,
  groupCollapse,
  groupCreate,
  groupDelete,
  groupRemove,
  groupRename,
  groupSetColor,
  workspaceMoveNodes,
  type Group,
  type NodeMove,
  type Position,
  type WorkspaceSnapshot,
} from "../ipc";
import { useCanvasStore } from "../state/canvas";
import { usePaletteStore } from "../state/palette";
import { currentSelection, sameTarget, selectedProject, useUiStore } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { centreOnRect, notify } from "./navigation";
import { registerCommand, type Command } from "./registry";

/** The pick row that asks for a new group's label. */
export const NEW_GROUP_ROW = "group:new";
/** The pick row of Set group colour… that clears the colour. */
export const NO_COLOR_ROW = "none";
/** The prompt's placeholder for a new group's label. */
export const NEW_GROUP_PLACEHOLDER = "New group label";
/** The prompt's placeholder for a rename. */
export const RENAME_GROUP_PLACEHOLDER = "Group label";
/** The prefix of the runtime "Go to group" commands' ids. */
export const GO_TO_GROUP_PREFIX = "group.goto.";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Send one group change to Rust and apply the snapshot it replies with; a refusal (`group label
 * is blank`, `unknown group colour`, ...) is the notice. Resolves whether it applied.
 */
async function change(send: () => Promise<WorkspaceSnapshot>): Promise<boolean> {
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await send();
  } catch (err) {
    notify(describe(err));
    return false;
  }
  const store = useWorkspaceStore.getState();
  store.applySnapshot(snapshot);
  store.setLoadError(null);
  return true;
}

/** The workspace's groups now (none while there is no snapshot). */
export function workspaceGroups(): readonly Group[] {
  return useWorkspaceStore.getState().snapshot?.workspace.groups ?? [];
}

/** The group `id`, when it exists. */
export function findGroup(id: string): Group | null {
  return workspaceGroups().find((g) => g.id === id) ?? null;
}

/** The selected group, while a group is selected and still exists; else `null`. */
export function selectedGroup(): Group | null {
  const selection = currentSelection();
  return selection === null || selection.kind !== "group" ? null : findGroup(selection.id);
}

/** The group the selected project is in, when a project in a group is selected; else `null`. */
export function selectedProjectGroup(): Group | null {
  const project = selectedProject();
  const id = project?.groupId ?? null;
  return id === null ? null : findGroup(id);
}

// --- Add to group… / Remove from group -------------------------------------------------------

/**
 * `group.add` ("Add to group…", `g`): the palette as a pick list of the other groups by label plus
 * **New group…**; a group moves the selected project into it, New group… asks for the label.
 */
export function startAddToGroup(): boolean {
  const project = selectedProject();
  if (project === null) return false;
  useUiStore.getState().closeContextMenu();
  usePaletteStore.getState().openPick({
    placeholder: "Add to group…",
    // The project's own group is left out: picking it would do nothing.
    items: [
      ...workspaceGroups()
        .filter((g) => g.id !== project.groupId)
        .map((g) => ({ id: g.id, title: g.label })),
      { id: NEW_GROUP_ROW, title: "New group…" },
    ],
    onPick: (id) => {
      if (id === NEW_GROUP_ROW) startNewGroup(project.id);
      else void change(() => groupAdd(id, project.id));
    },
  });
  return true;
}

/** New group…: the palette asks for the label; Enter makes the group holding `projectId`. */
export function startNewGroup(projectId: string): void {
  usePaletteStore.getState().openPrompt({
    placeholder: NEW_GROUP_PLACEHOLDER,
    initial: "",
    onSubmit: (label) => {
      void change(() => groupCreate(label, projectId));
    },
  });
}

/** `group.remove` ("Remove from group"): the selected project leaves its group; its card stays where it is. */
export async function removeSelectedFromGroup(): Promise<boolean> {
  const project = selectedProject();
  if (project === null || selectedProjectGroup() === null) return false;
  return change(() => groupRemove(project.id));
}

// --- the selected group --------------------------------------------------------------------

/** `group.rename` ("Rename group…"): the palette asks for the label, prefilled with the current one. */
export function startRenameGroup(): boolean {
  const group = selectedGroup();
  if (group === null) return false;
  useUiStore.getState().closeContextMenu();
  usePaletteStore.getState().openPrompt({
    placeholder: RENAME_GROUP_PLACEHOLDER,
    initial: group.label,
    onSubmit: (label) => {
      void change(() => groupRename(group.id, label));
    },
  });
  return true;
}

/** `group.setColor` ("Set group colour…"): a pick list of the five group colours plus **None**. */
export function startSetGroupColor(): boolean {
  const group = selectedGroup();
  if (group === null) return false;
  useUiStore.getState().closeContextMenu();
  usePaletteStore.getState().openPick({
    placeholder: "Set group colour…",
    items: [...GROUP_COLORS.map((c) => ({ id: c, title: c })), { id: NO_COLOR_ROW, title: "None" }],
    onPick: (id) => {
      void change(() => groupSetColor(group.id, id === NO_COLOR_ROW ? null : id));
    },
  });
  return true;
}

/** Collapse or expand group `id` (persisted). */
export function setGroupCollapsed(id: string, collapsed: boolean): Promise<boolean> {
  return change(() => groupCollapse(id, collapsed));
}

/** Enter on a selected group, expanded or collapsed: toggle its collapse. */
export async function toggleSelectedGroup(): Promise<boolean> {
  const group = selectedGroup();
  if (group === null) return false;
  return setGroupCollapsed(group.id, !group.collapsed);
}

/** `group.delete` ("Delete group"): no confirmation; the members stay as plain projects. */
export async function deleteSelectedGroup(): Promise<boolean> {
  const group = selectedGroup();
  if (group === null) return false;
  const done = await change(() => groupDelete(group.id));
  if (done) {
    const ui = useUiStore.getState();
    if (sameTarget(ui.selection, { kind: "group", id: group.id })) ui.clearSelection();
  }
  return done;
}

/**
 * Story 12.3: before a reveal into a member of a collapsed group (`ctrl+j`, a toast), expand the
 * group. Resolves false only when that failed; true when there was nothing to do.
 */
export async function expandGroupOf(projectId: string): Promise<boolean> {
  const project = useWorkspaceStore.getState().snapshot?.workspace.projects.find((p) => p.id === projectId);
  const group = project?.groupId === undefined || project.groupId === null ? null : findGroup(project.groupId);
  if (group === null || !group.collapsed) return true;
  return setGroupCollapsed(group.id, false);
}

/**
 * Where group `id` is drawn now: its frame while expanded, its project-sized card (at the frame's
 * top-left) while collapsed; `null` when it has no members.
 */
export function drawnGroupRect(id: string): Rect | null {
  const snapshot = useWorkspaceStore.getState().snapshot;
  const group = findGroup(id);
  if (snapshot === null || group === null) return null;
  const { showAll, showAllBranches } = useUiStore.getState();
  const rect = groupRect(groupMembers(snapshot.workspace.projects, id), snapshot.children, showAll, showAllBranches);
  if (rect === null) return null;
  return group.collapsed ? { x: rect.x, y: rect.y, width: CARD_WIDTH, height: CARD_HEIGHT } : rect;
}

/** "Go to group: <label>": select group `id` and centre the canvas on it. */
export function goToGroup(id: string): boolean {
  const rect = drawnGroupRect(id);
  if (rect === null) return false;
  const ui = useUiStore.getState();
  ui.closeContextMenu();
  ui.select({ kind: "group", id });
  centreOnRect(rect);
  return true;
}

// --- the runtime Go-to commands -------------------------------------------------------------

/** The registered Go-to commands: group id → the label it was registered under and its unregister. */
const goToCommands = new Map<string, { label: string; unregister: () => void }>();

/** The title of a group's Go-to command. */
export function goToGroupTitle(label: string): string {
  return `Go to group: ${label}`;
}

/**
 * Bring the "Go to group: <label>" commands in line with `groups`: one per group, re-registered
 * when its label changed, unregistered when the group is gone.
 */
export function syncGoToGroupCommands(groups: readonly Group[]): void {
  const ids = new Set(groups.map((g) => g.id));
  for (const [id, entry] of goToCommands) {
    if (!ids.has(id)) {
      entry.unregister();
      goToCommands.delete(id);
    }
  }
  for (const group of groups) {
    const entry = goToCommands.get(group.id);
    if (entry !== undefined && entry.label === group.label) continue;
    entry?.unregister();
    const unregister = registerCommand({
      id: `${GO_TO_GROUP_PREFIX}${group.id}`,
      title: goToGroupTitle(group.label),
      run: () => {
        goToGroup(group.id);
      },
    });
    goToCommands.set(group.id, { label: group.label, unregister });
  }
}

/**
 * Keep the Go-to commands in sync with the workspace snapshot from now on. Returns the function
 * that stops it and unregisters them.
 */
export function watchGroupCommands(): () => void {
  let last: readonly Group[] | undefined;
  const sync = () => {
    const groups = useWorkspaceStore.getState().snapshot?.workspace.groups ?? NO_GROUPS;
    if (groups === last) return;
    last = groups;
    syncGoToGroupCommands(groups);
  };
  sync();
  const stop = useWorkspaceStore.subscribe(sync);
  return () => {
    stop();
    syncGoToGroupCommands([]);
  };
}

const NO_GROUPS: readonly Group[] = [];

// --- dragging a frame's label or a collapsed card --------------------------------------------

/** A group drag under way: where its node and every member were when it started, and the last offset. */
type GroupDrag = { groupId: string; origin: Position; members: Record<string, Position>; dx: number; dy: number };

let groupDrag: GroupDrag | null = null;

/** A frame's label or a collapsed card starts being dragged from `origin` (the node's position). */
export function startGroupDrag(groupId: string, origin: Position): void {
  const projects = useWorkspaceStore.getState().snapshot?.workspace.projects ?? [];
  const members: Record<string, Position> = {};
  for (const p of groupMembers(projects, groupId)) members[p.id] = { x: p.position.x, y: p.position.y };
  groupDrag = { groupId, origin: { x: origin.x, y: origin.y }, members, dx: 0, dy: 0 };
}

/**
 * The dragged group node is at `position` now: every member follows by the same offset, as
 * canvas drag overrides (the frame or card is placed from them). False when no drag of that group
 * is under way.
 */
export function dragGroupTo(groupId: string, position: Position): boolean {
  if (groupDrag === null || groupDrag.groupId !== groupId) return false;
  groupDrag.dx = position.x - groupDrag.origin.x;
  groupDrag.dy = position.y - groupDrag.origin.y;
  const canvas = useCanvasStore.getState();
  for (const [id, at] of Object.entries(offsetMembers(groupDrag.members, groupDrag.dx, groupDrag.dy))) canvas.setDragPosition(id, at);
  return true;
}

/**
 * The group drag ends: the members' new positions go to Rust in one write
 * (`workspace_move_nodes`); a refusal is the notice. The overrides are cleared once the reply is
 * in (or at once for a drag that went nowhere). Resolves whether anything was written.
 */
export async function dropGroup(groupId: string): Promise<boolean> {
  const drag = groupDrag;
  if (drag === null || drag.groupId !== groupId) return false;
  groupDrag = null;
  const targets = offsetMembers(drag.members, drag.dx, drag.dy);
  const clear = () => {
    const canvas = useCanvasStore.getState();
    for (const id of Object.keys(targets)) canvas.clearDrag(id);
  };
  if ((drag.dx === 0 && drag.dy === 0) || Object.keys(targets).length === 0) {
    clear();
    return false;
  }
  const moves: NodeMove[] = Object.entries(targets).map(([id, position]) => ({ target: { kind: "project", id }, position }));
  try {
    return await change(() => workspaceMoveNodes(moves));
  } finally {
    clear();
  }
}

// --- the commands --------------------------------------------------------------------------

/** The group commands (Story 12.3), registered with the built-ins. */
export function groupCommands(): Command[] {
  return [
    {
      id: "group.add",
      title: "Add to group…",
      keybinding: "g",
      menu: "node",
      menuOrder: 34,
      when: () => selectedProject() !== null,
      run: () => {
        startAddToGroup();
      },
    },
    {
      id: "group.remove",
      title: "Remove from group",
      menu: "node",
      menuOrder: 35,
      when: () => selectedProjectGroup() !== null,
      run: async () => {
        await removeSelectedFromGroup();
      },
    },
    {
      id: "group.rename",
      title: "Rename group…",
      menu: "node",
      menuOrder: 10,
      when: () => selectedGroup() !== null,
      run: () => {
        startRenameGroup();
      },
    },
    {
      id: "group.setColor",
      title: "Set group colour…",
      menu: "node",
      menuOrder: 11,
      when: () => selectedGroup() !== null,
      run: () => {
        startSetGroupColor();
      },
    },
    {
      id: "group.collapse",
      title: "Collapse group",
      menu: "node",
      menuOrder: 20,
      when: () => selectedGroup()?.collapsed === false,
      run: async () => {
        const group = selectedGroup();
        if (group !== null) await setGroupCollapsed(group.id, true);
      },
    },
    {
      id: "group.expand",
      title: "Expand group",
      menu: "node",
      menuOrder: 20,
      when: () => selectedGroup()?.collapsed === true,
      run: async () => {
        const group = selectedGroup();
        if (group !== null) await setGroupCollapsed(group.id, false);
      },
    },
    {
      id: "group.delete",
      title: "Delete group",
      menu: "node",
      menuOrder: 40,
      when: () => selectedGroup() !== null,
      run: async () => {
        await deleteSelectedGroup();
      },
    },
  ];
}
