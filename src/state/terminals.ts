// What the frontend knows about each terminal Rust runs (Story 4.1): the `TermInfo` from
// `term_open` / `term_restart` / `term_list`, updated by `term://exit`. The xterm models live in
// `terminal/registry` (they are not state); this store drives the pane header and the `when`s
// of the terminal commands, and its `cols` / `rows` size a hidden terminal's shadow (Story 9.5).

import { create } from "zustand";
import type { SessionState, TermInfo } from "../ipc";

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
 * terminal is never restarted; its session is resumed instead (`session.resume`, Story 4.4).
 */
export function isTerminalRestartable(id: string | null): boolean {
  const info = terminalInfo(id);
  return info !== null && info.exited !== null && info.kind !== "session";
}

/**
 * The header's state word: `running` (`stopping` while a Stop is under way, Story 4.4),
 * `exited N`, or the reason the shell could not start.
 */
export function terminalStateText(info: TermInfo): string {
  if (info.error !== null) return info.error;
  if (info.exited !== null) return `exited ${info.exited}`;
  return info.stopping ? "stopping" : "running";
}

/** Mirrors `pty::plain_id`: the id of a project's plain terminal (one per project). */
export function plainTerminalId(projectId: string): string {
  return `plain-${projectId}`;
}

/** Mirrors `pty::session_id`: the id of the terminal a launched session runs in (Story 4.2). */
export function sessionTerminalId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The inverse of {@link sessionTerminalId}: the session a session terminal id names, else `null`. */
export function sessionIdOfTerminal(terminalId: string): string | null {
  const prefix = sessionTerminalId("");
  return terminalId.startsWith(prefix) && terminalId.length > prefix.length ? terminalId.slice(prefix.length) : null;
}

/**
 * The sessions whose Switchboard terminal is being stopped (Story 4.4): session terminals with
 * `stopping` set that have not exited, by session id, in `infos` order. What the canvas reads
 * for the `stopping` word.
 */
export function stoppingSessionIds(infos: Readonly<Record<string, TermInfo>>): string[] {
  const ids: string[] = [];
  for (const info of Object.values(infos)) {
    if (info.kind !== "session" || !info.stopping || info.exited !== null) continue;
    const id = sessionIdOfTerminal(info.id);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/** The terminal Switchboard runs session `sessionId` in, when it launched it; else `null`. */
export function sessionTerminal(sessionId: string): TermInfo | null {
  return terminalInfo(sessionTerminalId(sessionId));
}

/** What a terminal's tab shows after its title (Story 4.5): a muted state word, and the attention dot. */
export type TabState = { word: string; attention: boolean };

/**
 * A tab's state: for a running session terminal the session's own state word (`busy`, `idle`,
 * `waiting`, …), with the attention dot for `waiting` / `finished`; otherwise the header's word
 * (`running`, `stopping`, `exited N`, or why it could not start). Nothing for an unknown terminal.
 */
export function tabState(info: TermInfo | null, session: SessionState | null): TabState {
  if (info === null) return { word: "", attention: false };
  if (info.kind !== "session" || info.error !== null || info.exited !== null || info.stopping || session === null) {
    return { word: terminalStateText(info), attention: false };
  }
  const word = session.kind === "other" ? session.raw : session.kind;
  return { word, attention: session.kind === "waiting" || session.kind === "finished" };
}
