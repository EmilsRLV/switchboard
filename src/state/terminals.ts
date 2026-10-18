// What the frontend knows about each terminal Rust runs (Story 4.1): the `TermInfo` from
// `term_open` / `term_restart` / `term_list`, updated by `term://exit`. The xterm views live in
// `terminal/registry` (they are not state); this store only drives the pane header and the
// `when`s of the terminal commands.

import { create } from "zustand";
import type { TermInfo } from "../ipc";

export type TerminalsState = {
  /** Every known terminal by id. */
  infos: Readonly<Record<string, TermInfo>>;
  /**
   * Exits that arrived for a terminal not known yet (`term://exit` overtook the `term_open`
   * reply); the next upsert of a running info for that id applies it.
   */
  pendingExits: Readonly<Record<string, number>>;
  /** Add or replace one terminal's info (applying an exit that arrived first). */
  upsert: (info: TermInfo) => void;
  /** Forget terminals (their project left the canvas). */
  remove: (ids: readonly string[]) => void;
  /** Record the size the PTY of `id` now has. */
  setSize: (id: string, cols: number, rows: number) => void;
  /** Replace everything with Rust's list (after a reload). */
  replaceAll: (infos: readonly TermInfo[]) => void;
  /** The child of `id` exited with `code` (`null`: unknown); an unknown id keeps it for later. */
  markExited: (id: string, code: number | null) => void;
};

export const useTerminalStore = create<TerminalsState>()((set) => ({
  infos: {},
  pendingExits: {},
  upsert: (info) =>
    set((s) => {
      if (!Object.hasOwn(s.pendingExits, info.id)) return { infos: { ...s.infos, [info.id]: info } };
      const { [info.id]: code, ...pendingExits } = s.pendingExits;
      const applied = info.exited === null && code !== undefined ? { ...info, exited: code } : info;
      return { infos: { ...s.infos, [info.id]: applied }, pendingExits };
    }),
  remove: (ids) =>
    set((s) => {
      const infos = { ...s.infos };
      const pendingExits = { ...s.pendingExits };
      for (const id of ids) {
        delete infos[id];
        delete pendingExits[id];
      }
      return { infos, pendingExits };
    }),
  setSize: (id, cols, rows) =>
    set((s) => {
      const info = Object.hasOwn(s.infos, id) ? s.infos[id] : undefined;
      if (info === undefined || (info.cols === cols && info.rows === rows)) return {};
      return { infos: { ...s.infos, [id]: { ...info, cols, rows } } };
    }),
  replaceAll: (infos) => set({ infos: Object.fromEntries(infos.map((info) => [info.id, info])) }),
  markExited: (id, code) =>
    set((s) => {
      const info = Object.hasOwn(s.infos, id) ? s.infos[id] : undefined;
      if (info === undefined) return { pendingExits: { ...s.pendingExits, [id]: code ?? -1 } };
      return { infos: { ...s.infos, [id]: { ...info, exited: code ?? -1 } } };
    }),
}));

/** The info of terminal `id`, or `null` when unknown. */
export function terminalInfo(id: string | null): TermInfo | null {
  if (id === null) return null;
  const infos = useTerminalStore.getState().infos;
  return Object.hasOwn(infos, id) ? (infos[id] ?? null) : null;
}

/** True when terminal `id` is known and its child runs. */
export function isTerminalRunning(id: string | null): boolean {
  const info = terminalInfo(id);
  return info !== null && info.exited === null;
}

/** True when terminal `id` is known and its child has exited (or never started). */
export function isTerminalExited(id: string | null): boolean {
  const info = terminalInfo(id);
  return info !== null && info.exited !== null;
}

/**
 * True when terminal `id` has exited and can be restarted: a plain terminal. A session
 * terminal is never restarted (resume arrives in Story 4.4).
 */
export function isTerminalRestartable(id: string | null): boolean {
  const info = terminalInfo(id);
  return info !== null && info.exited !== null && info.kind !== "session";
}

/**
 * The header's state word: `running`, `exited N`, or the reason the shell could not start.
 */
export function terminalStateText(info: TermInfo): string {
  if (info.error !== null) return info.error;
  return info.exited === null ? "running" : `exited ${info.exited}`;
}

/** Mirrors `pty::plain_id`: the id of a project's plain terminal (one per project). */
export function plainTerminalId(projectId: string): string {
  return `plain-${projectId}`;
}

/** Mirrors `pty::session_id`: the id of the terminal a launched session runs in (Story 4.2). */
export function sessionTerminalId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The terminal Switchboard runs session `sessionId` in, when it launched it; else `null`. */
export function sessionTerminal(sessionId: string): TermInfo | null {
  return terminalInfo(sessionTerminalId(sessionId));
}
