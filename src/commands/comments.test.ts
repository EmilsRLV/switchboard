// Story 8.4: line comments (the command's gating, the box's keys, sending) and the touched mark's
// helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENTS_GO_TO_A_SESSION, type ReviewComment } from "../ipc";
import { EMPTY_REVIEWS, commentsOf, mergeComments, useReviewStore } from "../state/review";
import { usePaletteStore } from "../state/palette";
import { useUiStore } from "../state/ui";
import { setLineProvider } from "../review/place";
import { TOUCHED_MARK, TOUCHED_TITLE, commentRow, touchedFor, withTouched } from "../review/model";
import { registerBuiltins } from "./builtins";
import { handleKeydown, type KeyEventLike } from "./keybindings";
import { clearCommands, getCommand, listCommands, runCommand } from "./registry";
import { canCommentOnLine, commentBlockedReason, commentKeyAction, draftKey, handleCommentKey, sendComment, shownFilePath } from "./review";

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  reviewComment: vi.fn(),
}));

const ipc = await import("../ipc");
const reviewComment = vi.mocked(ipc.reviewComment);

function key(k: string, target?: unknown, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: () => {}, target, ...mods };
}

const comment = (id: number, state: ReviewComment["state"], sessionId = "s1"): ReviewComment => ({
  id,
  sessionId,
  path: "src/a.ts",
  line: 12,
  text: "Review comment on src/a.ts:12: rename this",
  state,
  at: "2026-10-25T10:00:00.000Z",
});

const session = { kind: "session", sessionId: "s1" } as const;
const project = { kind: "project", projectId: "p1" } as const;

