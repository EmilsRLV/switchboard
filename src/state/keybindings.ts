// `keybindings.json` (Story 9.4): Rust reads and watches the file and sends its raw text (on load
// through `keybindings_get`, on every change through `keybindings://changed`); this store parses
// it, applies it over the default bindings (`applyBindingOverrides`) and keeps what Settings →
// Diagnostics lists: the file's status, its errors, its warnings and the conflicts it made.
//
// No file: the defaults. A file that is not a JSON object (or cannot be read) is one error and
// changes nothing: the overrides applied before stay. Otherwise every valid entry applies and
// each bad one is an error (its command keeps its default). The registry tells the store when a
// command registers later (an entry waiting for it applies), so the lists stay current.

import { create } from "zustand";
import { applyBindingOverrides, bindingConflicts, bindingErrors, bindingWarnings, subscribeBindings } from "../commands/registry";
import type { KeybindingsFile } from "../ipc";

/** The file's state as Diagnostics names it. */
export type KeybindingsStatus = "none" | "ok" | "errors";

/** What Diagnostics shows. */
export type KeybindingsReport = {
  status: KeybindingsStatus;
  /** What is wrong with the file: unreadable, not JSON, an unknown id, a bad key. */
  errors: readonly string[];
  /** Unbinds that leave something out of reach; `live reload unavailable: …` when Rust cannot watch. */
  warnings: readonly string[];
  /** `ctrl+k: palette.toggle, review.refresh`: keys the overrides gave to several commands. */
  conflicts: readonly string[];
};

export type KeybindingsState = KeybindingsReport & {
  /** True once a file (or its absence) has been applied. */
  loaded: boolean;
  apply: (file: KeybindingsFile) => void;
  /** Why the file could not be fetched at all (`keybindings_get` / the listener rejected). */
  setLoadError: (error: string) => void;
};

const NONE: readonly string[] = Object.freeze([]);

/** The file-level facts the report is rebuilt from when the registry changes. */
let source: { hasFile: boolean; fileError: string | null; watchError: string | null } = { hasFile: false, fileError: null, watchError: null };

/** The report now, from the last file's facts and the registry's state. */
function report(): KeybindingsReport {
  const errors = [...(source.fileError === null ? [] : [source.fileError]), ...bindingErrors()];
  const warnings = [...(source.watchError === null ? [] : [`live reload unavailable: ${source.watchError}`]), ...bindingWarnings()];
  const status: KeybindingsStatus = errors.length > 0 ? "errors" : source.hasFile ? "ok" : "none";
  return { status, errors, warnings, conflicts: bindingConflicts() };
}

export const useKeybindingsStore = create<KeybindingsState>()((set) => ({
  loaded: false,
  status: "none",
  errors: NONE,
  warnings: NONE,
  conflicts: NONE,
  apply: (file) => set({ loaded: true, ...applyKeybindingsFile(file) }),
  setLoadError: (error) => {
    source = { ...source, fileError: `cannot load keybindings.json: ${error}` };
    set({ loaded: true, ...report() });
  },
}));

// A command registering after the file (its waiting entry applies) or leaving: rebuild the report.
subscribeBindings(() => {
  if (useKeybindingsStore.getState().loaded) useKeybindingsStore.setState(report());
});

/**
 * Parse and apply `file` over the defaults; returns the report after it. An unreadable or invalid
 * file keeps the overrides applied before it.
 */
export function applyKeybindingsFile(file: KeybindingsFile): KeybindingsReport {
  const watchError = file.watchError ?? null;
  if (file.error !== null) {
    source = { hasFile: true, fileError: file.error, watchError };
    return report();
  }
  if (file.text === null) {
    source = { hasFile: false, fileError: null, watchError };
    applyBindingOverrides({});
    return report();
  }
  let parsed: unknown;
  try {
    parsed = file.text.trim() === "" ? {} : JSON.parse(file.text);
  } catch (err) {
    source = { hasFile: true, fileError: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`, watchError };
    return report();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    source = { hasFile: true, fileError: 'keybindings.json must be an object: { "<command id>": "<key>" | null }', watchError };
    return report();
  }
  source = { hasFile: true, fileError: null, watchError };
  applyBindingOverrides(parsed as Record<string, unknown>);
  return report();
}

/** Diagnostics' status value: `none`, `ok`, or `n errors`, then `, n conflicts` when there are any. */
export function keybindingsStatusText(status: KeybindingsStatus, errors: number, conflicts = 0): string {
  const base = status !== "errors" ? status : errors === 1 ? "1 error" : `${errors} errors`;
  if (conflicts === 0) return base;
  return `${base}, ${conflicts === 1 ? "1 conflict" : `${conflicts} conflicts`}`;
}
