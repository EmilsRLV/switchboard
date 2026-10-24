// The inbox store mirrors Story 7.3's unread peer-message counts (`inbox_unread_get`, then every
// `inbox://unread`): `{sessionId: count}` for every session with unread messages. Rust owns the
// inbox and its counts; the session card draws `N new` from them. Runtime only, never persisted.

import { create } from "zustand";
import type { InboxUnreadMap } from "../ipc";

export type InboxStoreState = {
  unread: InboxUnreadMap;
  /** True once the first map arrived (so an older `get` result must not replace a push). */
  received: boolean;
  /** Why the mirror failed, if it did. */
  loadError: string | null;
  applySnapshot: (unread: InboxUnreadMap) => void;
  setLoadError: (error: string | null) => void;
};

export const EMPTY_UNREAD: InboxUnreadMap = Object.freeze({}) as InboxUnreadMap;

export const useInboxStore = create<InboxStoreState>()((set) => ({
  unread: EMPTY_UNREAD,
  received: false,
  loadError: null,
  applySnapshot: (unread) => set({ unread, received: true, loadError: null }),
  setLoadError: (loadError) => set({ loadError }),
}));

/** Session `id`'s unread count in `unread` (0 when it has none; never a prototype key). */
export function unreadIn(unread: InboxUnreadMap, id: string): number {
  if (!Object.prototype.hasOwnProperty.call(unread, id)) return 0;
  const count = unread[id];
  return typeof count === "number" && count > 0 ? count : 0;
}

/** The badge text for `count` unread messages: `N new`, or `null` at 0. */
export function unreadBadge(count: number): string | null {
  return count > 0 ? `${count} new` : null;
}
