// State of the "Import from Claude" pane: the list Rust discovered, which rows are ticked,
// and the loading / error phase. The pane component renders this; `commands/projects.ts`
// drives it (load on open, add on confirm). A store rather than component state so the
// behaviour is testable without a DOM.

import { create } from "zustand";
import type { ClaudeProject } from "../ipc";

export type ImportState = {
  /** What `claude_projects_list` returned; `null` until it has. */
  items: ClaudeProject[] | null;
  loading: boolean;
  /** Why the list could not be loaded or the add failed, if so. */
  error: string | null;
  /** `cwd`s of ticked rows. */
  selected: readonly string[];
  /** True while "Add selected" is in flight. */
  adding: boolean;
  begin: () => void;
  setItems: (items: ClaudeProject[]) => void;
  setError: (error: string | null) => void;
  toggle: (cwd: string) => void;
  setAdding: (adding: boolean) => void;
  /** Back to the initial state (the pane closed). */
  reset: () => void;
};

const NO_SELECTION: readonly string[] = Object.freeze([]);

const initial = {
  items: null,
  loading: false,
  error: null,
  selected: NO_SELECTION,
  adding: false,
};

export const useImportStore = create<ImportState>()((set) => ({
  ...initial,
  begin: () => set({ loading: true, error: null }),
  setItems: (items) => set({ items, loading: false }),
  setError: (error) => set({ error, loading: false, adding: false }),
  toggle: (cwd) =>
    set((s) => ({
      selected: s.selected.includes(cwd) ? s.selected.filter((c) => c !== cwd) : [...s.selected, cwd],
    })),
  setAdding: (adding) => set({ adding }),
  reset: () => set({ ...initial }),
}));

/** One line of the import list. */
export type ImportRow = {
  project: ClaudeProject;
  /** Folder name, as the node label would be. */
  label: string;
  /** Already a project node: shown ticked and disabled with "on canvas". */
  onCanvas: boolean;
};

/** The last path component (`B:\projects\ide` → `ide`); a bare root stays as it is. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const name = index === -1 ? trimmed : trimmed.slice(index + 1);
  // A root (`C:\`, `/`) has no component to name: show it whole.
  return name === "" || (index === -1 && trimmed !== path) ? path : name;
}

/**
 * The rows the pane shows: only projects whose folder still exists, each marked when Rust
 * says it is already on the canvas (decided there, with the same path comparison that
 * refuses duplicates). Order is preserved (Rust sorts newest first).
 */
export function importRows(items: readonly ClaudeProject[]): ImportRow[] {
  return items
    .filter((project) => project.exists)
    .map((project) => ({
      project,
      label: folderName(project.cwd),
      onCanvas: project.on_canvas,
    }));
}

/** The `cwd`s to add: selected rows that are not already on the canvas. */
export function selectedToAdd(rows: readonly ImportRow[], selected: readonly string[]): string[] {
  return rows.filter((row) => !row.onCanvas && selected.includes(row.project.cwd)).map((row) => row.project.cwd);
}
