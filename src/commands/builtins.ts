// The built-in commands. Everything the shell can do is here; `App` registers them once at
// startup. Escape is shared by five commands whose `when`s are mutually exclusive, which is
// what gives Esc its precedence: the context menu first, then the Elsewhere tray, then the
// palette, then whichever pane is open (`pane.close`, which both panes' Close buttons run
// too), then the selection. The arrows and Enter are the selection's: enabled only while no
// palette, pane, menu or tray is open, so an open surface keeps its own handling of them. Key-only carriers (the Escape
// commands, the `ctrl+,` toggle, the arrows, Enter) are `hidden`: the dispatcher sees them,
// the palette does not. The project commands act on the selected project and are tagged
// `menu: "node"` with a `menuOrder`, which is what the right-click menu lists, in that order.
// With focus in a terminal the dispatcher yields every key to it (Esc included) except
// `terminal.toggle` (ctrl+`), the palette's second binding, ctrl+shift+k, and the tab keys
// `terminal.prevTab` / `terminal.nextTab` (ctrl+pageup / ctrl+pagedown, Story 4.5; `terminal/keys`).

import type { Direction } from "../canvas/nodes";
import { appQuit } from "../ipc";
import { isCanvasReady, useCanvasStore } from "../state/canvas";
import { usePaletteStore } from "../state/palette";
import { useSettingsStore } from "../state/settings";
import { elsewhereCount } from "../state/live";
import { hasSelection, isContextMenuOpen, isElsewhereOpen, isPaneOpen, selectedProject, useUiStore } from "../state/ui";
import { projectHasChildren } from "../state/workspace";
import {
  activateSelection,
  attachStub,
  canToggleShowAll,
  copySelectedBranchName,
  moveSelection,
  openProjectFolder,
  openProjectInEditor,
  revealClaudeProjectDir,
  selectedBranch,
  selectedLiveSessionId,
  toggleShowAllOfSelected,
} from "./navigation";
import { canGoToAttention, goToNextAttention } from "./attention";
import { canToggleBranches, relayoutChildren, removeProject, setExpanded, toggleBranches, toggleBranchesTitle } from "./nodes";
import {
  canForkSession,
  canNewSessionOnBranch,
  canResumeSession,
  canShowSessionTerminal,
  canStopSession,
  forkSelectedSession,
  openLaunchSheet,
  openLaunchSheetForBranch,
  resumeSelectedSession,
  showSelectedSessionTerminal,
  stopSelectedSession,
} from "./sessions";
import { closeOpenPane, openPane, togglePane } from "./panes";
import { canNewWorktree, canNewWorktreeOnBranch, openWorktreeSheet, openWorktreeSheetForBranch } from "./worktree";
import { canRemoveWorktree, openRemoveWorktreeSheet } from "./removeWorktree";
import { addProjectFromPicker, isPickerIdle } from "./projects";
import { registerCommands, type Command } from "./registry";
import { hasSettingsPath, redetectBinaries, revealSettingsFile } from "./settings";
import {
  canKillTerminal,
  canCloseTerminal,
  canPopOut,
  canRestartTerminal,
  canSwitchTab,
  closeTerminal,
  canToggleTerminal,
  killTerminal,
  openProjectTerminal,
  popOutTerminal,
  restartTerminal,
  switchTab,
  toggleTerminalPane,
} from "./terminal";
import { NEXT_TAB_KEY, PALETTE_TERMINAL_KEY, PREV_TAB_KEY, TERMINAL_TOGGLE_KEY } from "../terminal/keys";

function isPaletteOpen(): boolean {
  return usePaletteStore.getState().isOpen;
}

/** True while the canvas has the keyboard: no palette, pane, context menu or Elsewhere tray is open. */
function noSurfaceOpen(): boolean {
  return !isPaletteOpen() && !isPaneOpen() && !isContextMenuOpen() && !isElsewhereOpen();
}

/** The `when` of the project actions: a project card is selected. */
function hasSelectedProject(): boolean {
  return selectedProject() !== null;
}