describe("line comments (Story 8.4)", () => {
  let unprovide: (() => void) | null = null;
  beforeEach(() => {
    clearCommands();
    reviewComment.mockReset();
    useUiStore.setState({ pane: null, selection: null, contextMenu: null, elsewhereOpen: false, notice: null });
    usePaletteStore.setState({ isOpen: false, query: "", selected: 0 });
    useReviewStore.setState({
      requests: EMPTY_REVIEWS,
      target: null,
      requestId: null,
      selected: null,
      mode: "changes",
      commit: null,
      commitList: null,
      order: [],
      comments: [],
      commentBox: null,
      commentDrafts: {},
    });
    registerBuiltins();
  });
  afterEach(() => {
    unprovide?.();
    unprovide = null;
    clearCommands();
  });

  const showing = (target: typeof session | typeof project, selected: string | null) => {
    useReviewStore.setState({ target, selected });
    useUiStore.setState({ pane: "review" });
  };

  it("is offered on a session showing a file, never on a project or a branch", () => {
    expect(getCommand("review.comment")?.keybinding).toBe("c");
    expect(canCommentOnLine()).toBe(false);
    showing(session, null);
    expect(canCommentOnLine()).toBe(false);
    showing(session, "src/a.ts");
    expect(canCommentOnLine()).toBe(true);
    expect(listCommands({ enabledOnly: true, visibleOnly: true }).map((c) => c.title)).toContain("Comment on line");
    showing(project, "src/a.ts");
    expect(canCommentOnLine()).toBe(false);
    expect(runCommand("review.comment")).toBe(false);
    expect(useReviewStore.getState().commentBox).toBeNull();
    // The toolbar button's disabled title.
    expect(commentBlockedReason(project, "src/a.ts")).toBe(COMMENTS_GO_TO_A_SESSION);
    expect(commentBlockedReason({ kind: "branch", projectId: "p1", branch: "feat" }, "a")).toBe(COMMENTS_GO_TO_A_SESSION);
    expect(commentBlockedReason(session, null)).toBe("no file selected");
    expect(commentBlockedReason(session, "a")).toBeNull();
    // A requested path's mark row and the commit list show no file.
    expect(shownFilePath("req:x", "changes", null)).toBeNull();
    expect(shownFilePath("a", "commits", null)).toBeNull();
    expect(shownFilePath("a", "files", null)).toBe("a");
  });

  it("`c` opens the box at the view's line (line 1 without a view); never from a text field", () => {
    showing(session, "src/a.ts");
    expect(handleKeydown(key("c", { tagName: "TEXTAREA" }))).toBe(false);
    expect(useReviewStore.getState().commentBox).toBeNull();
    expect(handleKeydown(key("c"))).toBe(true);
    expect(useReviewStore.getState().commentBox).toEqual({ path: "src/a.ts", line: 1 });
    useReviewStore.getState().closeCommentBox();
    unprovide = setLineProvider(() => 12);
    expect(handleKeydown(key("c", { tagName: "DIV", isContentEditable: false }))).toBe(true);
    expect(useReviewStore.getState().commentBox).toEqual({ path: "src/a.ts", line: 12 });
    // A new target closes the box.
    useReviewStore.getState().openTarget({ kind: "session", sessionId: "s2" }, null);
    expect(useReviewStore.getState().commentBox).toBeNull();
  });

  it("the box's keys: ctrl+Enter sends, Esc cancels, a bare Enter is swallowed", () => {
    const k = (key: string, mods: Partial<KeyEventLike> = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
    expect(commentKeyAction(k("Enter", { ctrlKey: true }))).toBe("send");
    expect(commentKeyAction(k("Escape"))).toBe("cancel");
    expect(commentKeyAction(k("Enter"))).toBe("swallow");
    expect(commentKeyAction(k("Enter", { shiftKey: true }))).toBe("swallow");
    expect(commentKeyAction(k("Enter", { ctrlKey: true, shiftKey: true }))).toBe("swallow");
    expect(commentKeyAction(k("Enter", { ctrlKey: true, altKey: true }))).toBe("swallow");
    expect(commentKeyAction({ ...k("Enter", { ctrlKey: true }), isComposing: true })).toBeNull();
    for (const typed of ["c", "o", "j", "k", "a"]) expect(commentKeyAction(k(typed))).toBeNull();
  });

  it("the box claims its keys before the window's dispatcher: Esc closes the box, not the pane; Enter never reaches the canvas", () => {
    showing(session, "src/a.ts");
    const box = { tagName: "TEXTAREA" };
    // A key event as the dispatcher sees it after the box's handler ran on it.
    const pressed = (k: string, mods: Partial<KeyEventLike> = {}) => {
      const event = { ...key(k, box, mods), defaultPrevented: false };
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
      return event;
    };
    const esc = pressed("Escape");
    expect(handleCommentKey(esc)).toBe("cancel");
    expect(esc.defaultPrevented).toBe(true);
    expect(handleKeydown(esc)).toBe(false);
    expect(useUiStore.getState().pane).toBe("review");
    const enter = pressed("Enter");
    expect(handleCommentKey(enter)).toBe("swallow");
    expect(handleKeydown(enter)).toBe(false);
    const send = pressed("Enter", { ctrlKey: true });
    expect(handleCommentKey(send)).toBe("send");
    expect(handleKeydown(send)).toBe(false);
    // Typed letters stay the text's: neither the box nor the dispatcher claims them.
    const c = pressed("c");
    expect(handleCommentKey(c)).toBeNull();
    expect(c.defaultPrevented).toBe(false);
    expect(handleKeydown(c)).toBe(false);
    expect(useReviewStore.getState().commentBox).toBeNull();
    // Unclaimed, the same Esc from a text field would close the pane.
    expect(handleKeydown(key("Escape", box))).toBe(true);
    expect(useUiStore.getState().pane).toBeNull();
  });

  it("the draft is kept per target while the box moves, cleared once sent, dropped when the pane closes", async () => {
    showing(session, "src/a.ts");
    const store = useReviewStore.getState();
    store.openCommentBox({ path: "src/a.ts", line: 3 });
    store.setCommentDraft(draftKey(session), "half a thought");
    store.openCommentBox({ path: "src/a.ts", line: 9 });
    expect(useReviewStore.getState().commentDrafts[draftKey(session)]).toBe("half a thought");
    reviewComment.mockResolvedValueOnce(comment(1, "queued"));
    await sendComment("half a thought");
    expect(useReviewStore.getState().commentDrafts).toEqual({});
    store.setCommentDraft(draftKey(session), "again");
    useReviewStore.getState().closeTarget();
    expect(useReviewStore.getState().commentDrafts).toEqual({});
  });

  it("the touched marks are a session's, in Changes and Files only", () => {
    const list = { touched: ["src/a.ts"] };
    expect(touchedFor(session, "changes", list)).toEqual(["src/a.ts"]);
    expect(touchedFor(session, "files", list)).toEqual(["src/a.ts"]);
    expect(touchedFor(session, "changes", null)).toEqual([]);
    expect(touchedFor(project, "changes", list)).toEqual([]);
    expect(touchedFor({ kind: "branch", projectId: "p1", branch: "feat" }, "files", list)).toEqual([]);
    expect(touchedFor(session, "base", list)).toEqual([]);
    expect(touchedFor(null, "changes", list)).toEqual([]);
  });

  it("sending asks Rust with the target, file, line and text; the box closes and the comment is listed", async () => {
    showing(session, "src/a.ts");
    useReviewStore.getState().openCommentBox({ path: "src/a.ts", line: 12 });
    reviewComment.mockResolvedValueOnce(comment(1, "queued"));
    await sendComment("rename this");
    expect(reviewComment).toHaveBeenCalledWith(session, "src/a.ts", 12, "rename this");
    expect(useReviewStore.getState().commentBox).toBeNull();
    expect(useReviewStore.getState().comments.map((c) => c.state)).toEqual(["queued"]);
    // A refusal keeps the box open.
    useReviewStore.getState().openCommentBox({ path: "src/a.ts", line: 3 });
    reviewComment.mockRejectedValueOnce(new Error("comment is empty"));
    await expect(sendComment(" ")).rejects.toThrow("comment is empty");
    expect(useReviewStore.getState().commentBox).toEqual({ path: "src/a.ts", line: 3 });
  });

  it("states only move forward, and the list is per session", () => {
    const merged = mergeComments([comment(1, "sent")], [comment(1, "queued"), comment(2, "queued", "s2")]);
    expect(merged.map((c) => [c.id, c.state])).toEqual([
      [1, "sent"],
      [2, "queued"],
    ]);
    expect(mergeComments(merged, [comment(1, "read")]).map((c) => c.state)).toEqual(["read", "queued"]);
    // Dropped is final: a stale `queued` never brings it back.
    const dropped = mergeComments(merged, [comment(2, "dropped", "s2")]);
    expect(dropped.map((c) => c.state)).toEqual(["sent", "dropped"]);
    expect(mergeComments(dropped, [comment(2, "queued", "s2")])).toBe(dropped);
    const same = [comment(1, "read")];
    expect(mergeComments(same, [comment(1, "sent")])).toBe(same);
    expect(commentsOf(merged, "s2").map((c) => c.id)).toEqual([2]);
    // The event's list is the newest word.
    useReviewStore.getState().applyComments([comment(3, "sent")]);
    expect(useReviewStore.getState().comments.map((c) => c.id)).toEqual([3]);
  });

  it("a touched row says so; a comment row shows where and what", () => {
    expect(TOUCHED_MARK).toBe("•");
    expect(withTouched("src/a.ts, modified, +1 −0", true)).toBe(`src/a.ts, modified, +1 −0, ${TOUCHED_TITLE}`);
    expect(TOUCHED_TITLE).toBe("edited by this session");
    expect(withTouched("b.md", false)).toBe("b.md");
    expect(commentRow(comment(1, "queued"))).toEqual({ where: "src/a.ts:12", body: "rename this" });
    expect(commentRow({ path: "a", line: 1, text: "cut" })).toEqual({ where: "a:1", body: "cut" });
  });
});
