import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { NodeTarget } from "../ipc";
import { commandHint } from "../commands/keybindings";
import { clickNode, selectedBranch } from "../commands/navigation";
import { hasNodeMenu, openContextMenuFor, toolbarCommands } from "../commands/nodes";
import { closeOpenPane } from "../commands/panes";
import { reviewTargetOfSelection } from "../commands/review";
import { isCommandEnabled, runCommand, type RegisteredCommand } from "../commands/registry";
import { useLiveStore } from "../state/live";
import { usePaletteStore } from "../state/palette";
import { useStatusStore } from "../state/status";
import { useTerminalStore } from "../state/terminals";
import { useLaunchStore } from "../state/launch";
import { useReviewStore } from "../state/review";
import { currentPane, isPaneOpen, useUiStore, withPane, withSelection } from "../state/ui";
import { useWorkspaceStore } from "../state/workspace";
import { flowIdOf } from "./nodes";

/**
 * Story 11.2: whether the pointer is over a node (its card, handles and toolbar), from a
 * `display: contents` `.node-hover` wrapper's enter and leave. Local state: only that node
 * re-renders.
 */
export function useHover(): [boolean, { onMouseEnter: () => void; onMouseLeave: () => void }] {
  const [hovered, setHovered] = useState(false);
  const handlers = useMemo(() => ({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }), []);
  return [hovered, handlers];
}

/**
 * Story 11.2: the node toolbar of a project, session or branch card, to the right of the card
 * and outside its fixed box: up to four short buttons for the card's main enabled commands
 * (`toolbarCommands`), then `⋯` for the node menu. `shown` is the card's hovered-or-selected
 * (and not dragged) state; otherwise nothing is in the DOM, and nothing subscribes.
 */
export function NodeToolbar({ target, shown }: { target: NodeTarget; shown: boolean }) {
  return shown ? <ShownToolbar target={target} /> : null;
}

/**
 * A shown toolbar follows what its commands' `when`s read, so its buttons change while it is
 * on screen: the pane, the context menu and the Elsewhere tray (`noSurfaceOpen`; the pane is
 * overridden to none, but `closeOpenPane` still matters to the menu), the palette, the
 * terminals (Show terminal, Resume, Stop), the live snapshot (session states), the workspace
 * snapshot (children, branches, worktrees, edges) and the status poll (git repos). The
 * selection is overridden to this card.
 */
function ShownToolbar({ target }: { target: NodeTarget }) {
  useUiStore((s) => s.pane);
  useUiStore((s) => s.contextMenu);
  useUiStore((s) => s.elsewhereOpen);
  usePaletteStore((s) => s.isOpen);
  useTerminalStore((s) => s.infos);
  useLiveStore((s) => s.snapshot);
  useWorkspaceStore((s) => s.snapshot);
  useStatusStore((s) => s.statuses);
  const commands = toolbarCommands(target);
  const menu = hasNodeMenu(target);
  if (commands.length === 0 && !menu) return null;
  return <ToolbarRow target={target} commands={commands} menu={menu} />;
}

/**
 * Whether the open pane already serves command `id` for `target`'s card: the launch sheet open for
 * this project (or branch) under `new`, the Review pane open on this card under `review`. A click
 * then leaves the pane as it is (the typed form, the review's mode and file) instead of reopening it.
 */
export function alreadyOpenHere(id: string, target: NodeTarget): boolean {
  const pane = currentPane();
  if (pane === "launch" && (id === "project.newSession" || id === "branch.newSession")) {
    const sheet = useLaunchStore.getState();
    if (sheet.form === null || sheet.projectId === null) return false;
    if (target.kind === "project") return sheet.projectId === target.id && sheet.branch === null;
    const branch = withSelection(target, () => selectedBranch());
    return branch !== null && sheet.projectId === branch.projectId && sheet.branch === branch.label;
  }
  if (pane === "review" && id === "review.changes") {
    const open = useReviewStore.getState().target;
    const here = withSelection(target, () => reviewTargetOfSelection());
    return open !== null && here !== null && JSON.stringify(open) === JSON.stringify(here);
  }
  return false;
}

/**
 * The row itself (no hooks, so a test can call it and its handlers). A button clicks the card
 * (`clickNode`: the menu closes, the card is selected, a session in attention acknowledged),
 * leaves the pane alone when it already serves the command for this card, else closes the open
 * pane only when that pane is what disables the command (Review with the terminal pane open, New
 * session… with the sheet open for another card), then runs the command. `⋯` clicks the card and
 * opens the node menu under itself. The buttons are not in the Tab order
 * (`tabIndex -1`); a press on them never drags the card or pans the canvas (`nodrag nopan`).
 */
export function ToolbarRow({ target, commands, menu }: { target: NodeTarget; commands: readonly RegisteredCommand[]; menu: boolean }) {
  const run = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // The card's own click (xyflow → `onNodeClick`) would select too; one is enough.
    event.stopPropagation();
    const id = event.currentTarget.dataset.command;
    if (id === undefined) return;
    clickNode(flowIdOf(target));
    if (alreadyOpenHere(id, target)) return;
    // Only a pane that is what disables the command goes; Help over another pane hands back to it on close, so at most twice.
    for (let i = 0; i < 2 && isPaneOpen() && !isCommandEnabled(id) && withPane(null, () => isCommandEnabled(id)); i++) closeOpenPane();
    runCommand(id);
  };

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    clickNode(flowIdOf(target));
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenuFor(target, { x: rect.left, y: rect.bottom });
  };

  return (
    <div className="node-toolbar nodrag nopan">
      <div className="node-toolbar-row">
        {commands.map((command) => (
          <button
            key={command.id}
            type="button"
            className="node-toolbar-button"
            data-command={command.id}
            tabIndex={-1}
            aria-label={command.title}
            title={commandHint(command.id)}
            onClick={run}
          >
            {command.short ?? command.title}
          </button>
        ))}
        {menu && (
          <button type="button" className="node-toolbar-button node-toolbar-menu" tabIndex={-1} aria-label="Menu" title="Menu · right-click" onClick={openMenu}>
            ⋯
          </button>
        )}
      </div>
    </div>
  );
}
