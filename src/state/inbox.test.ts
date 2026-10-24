import { beforeEach, describe, expect, it } from "vitest";
import { unreadBadge, unreadIn, useInboxStore } from "./inbox";

describe("inbox store (Story 7.3)", () => {
  beforeEach(() => useInboxStore.setState({ unread: {}, received: false, loadError: "old" }));

  it("mirrors the counts Rust pushes and clears a load error", () => {
    useInboxStore.getState().applySnapshot({ s1: 2 });
    const state = useInboxStore.getState();
    expect(state.received).toBe(true);
    expect(state.loadError).toBeNull();
    expect(unreadIn(state.unread, "s1")).toBe(2);
    expect(unreadIn(state.unread, "s2")).toBe(0);
    expect(unreadIn(state.unread, "constructor")).toBe(0);
  });

  it("badges a positive count as `N new` and nothing at 0", () => {
    expect(unreadBadge(1)).toBe("1 new");
    expect(unreadBadge(100)).toBe("100 new");
    expect(unreadBadge(0)).toBeNull();
  });
});
