// State of the "Remove worktree" sheet (Story 5.4), the app's first confirmation: which branch's
// worktree it removes, the checks and commands Rust last sent, the "Also delete branch" box, the
// force confirm and the click's phase. `commands/removeWorktree.ts` drives it;
// `components/RemoveWorktreePane.tsx` renders it. A store rather than component state so the
// behaviour is testable without a DOM. Rust owns the checks and every command's text: nothing
// here is recomputed or persisted.

import { create } from "zustand";
import type { RemoveWorktreeCheck } from "../ipc";

export type RemoveWorktreeState = {
  /** The project and branch whose worktree the sheet removes; `null` while closed. */
  projectId: string | null;
  branch: string;
  /** Bumped on every open: a reply for a sheet that has since closed or reopened is dropped. */
  opened: number;
  /** Rust's checks; `null` until they arrive. */
  check: RemoveWorktreeCheck | null;
  /** "Also delete branch <name>": off by default. */
  deleteBranch: boolean;
  /** **Force remove…** was pressed: the second, explicit button shows. */
  forceArmed: boolean;
  /** When it was pressed (ms since the epoch): the second button stays disabled for a moment. */
  forceArmedAt: number | null;
  /** True while `worktree_remove` is in flight. */
  removing: boolean;
  /** The worktree is gone, but the sheet stays to show why the branch delete was refused. */
  removed: boolean;
  /** Why the checks, the remove or the branch delete failed; `null` otherwise. */
  error: string | null;
  open: (projectId: string, branch: string) => void;
  /**
   * Apply Rust's checks to sheet `opened`; `keepError` keeps the error shown (a refusal that
   * re-read them). A changed dirty count takes back an armed force.
   */
  applyCheck: (opened: number, check: RemoveWorktreeCheck, keepError?: boolean) => void;
  setDeleteBranch: (on: boolean) => void;
  /** Press **Force remove…** at `now` (ms since the epoch). */
  armForce: (now?: number) => void;
  setRemoving: (removing: boolean) => void;
  fail: (error: string) => void;
  /** The remove ran, the branch delete did not: the sheet says why. */
  removedKeepingBranch: (error: string) => void;
  /** Back to closed (the pane went). */
  reset: () => void;
};

/** One open sheet: what an awaited result must still match to be applied. */
export type RemoveWorktreeToken = { projectId: string; branch: string; opened: number };

const initial = {
  projectId: null,
  branch: "",
  check: null,
  deleteBranch: false,
  forceArmed: false,
  forceArmedAt: null,
  removing: false,
  removed: false,
  error: null,
};

export const useRemoveWorktreeStore = create<RemoveWorktreeState>()((set) => ({
  ...initial,
  opened: 0,
  open: (projectId, branch) => set((s) => ({ ...initial, projectId, branch, opened: s.opened + 1 })),
  applyCheck: (opened, check, keepError = false) =>
    set((s) => {
      if (s.opened !== opened || s.projectId === null) return {};
      const disarm = s.check !== null && s.check.dirty !== check.dirty;
      return { check, ...(keepError ? {} : { error: null }), ...(disarm ? { forceArmed: false, forceArmedAt: null } : {}) };
    }),
  setDeleteBranch: (on) => set({ deleteBranch: on }),
  armForce: (now = Date.now()) =>
    set((s) => (s.check !== null && s.check.dirty > 0 && !s.forceArmed ? { forceArmed: true, forceArmedAt: now } : {})),
  setRemoving: (removing) => set({ removing }),
  fail: (error) => set({ error, removing: false }),
  removedKeepingBranch: (error) => set({ removed: true, removing: false, error }),
  reset: () => set(initial),
}));

/** The open sheet's token, or `null` while none is open. */
export function removeWorktreeToken(): RemoveWorktreeToken | null {
  const { projectId, branch, opened } = useRemoveWorktreeStore.getState();
  return projectId === null ? null : { projectId, branch, opened };
}

/** True while the sheet `token` names is still the open one. */
export function isRemoveSheetOpen(token: RemoveWorktreeToken): boolean {
  const now = removeWorktreeToken();
  return now !== null && now.projectId === token.projectId && now.branch === token.branch && now.opened === token.opened;
}
