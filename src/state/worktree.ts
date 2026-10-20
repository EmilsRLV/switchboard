// State of the "New worktree" sheet (Story 5.2): which project it creates a worktree in, the
// form (mode, name, base, existing branch), the options and command preview Rust last sent, and
// the submit's phase. `commands/worktree.ts` drives it (open, preview on every edit, submit);
// `components/WorktreePane.tsx` renders it. A store rather than component state so the
// behaviour is testable without a DOM. Rust owns the plan: the preview shown is Rust's, never
// recomputed here. Nothing here is persisted.

import { create } from "zustand";
import type { WorktreeMode, WorktreePreview } from "../ipc";

export type WorktreeForm = {
  mode: WorktreeMode;
  /** The new branch's name. */
  name: string;
  /** The new branch's base; `null` until the operator picks one (Rust's default then applies). */
  base: string | null;
  /** The existing branch to check out. */
  branch: string;
};

export type WorktreeSheetState = {
  /** The project the sheet creates a worktree in; `null` while closed. */
  projectId: string | null;
  projectLabel: string;
  /**
   * Bumped on every open: with `projectId` it names one sheet, so a reply that arrives after
   * the sheet closed or reopened is not applied to the new one.
   */
  opened: number;
  form: WorktreeForm | null;
  /** Rust's last preview for this sheet; `null` before the first one arrives. */
  preview: WorktreePreview | null;
  /** Bumped on every preview request; only the reply to the latest one is applied. */
  previewSeq: number;
  /**
   * The request whose reply `preview` is; Create waits while it is behind `previewSeq` (an
   * edit whose preview has not arrived yet), so it never runs a form other than the one shown.
   */
  appliedSeq: number;
  /** True while `worktree_add` is in flight. */
  creating: boolean;
  /** Why the last submit (or the preview itself) failed; `null` otherwise. */
  error: string | null;
  open: (project: { id: string; label: string }, form: WorktreeForm) => void;
  /** Change some fields; an error from the last submit clears. */
  edit: (patch: Partial<WorktreeForm>) => void;
  /** Start a preview request; returns its sequence number. */
  nextPreview: () => number;
  /**
   * Apply a preview reply when `seq` is still the latest request. In "Existing branch" with no
   * branch picked yet, the first free one is picked (the caller then asks for its preview).
   */
  applyPreview: (seq: number, preview: WorktreePreview) => void;
  /** A preview request failed: the shown command goes, the reason takes its place. */
  failPreview: (seq: number, error: string) => void;
  setCreating: (creating: boolean) => void;
  fail: (error: string) => void;
  /** Back to closed (the pane went). */
  reset: () => void;
};

/** One open sheet: what an awaited result must still match to be applied. */
export type WorktreeToken = { projectId: string; opened: number };

const initial = {
  projectId: null,
  projectLabel: "",
  form: null,
  preview: null,
  creating: false,
  error: null,
};

export const useWorktreeStore = create<WorktreeSheetState>()((set, get) => ({
  ...initial,
  opened: 0,
  previewSeq: 0,
  appliedSeq: 0,
  open: (project, form) =>
    set((s) => ({
      ...initial,
      projectId: project.id,
      projectLabel: project.label,
      form,
      opened: s.opened + 1,
    })),
  edit: (patch) =>
    set((s) => {
      if (s.form === null) return {};
      return { form: { ...s.form, ...patch }, error: null };
    }),
  nextPreview: () => {
    const seq = get().previewSeq + 1;
    set({ previewSeq: seq });
    return seq;
  },
  applyPreview: (seq, preview) =>
    set((s) => {
      if (seq !== s.previewSeq || s.form === null) return {};
      // A base not picked yet shows as the default Rust planned with; a picked one stays, even
      // when Rust no longer lists it (the preview then says why nothing would run).
      let form = s.form.base === null && preview.defaultBase !== null ? { ...s.form, base: preview.defaultBase } : s.form;
      if (form.mode === "existing" && form.branch === "" && preview.available.length > 0) form = { ...form, branch: preview.available[0]! };
      return { preview, form, appliedSeq: seq };
    }),
  failPreview: (seq, error) =>
    set((s) => {
      if (seq !== s.previewSeq || s.form === null) return {};
      const options = s.preview ?? { branches: [], available: [], defaultBase: null };
      return {
        preview: { branches: options.branches, available: options.available, defaultBase: options.defaultBase, command: null, path: null, error },
        appliedSeq: seq,
      };
    }),
  setCreating: (creating) => set({ creating }),
  fail: (error) => set({ error, creating: false }),
  reset: () => set(initial),
}));

/** The open sheet's token, or `null` while no sheet is open. */
export function worktreeToken(): WorktreeToken | null {
  const { projectId, opened, form } = useWorktreeStore.getState();
  return projectId === null || form === null ? null : { projectId, opened };
}

/** True while the sheet `token` names is still the open one. */
export function isWorktreeSheetOpen(token: WorktreeToken): boolean {
  const now = worktreeToken();
  return now !== null && now.projectId === token.projectId && now.opened === token.opened;
}
