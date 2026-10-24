// The approvals store mirrors Story 7.2's pending agent requests (`approvals_get`, then every
// `approvals://pending`): an agent's `start_session`, `link` or `unlink` waiting on the operator.
// Rust owns them (who asked, what runs, whether Always is offered, the 120 s deadline); the UI
// only shows them and sends the answer. Runtime only, never persisted.

import { create } from "zustand";
import type { Banner, PendingRequest } from "../ipc";

export type ApprovalsStoreState = {
  /** Every pending request, oldest first (Rust's order). */
  pending: readonly PendingRequest[];
  /** True once the first list arrived (so an older `get` result must not replace a push). */
  received: boolean;
  /** Why the mirror failed, if it did. */
  loadError: string | null;
  /** Request ids an answer was sent for and not yet confirmed: their buttons are disabled. */
  answering: readonly string[];
  applySnapshot: (pending: readonly PendingRequest[]) => void;
  setLoadError: (error: string | null) => void;
  setAnswering: (id: string, on: boolean) => void;
};

const NONE: readonly PendingRequest[] = Object.freeze([]);

export const useApprovalsStore = create<ApprovalsStoreState>()((set) => ({
  pending: NONE,
  received: false,
  loadError: null,
  answering: [],
  applySnapshot: (pending) =>
    set((s) => ({
      pending,
      received: true,
      loadError: null,
      // An answered request has left the list: its mark goes too.
      answering: s.answering.filter((id) => pending.some((r) => r.id === id)),
    })),
  setLoadError: (loadError) => set({ loadError }),
  setAnswering: (id, on) =>
    set((s) => ({ answering: on ? (s.answering.includes(id) ? s.answering : [...s.answering, id]) : s.answering.filter((a) => a !== id) })),
}));

/** The id of the banner a failed approvals load raises. */
export const APPROVALS_LOAD_ERROR_BANNER_ID = "approvals.load";

const NO_BANNERS: readonly Banner[] = Object.freeze([]);
let memoError: string | null = null;
let memoResult: readonly Banner[] = NO_BANNERS;

/**
 * The banner a failed approvals mirror raises (an agent's request could wait unseen), like the
 * other mirrors' load failures; reference-stable while the error is.
 */
export function selectApprovalsBanners(state: ApprovalsStoreState): readonly Banner[] {
  if (state.loadError !== memoError) {
    memoError = state.loadError;
    memoResult = state.loadError === null ? NO_BANNERS : [{ id: APPROVALS_LOAD_ERROR_BANNER_ID, text: state.loadError }];
  }
  return memoResult;
}

/** The oldest pending request (what "Allow agent request" / "Deny agent request" act on), or `null`. */
export function oldestRequest(): PendingRequest | null {
  return useApprovalsStore.getState().pending[0] ?? null;
}

/** The oldest pending request with no answer on its way (what the palette's Allow / Deny act on), or `null`. */
export function oldestUnanswered(): PendingRequest | null {
  const { pending, answering } = useApprovalsStore.getState();
  return pending.find((r) => !answering.includes(r.id)) ?? null;
}

/** The toast's title line: `<caller> wants to <action>`. */
export function requestTitle(request: Pick<PendingRequest, "callerName" | "action">): string {
  return `${request.callerName} wants to ${request.action}`;
}

/** The "Always for this edge" button's title: what it allows, and until when. */
export function alwaysTitle(request: Pick<PendingRequest, "callerName" | "target">): string {
  return `Every agent action from ${request.callerName} on ${request.target ?? "this target"} runs without asking until revoked`;
}

/** Seconds left before the request is denied unanswered (never below 0). */
export function secondsLeft(request: Pick<PendingRequest, "deadline">, now: number): number {
  return Math.max(0, Math.ceil((request.deadline - now) / 1000));
}
