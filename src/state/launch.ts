// State of the launch sheet (Story 4.2): which project it starts a session in, the session id
// Rust proposed for it, the form, and the start's phase. `commands/sessions.ts` drives it (open
// with Rust's prefill, start, pick an add-dir); `components/LaunchPane.tsx` renders it. A store
// rather than component state so the behaviour is testable without a DOM. Nothing here is
// persisted: add-dirs, the prompt, the name and background are never remembered (Rust
// remembers the three choices per project). Story 5.3 adds where the sheet starts: the branch
// card it was opened on and the folder Rust resolved for it (never recomputed here), the
// `git worktree add` its Start runs first for a branch without a worktree, and the repo's top
// level for the project sheet's `--worktree` option.

import { create } from "zustand";
import { editedForm, type LaunchForm } from "../commands/launch";
import type { WorktreePlanPreview } from "../ipc";

/** Where an open sheet starts, as Rust's prefill said (Story 5.3). */
export type LaunchSheetTarget = {
  /** The branch card the sheet was opened on; `null` on the project's sheet. */
  branch: string | null;
  /** The folder the session would run in; `null` while a worktree plan is refused. */
  targetPath: string | null;
  /** A branch without a worktree: what its Start runs first. */
  worktreePlan: WorktreePlanPreview | null;
  /** The project's sheet of a git project: its top level (`--worktree`); `null` otherwise. */
  repoTop: string | null;
};

export type LaunchSheetState = LaunchSheetTarget & {
  /** The project the sheet starts a session in; `null` while closed. */
  projectId: string | null;
  /** That project's folder. */
  projectPath: string;
  /** The project's label, for the sheet's heading. */
  projectLabel: string;
  /** The session id Rust proposed for this sheet (its default name was made from it). */
  sessionId: string;
  /**
   * Bumped on every open: with `projectId` it names one sheet, so a reply that arrives after
   * the sheet closed or reopened is not applied to the new one.
   */
  opened: number;
  form: LaunchForm | null;
  /** True while `session_launch` is in flight. */
  starting: boolean;
  /** Why the last start failed (shown under Start); `null` otherwise. */
  error: string | null;
  /** The listed add-dirs Rust named as missing; Start stays blocked while any is listed. */
  missingDirs: readonly string[];
  open: (project: { id: string; path: string; label: string }, sessionId: string, form: LaunchForm, target?: Partial<LaunchSheetTarget>) => void;
  /** Change some fields; an error from the last start clears. */
  edit: (patch: Partial<LaunchForm>) => void;
  setStarting: (starting: boolean) => void;
  fail: (error: string, missingDirs: readonly string[]) => void;
  /**
   * Take a fresh prefill's target and session id (Story 5.3: a branch sheet re-read after its
   * worktree was made but the start failed); the form, the error and the open sheet stay.
   */
  retarget: (sessionId: string, target: Partial<LaunchSheetTarget>) => void;
  /** Back to closed (the pane went). */
  reset: () => void;
};

/** One open sheet: what an awaited result must still match to be applied. */
export type SheetToken = { projectId: string; opened: number };

const NO_DIRS: readonly string[] = Object.freeze([]);

const initial = {
  projectId: null,
  projectPath: "",
  projectLabel: "",
  sessionId: "",
  form: null,
  starting: false,
  error: null,
  missingDirs: NO_DIRS,
  branch: null,
  targetPath: null,
  worktreePlan: null,
  repoTop: null,
};

export const useLaunchStore = create<LaunchSheetState>()((set) => ({
  ...initial,
  opened: 0,
  open: (project, sessionId, form, target = {}) =>
    set((s) => ({
      ...initial,
      projectId: project.id,
      projectPath: project.path,
      projectLabel: project.label,
      sessionId,
      form,
      branch: target.branch ?? null,
      // The project's sheet runs in the project folder.
      targetPath: target.targetPath === undefined ? project.path : target.targetPath,
      worktreePlan: target.worktreePlan ?? null,
      repoTop: target.repoTop ?? null,
      opened: s.opened + 1,
    })),
  edit: (patch) =>
    set((s) => {
      if (s.form === null) return {};
      const form = editedForm(s.form, patch);
      // A missing add-dir that was removed no longer blocks Start.
      const missingDirs = s.missingDirs.filter((d) => form.addDirs.includes(d));
      return { form, error: null, missingDirs: missingDirs.length === 0 ? NO_DIRS : missingDirs };
    }),
  setStarting: (starting) => set({ starting }),
  fail: (error, missingDirs) => set({ error, missingDirs: missingDirs.length === 0 ? NO_DIRS : [...missingDirs], starting: false }),
  retarget: (sessionId, target) =>
    set((s) => (s.form === null ? {} : { sessionId, ...target })),
  reset: () => set(initial),
}));

/** The open sheet's token, or `null` while no sheet is open. */
export function sheetToken(): SheetToken | null {
  const { projectId, opened, form } = useLaunchStore.getState();
  return projectId === null || form === null ? null : { projectId, opened };
}

/** True while the sheet `token` names is still the open one. */
export function isSheetOpen(token: SheetToken): boolean {
  const now = sheetToken();
  return now !== null && now.projectId === token.projectId && now.opened === token.opened;
}
