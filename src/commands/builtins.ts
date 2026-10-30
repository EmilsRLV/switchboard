// The built-in commands. Everything the shell can do is here; `App` registers them once at
// startup. Escape is shared by five commands whose `when`s are mutually exclusive, which is
// what gives Esc its precedence: the context menu first, then the Elsewhere tray, then the
// palette, then whichever pane is open (`pane.close`, which both panes' Close buttons run
// too), then the selection. The arrows and Enter are the selection's: enabled only while no
// palette, pane, menu or tray is open, so an open surface keeps its own handling of them. Key-only carriers (the Escape
// commands, the `ctrl+,` toggle, the arrows, Enter) are `hidden`: the dispatcher sees them,
// the palette does not. The project commands act on the selected project and are tagged
// `menu: "node"` with a `menuOrder`, which is what the right-click menu lists, in that order.
// Edges (Story 6.1): `e` links the selected session or project ("Link to…", a pick list), Del
// deletes the selected edge (only then), and a click on an edge opens its inspector.
// With focus in a terminal the dispatcher yields every key to it (Esc included) except
// `terminal.toggle` (ctrl+`), the palette's second binding, ctrl+shift+k, and the tab keys
// `terminal.prevTab` / `terminal.nextTab` (ctrl+pageup / ctrl+pagedown, Story 4.5; `terminal/keys`).
// Story 9.4: every pane-level button is a command too (the sheets' Start / Create / Remove, the
// Review pane's toggles, the terminal placeholder's buttons, the oldest toast's Always / Dismiss),
// so each is in the palette (the two layout carriers aside) and can be bound in `keybindings.json`.

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
import {
  answerOldest,
  canAllowAllAgentActions,
  canAlwaysAllowOldest,
  canAskAgentActions,
  canRevokeEdgePolicy,
  hasPendingRequest,
  revokeSelectedEdgePolicy,
  setAgentActions,
} from "./approvals";
import {
  canDeleteEdge,
  canInspectEdge,
  canLink,
  canRestartEdge,
  canRetryEdge,
  canSelectEdge,
  deleteSelectedEdge,
  inspectSelectedEdge,
  restartSelectedEdge,
  retrySelectedEdge,
  selectedEdge,
  startLink,
  startSelectEdge,
} from "./edges";
import { canToggleBranches, relayoutChildren, removeProject, setExpanded, toggleBranches, toggleBranchesTitle } from "./nodes";
import {
  canForkSession,
  canNewSessionOnBranch,
  canPickAddDir,
  canStartLaunch,
  pickAddDir,
  startLaunch,
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
import { isHelpPageShown, showHelpPage, startHelpPagePick } from "./help";
import {
  canClearReview,
  canOpenReview,
  canBackToCommits,
  canDismissReviewToast,
  canSetReviewLayout,
  backToCommits,
  dismissOldestReviewToast,
  setReviewLayout,
  canReviewSelection,
  canSetReviewFilter,
  canSwitchReviewMode,
  canOpenInEditor,
  canCommentOnLine,
  openCommentBox,
  openInEditor,
  clearReviewFromPalette,
  isReviewOpen,
  openReviewFromPalette,
  refreshReview,
  reviewModeTitle,
  reviewSelection,
  setReviewFilter,
  setReviewMode,
  stepReviewFile,
  toggleLayoutTitle,
  toggleReviewLayout,
} from "./review";
import {
  canCreateWorktree,
  canNewWorktree,
  canNewWorktreeOnBranch,
  canSetWorktreeMode,
  editWorktree,
  openWorktreeSheet,
  openWorktreeSheetForBranch,
  submitWorktree,
} from "./worktree";
import {
  armForceRemove,
  canArmForceRemove,
  canDiscardAndRemove,
  canRemoveCleanWorktree,
  canRemoveWorktree,
  openRemoveWorktreeSheet,
  submitRemoveWorktree,
} from "./removeWorktree";
import { addProjectFromPicker, addSelectedImports, canAddSelectedImports, isPickerIdle } from "./projects";
import { registerCommands, type Command } from "./registry";
import { hasSettingsPath, redetectBinaries, revealSettingsFile } from "./settings";
import {
  canKillTerminal,
  canCloseTerminal,
  canPopOut,
  canRestartTerminal,
  isPaneTerminalPoppedOut,
  focusPoppedWindow,
  returnActiveToPane,
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
    // -- Story 10.1: the Help pane --------------------------------------------------------------
    {
      id: "help.open",
      title: "Help",
      run: () => openPane("help"),
    },
    {
      // F1's key-only carrier, like `settings.toggle`. F1 works from fields too (`EDITABLE_PASS_KEYS`);
      // inside a terminal it is the program's (`ctrl+shift+k` → Help still opens the pane).
      id: "help.toggle",
      title: "Toggle help",
      keybinding: "f1",
      hidden: true,
      run: () => togglePane("help"),
    },
    {
      // The palette as a pick list of the guide pages (the Contents rows' palette route).
      id: "help.page",
      title: "Help: open page…",
      run: startHelpPagePick,
    },
    {
      // The pane's ← Contents.
      id: "help.contents",
      title: "Help: contents",
      when: isHelpPageShown,
      run: () => showHelpPage(null),
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
        // A selected edge: Enter opens its inspector (Story 6.1).
        if (selectedEdge() !== null) inspectSelectedEdge();
        else await activateSelection();
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
      // Story 9.4: the popped-out tab's placeholder buttons.
      id: "terminal.returnToPane",
      title: "Return terminal to pane",
      when: isPaneTerminalPoppedOut,
      run: async () => {
        await returnActiveToPane();
      },
    },
    {
      id: "terminal.focusWindow",
      title: "Focus terminal window",
      when: isPaneTerminalPoppedOut,
      run: async () => {
        await focusPoppedWindow();
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
      // Story 6.1: the palette as a pick list of the selected session's or project's valid
      // targets; Enter links, Esc cancels. Dragging from a card's handle does the same.
      id: "edge.link",
      title: "Link to…",
      keybinding: "e",
      menu: "node",
      menuOrder: 13,
      when: canLink,
      run: () => {
        startLink();
      },
    },
    {
      // The keyboard path to an edge: a pick list of the selected node's drawn edges.
      id: "edge.select",
      title: "Select edge…",
      menu: "node",
      menuOrder: 14,
      when: canSelectEdge,
      run: () => {
        startSelectEdge();
      },
    },
    {
      // Only while an edge is selected (a click on its line); otherwise Delete does nothing.
      id: "edge.delete",
      title: "Delete edge",
      keybinding: "delete",
      when: canDeleteEdge,
      run: async () => {
        await deleteSelectedEdge();
      },
    },
    {
      // Story 6.3: run a failed (or draft-held) `/add-dir` of a context edge on a running session again.
      id: "edge.retry",
      title: "Retry edge",
      when: canRetryEdge,
      run: async () => {
        await retrySelectedEdge();
      },
    },
    {
      // Story 6.3: stop the edge's session and resume it with its context edges as `--add-dir`.
      id: "edge.restartWithFlags",
      title: "Restart with flags",
      when: canRestartEdge,
      run: async () => {
        await restartSelectedEdge();
      },
    },
    {
      // Story 7.2: an edge's "Always for this edge" goes; the next agent action across it asks.
      id: "edge.revokeAgentPolicy",
      title: "Revoke agent policy",
      when: canRevokeEdgePolicy,
      run: async () => {
        await revokeSelectedEdgePolicy();
      },
    },
    {
      // Story 7.2: the oldest agent request waiting on the operator (the toast's Allow / Deny).
      id: "approval.allow",
      title: "Allow agent request",
      when: hasPendingRequest,
      run: async () => {
        await answerOldest("allow");
      },
    },
    {
      id: "approval.deny",
      title: "Deny agent request",
      when: hasPendingRequest,
      run: async () => {
        await answerOldest("deny");
      },
    },
    {
      // Story 9.4: the oldest request's "Always for this edge", where it offers it.
      id: "approval.always",
      title: "Always allow agent request (this edge)",
      when: canAlwaysAllowOldest,
      run: async () => {
        await answerOldest("always");
      },
    },
    {
      // Story 8.1: the Review pane on the selected project, branch or session (its working-tree
      // diff). The key is the canvas's (no palette, pane, menu or tray open); the palette and the
      // node menu list it too, last, in a group of its own (bare keys never fire from those: the
      // dispatcher leaves them be).
      id: "review.changes",
      title: "Review changes",
      keybinding: "r",
      menu: "node",
      menuOrder: 60,
      when: () => canReviewSelection() && (noSurfaceOpen() || isPaletteOpen() || isContextMenuOpen()),
      run: () => {
        reviewSelection();
      },
    },
    {
      id: "review.refresh",
      title: "Review: refresh",
      when: isReviewOpen,
      run: refreshReview,
    },
    {
      id: "review.filterAll",
      title: "Review: all changes",
      when: canSetReviewFilter,
      run: () => setReviewFilter("all"),
    },
    {
      id: "review.filterStaged",
      title: "Review: staged changes",
      when: canSetReviewFilter,
      run: () => setReviewFilter("staged"),
    },
    {
      id: "review.filterUnstaged",
      title: "Review: unstaged changes",
      when: canSetReviewFilter,
      run: () => setReviewFilter("unstaged"),
    },
    {
      // Story 8.2: the pane's mode. vs base and Commits on a project or a branch only.
      id: "review.modeChanges",
      title: reviewModeTitle("changes"),
      when: () => canSwitchReviewMode("changes"),
      run: () => setReviewMode("changes"),
    },
    {
      id: "review.modeBase",
      title: reviewModeTitle("base"),
      when: () => canSwitchReviewMode("base"),
      run: () => setReviewMode("base"),
    },
    {
      id: "review.modeCommits",
      title: reviewModeTitle("commits"),
      when: () => canSwitchReviewMode("commits"),
      run: () => setReviewMode("commits"),
    },
    {
      // Story 8.3: every file of the folder (where the pane has one).
      id: "review.modeFiles",
      title: reviewModeTitle("files"),
      when: () => canSwitchReviewMode("files"),
      run: () => setReviewMode("files"),
    },
    {
      // Story 8.3: the configured editor at the selected file and the line under the cursor (else
      // the first visible line). The bare key never fires from a text field (the dispatcher's rule).
      id: "review.openEditor",
      title: "Open in editor",
      keybinding: "o",
      when: canOpenInEditor,
      run: async () => {
        await openInEditor();
      },
    },
    {
      // Story 8.4: a comment on the shown file's current line, to a session target only (its box
      // takes the text; ctrl+Enter sends, Esc cancels). The bare key never fires while typing.
      id: "review.comment",
      title: "Comment on line",
      keybinding: "c",
      when: canCommentOnLine,
      run: () => {
        openCommentBox();
      },
    },
    {
      // Side by side ↔ unified.
      id: "review.toggleLayout",
      title: "Review: unified view",
      dynamicTitle: toggleLayoutTitle,
      when: isReviewOpen,
      run: toggleReviewLayout,
    },
    {
      // Story 9.4: the layout toggle's two buttons. Key-only carriers: the palette has the toggle above.
      id: "review.layoutSplit",
      title: "Review: side-by-side view",
      hidden: true,
      when: () => canSetReviewLayout("split"),
      run: () => setReviewLayout("split"),
    },
    {
      id: "review.layoutUnified",
      title: "Review: unified view",
      hidden: true,
      when: () => canSetReviewLayout("unified"),
      run: () => setReviewLayout("unified"),
    },
    {
      // Story 9.4: Commits mode's "← Commits".
      id: "review.backToCommits",
      title: "Review: back to commits",
      when: canBackToCommits,
      run: backToCommits,
    },
    {
      // Story 9.4: the oldest review toast's Dismiss (the toast goes, the flag stays).
      id: "review.dismissToast",
      title: "Dismiss review toast",
      when: canDismissReviewToast,
      run: dismissOldestReviewToast,
    },
    {
      // The next file in the tree (the requested files first).
      id: "review.nextFile",
      title: "Review: next file",
      keybinding: "j",
      when: () => isReviewOpen() && !isPaletteOpen() && !isContextMenuOpen(),
      run: () => stepReviewFile(1),
    },
    {
      id: "review.prevFile",
      title: "Review: previous file",
      keybinding: "k",
      when: () => isReviewOpen() && !isPaletteOpen() && !isContextMenuOpen(),
      run: () => stepReviewFile(-1),
    },
    {
      // Story 7.4: the selected flagged session's review request, else the newest one.
      id: "review.open",
      title: "Open review request",
      when: canOpenReview,
      run: async () => {
        await openReviewFromPalette();
      },
    },
    {
      // Story 7.4: lower the selected (else the newest) flagged session's review flag, no pane.
      id: "review.clear",
      title: "Clear review flag",
      when: canClearReview,
      run: async () => {
        await clearReviewFromPalette();
      },
    },
    {
      // Story 7.2: the workspace's policy for the agents' act tools.
      id: "agentActions.allowAll",
      title: "Agent actions: allow all",
      when: canAllowAllAgentActions,
      run: async () => {
        await setAgentActions("allowAll");
      },
    },
    {
      id: "agentActions.ask",
      title: "Agent actions: ask",
      when: canAskAgentActions,
      run: async () => {
        await setAgentActions("ask");
      },
    },
    // -- Story 9.4: the sheets' buttons ---------------------------------------------------------
    {
      id: "launch.start",
      title: "New session: start",
      when: canStartLaunch,
      run: async () => {
        await startLaunch();
      },
    },
    {
      id: "launch.addFolder",
      title: "New session: add folder…",
      when: canPickAddDir,
      run: async () => {
        await pickAddDir();
      },
    },
    {
      id: "worktree.modeNew",
      title: "New worktree: new branch",
      when: () => canSetWorktreeMode("new"),
      run: async () => {
        await editWorktree({ mode: "new" });
      },
    },
    {
      id: "worktree.modeExisting",
      title: "New worktree: existing branch",
      when: () => canSetWorktreeMode("existing"),
      run: async () => {
        await editWorktree({ mode: "existing" });
      },
    },
    {
      id: "worktree.create",
      title: "New worktree: create",
      when: canCreateWorktree,
      run: async () => {
        await submitWorktree();
      },
    },
    {
      // The remove-worktree sheet's Remove: a clean (or missing) worktree only.
      id: "worktree.remove",
      title: "Remove worktree: remove",
      when: canRemoveCleanWorktree,
      run: async () => {
        await submitRemoveWorktree(false);
      },
    },
    {
      // Force remove…: only reveals the second, explicit step.
      id: "worktree.forceRemove",
      title: "Remove worktree: force remove…",
      when: canArmForceRemove,
      run: armForceRemove,
    },
    {
      // The second step, once Force remove… was pressed and its delay has passed.
      id: "worktree.discardAndRemove",
      title: "Remove worktree: discard changes and remove",
      when: () => canDiscardAndRemove(),
      run: async () => {
        await submitRemoveWorktree(true);
      },
    },
    {
      id: "import.addSelected",
      title: "Import: add selected",
      when: canAddSelectedImports,
      run: addSelectedImports,
    },
    {
      id: "edge.inspect",
      title: "Inspect edge",
      when: canInspectEdge,
      run: inspectSelectedEdge,
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