/** A `run` that hands the selected project's id to `action` (nothing when none is selected). */
function withSelectedProject(action: (projectId: string) => Promise<unknown>): () => Promise<void> {
  return async () => {
    const project = selectedProject();
    if (project !== null) await action(project.id);
  };
}

/** One of the four arrow commands: a hidden key-only carrier over `moveSelection`. */
function arrowCommand(direction: Direction, title: string): Command {
  return {
    id: `selection.move.${direction}`,
    title,
    keybinding: `arrow${direction}`,
    hidden: true,
    when: noSurfaceOpen,
    run: () => {
      moveSelection(direction);
    },
  };
}

export function builtinCommands(): Command[] {
  return [
    {
      id: "palette.toggle",
      title: "Toggle command palette",
      keybinding: "ctrl+k",
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      // The palette's second binding: the one that still works with focus in a terminal.
      id: "palette.toggleFromTerminal",
      title: "Toggle command palette",
      keybinding: PALETTE_TERMINAL_KEY,
      hidden: true,
      run: () => usePaletteStore.getState().toggle(),
    },
    {
      id: "contextMenu.close",
      title: "Close context menu",
      keybinding: "escape",
      hidden: true,
      when: isContextMenuOpen,
      run: () => useUiStore.getState().closeContextMenu(),
    },
    {
      id: "elsewhere.close",
      title: "Close Elsewhere tray",
      keybinding: "escape",
      hidden: true,
      when: () => isElsewhereOpen() && !isContextMenuOpen(),
      run: () => useUiStore.getState().closeElsewhere(),
    },
    {
      id: "palette.close",
      title: "Close command palette",
      keybinding: "escape",
      hidden: true,
      when: () => isPaletteOpen() && !isContextMenuOpen() && !isElsewhereOpen(),
      run: () => usePaletteStore.getState().close(),
    },
    {
      id: "settings.open",
      title: "Open settings",
      run: () => openPane("settings"),
    },
    {
      id: "settings.toggle",
      title: "Toggle settings",
      keybinding: "ctrl+,",
      hidden: true,
      run: () => togglePane("settings"),
    },
    {
      id: "pane.close",
      title: "Close pane",
      keybinding: "escape",
      hidden: true,
      when: () => isPaneOpen() && !isPaletteOpen() && !isContextMenuOpen() && !isElsewhereOpen(),
      run: closeOpenPane,
    },
    {
      id: "selection.clear",
      title: "Clear selection",
      keybinding: "escape",
      hidden: true,
      when: () => hasSelection() && !isPaneOpen() && !isPaletteOpen() && !isContextMenuOpen() && !isElsewhereOpen(),
      run: () => useUiStore.getState().clearSelection(),
    },
    {
      id: "elsewhere.toggle",
      title: "Toggle Elsewhere sessions",
      when: () => elsewhereCount() > 0,
      run: () => useUiStore.getState().toggleElsewhere(),
    },
    {
      id: "settings.reveal",
      title: "Reveal settings file",
      when: hasSettingsPath,
      run: revealSettingsFile,
    },
    {
      id: "binaries.redetect",
      title: "Re-detect binaries",
      when: () => !useSettingsStore.getState().actionBusy,
      run: redetectBinaries,
    },
    {
      id: "canvas.fitView",
      title: "Fit view",
      keybinding: "ctrl+0",
      when: isCanvasReady,
      run: async () => {
        await useCanvasStore.getState().fitView();
      },
    },
    {
      id: "project.add",
      title: "Add project folder…",
      keybinding: "ctrl+o",
      when: () => isCanvasReady() && isPickerIdle(),
      run: addProjectFromPicker,
    },
    {
      id: "project.import",
      title: "Import from Claude…",
      when: isCanvasReady,
      run: () => openPane("import"),
    },
    arrowCommand("left", "Move selection left"),
    arrowCommand("right", "Move selection right"),
    arrowCommand("up", "Move selection up"),
    arrowCommand("down", "Move selection down"),
    {
      id: "selection.activate",
      title: "Activate selection",
      keybinding: "enter",
      hidden: true,
      when: () => hasSelection() && noSurfaceOpen(),
      run: async () => {
        await activateSelection();
      },
    },
    {
      id: "attention.next",
      title: "Go to session that needs you",
      keybinding: "ctrl+j",
      when: canGoToAttention,
      run: async () => {
        await goToNextAttention();
      },
    },
    {
      // A historic session (a transcript, not live): `claude --resume <id>`, the same node.
      id: "session.resume",
      title: "Resume",
      menu: "node",
      menuOrder: 7,
      when: canResumeSession,
      run: async () => {
        await resumeSelectedSession();
      },
    },
    {
      // Any session with a transcript, live or not: a new node forked from it.
      id: "session.fork",
      title: "Fork",
      menu: "node",
      menuOrder: 8,
      when: canForkSession,
      run: async () => {
        await forkSelectedSession();
      },
    },
    {
      id: "session.showTerminal",
      title: "Show terminal",
      menu: "node",
      menuOrder: 9,
      when: canShowSessionTerminal,
      run: async () => {
        await showSelectedSessionTerminal();
      },
    },
    {
      // A live session started elsewhere; one Switchboard launched has "Show terminal".
      id: "session.attach",
      title: "Attach in terminal",
      menu: "node",
      menuOrder: 10,
      when: () => selectedLiveSessionId() !== null && !canShowSessionTerminal(),
      run: attachStub,
    },
    {
      // Only a session running in a Switchboard terminal; one started elsewhere is never signalled.
      id: "session.stop",
      title: "Stop",
      menu: "node",
      menuOrder: 12,
      when: canStopSession,
      run: async () => {
        await stopSelectedSession();
      },
    },
    {
      // `n` on a project (on a branch card `n` is `branch.newSession`); on a session it does
      // nothing. Not while the sheet is open,
      // so `n` typed on one of its selects never resets the form.
      id: "project.newSession",
      title: "New session…",
      keybinding: "n",
      menu: "node",
      menuOrder: 10,
      when: () => hasSelectedProject() && useUiStore.getState().pane !== "launch",
      run: withSelectedProject(openLaunchSheet),
    },
    {
      id: "project.terminal",
      title: "Plain terminal…",
      menu: "node",
      menuOrder: 11,
      when: hasSelectedProject,
      run: withSelectedProject(openProjectTerminal),
    },
    {
      // Story 5.2: the "New worktree" sheet, a new branch from a base by default. Git repos only
      // (by the status poll); no keybinding.
      id: "project.newWorktree",
      title: "New worktree…",
      menu: "node",
      menuOrder: 12,
      when: canNewWorktree,
      run: withSelectedProject(openWorktreeSheet),
    },
    {
      id: "terminal.toggle",
      title: "Toggle terminal",
      keybinding: TERMINAL_TOGGLE_KEY,
      when: canToggleTerminal,
      run: toggleTerminalPane,
    },
    {
      id: "terminal.kill",
      title: "Kill terminal",
      when: canKillTerminal,
      run: async () => {
        await killTerminal();
      },
    },
    {
      id: "terminal.restart",
      title: "Restart terminal",
      when: canRestartTerminal,
      run: async () => {
        await restartTerminal();
      },
    },
    {
      // An exited session terminal is not restarted (resume arrives in Story 4.4): it is closed.
      id: "terminal.close",
      title: "Close terminal",
      when: canCloseTerminal,
      run: async () => {
        await closeTerminal();
      },
    },
    {
      // The active terminal into its own OS window (Story 4.5); not when it already is in one.
      id: "terminal.popOut",
      title: "Pop out terminal",
      when: canPopOut,
      run: async () => {
        await popOutTerminal();
      },
    },
    {
      id: "terminal.nextTab",
      title: "Next terminal tab",
      keybinding: NEXT_TAB_KEY,
      when: canSwitchTab,
      run: () => switchTab(1),
    },
    {
      id: "terminal.prevTab",
      title: "Previous terminal tab",
      keybinding: PREV_TAB_KEY,
      when: canSwitchTab,
      run: () => switchTab(-1),
    },
    {
      id: "project.openEditor",
      title: "Open in external editor",
      menu: "node",
      menuOrder: 20,
      when: hasSelectedProject,
      run: withSelectedProject(openProjectInEditor),
    },
    {
      id: "project.openFolder",
      title: "Open in file manager",
      menu: "node",
      menuOrder: 21,
      when: hasSelectedProject,
      run: withSelectedProject(openProjectFolder),
    },
    {
      id: "project.revealClaudeDir",
      title: "Reveal Claude project dir",
      menu: "node",
      menuOrder: 22,
      when: hasSelectedProject,
      run: withSelectedProject(revealClaudeProjectDir),
    },
    {
      id: "project.expand",
      title: "Expand project",
      menu: "node",
      menuOrder: 30,
      when: () => {
        const project = selectedProject();
        return project !== null && !project.expanded && projectHasChildren(project.id);
      },
      run: async () => {
        const project = selectedProject();
        if (project !== null) await setExpanded(project.id, true);
      },
    },
    {
      id: "project.collapse",
      title: "Collapse project",
      menu: "node",
      menuOrder: 30,
      when: () => {
        const project = selectedProject();
        return project !== null && project.expanded && projectHasChildren(project.id);
      },
      run: async () => {
        const project = selectedProject();
        if (project !== null) await setExpanded(project.id, false);
      },
    },
    {
      id: "project.relayout",
      title: "Re-layout children",
      menu: "node",
      menuOrder: 31,
      when: hasSelectedProject,
      run: withSelectedProject(relayoutChildren),
    },
    {
      id: "project.toggleShowAll",
      title: "Show all sessions",
      menu: "node",
      menuOrder: 32,
      when: canToggleShowAll,
      run: () => {
        toggleShowAllOfSelected();
      },
    },
    {
      // The card's "branches" chip (Story 5.1); git repos only.
      id: "project.toggleBranches",
      title: "Show branches",
      dynamicTitle: toggleBranchesTitle,
      menu: "node",
      menuOrder: 33,
      when: canToggleBranches,
      run: withSelectedProject(toggleBranches),
    },
    {
      // A branch card's first menu entry (Story 5.1).
      id: "branch.copyName",
      title: "Copy branch name",
      menu: "node",
      menuOrder: 50,
      when: () => selectedBranch() !== null,
      run: async () => {
        await copySelectedBranchName();
      },
    },
    {
      // The sheet with this branch preselected; a card with a worktree chip (or the checked-out
      // branch) has none.
      id: "branch.newWorktree",
      title: "New worktree…",
      menu: "node",
      menuOrder: 51,
      when: canNewWorktreeOnBranch,
      run: async () => {
        await openWorktreeSheetForBranch();
      },
    },
    {
      // Story 5.3: `n` on a branch card opens the launch sheet aimed at that branch (its
      // worktree, the project folder for `*`, or a worktree the Start creates). Disabled on a
      // `missing` chip and while the sheet is open.
      id: "branch.newSession",
      title: "New session…",
      keybinding: "n",
      menu: "node",
      menuOrder: 52,
      when: canNewSessionOnBranch,
      run: async () => {
        await openLaunchSheetForBranch();
      },
    },
    {
      // Story 5.4: the app's first confirmation sheet. A card with a worktree chip, a `missing`
      // one too (Remove then clears that stale record). No key.
      id: "branch.removeWorktree",
      title: "Remove worktree…",
      menu: "node",
      menuOrder: 53,
      when: canRemoveWorktree,
      run: async () => {
        await openRemoveWorktreeSheet();
      },
    },
    {
      id: "project.remove",
      title: "Remove from canvas",
      menu: "node",
      menuOrder: 40,
      when: hasSelectedProject,
      run: withSelectedProject(removeProject),
    },
    {
      id: "app.quit",
      title: "Quit",
      keybinding: "ctrl+q",
      run: appQuit,
    },
  ];
}

/** Register the built-in commands; idempotent (re-registering replaces by id). */
export function registerBuiltins(): () => void {
  return registerCommands(builtinCommands());
}
