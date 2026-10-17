import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeProject } from "../ipc";
import { folderName, importRows, selectedToAdd, useImportStore } from "./import";

const items: ClaudeProject[] = [
  { dir: "B--projects-ide", cwd: "B:\\projects\\ide", exists: true, sessions: 12, on_canvas: true },
  { dir: "B--projects-guild-auth", cwd: "B:\\projects\\guild-auth", exists: true, sessions: 3, on_canvas: false },
  { dir: "C--Users-me-gone", cwd: "C:\\Users\\me\\gone", exists: false, sessions: 1, on_canvas: false },
  { dir: "-home-me-src", cwd: "/home/me/src", exists: true, sessions: 0, on_canvas: false },
];

describe("import store", () => {
  beforeEach(() => {
    useImportStore.getState().reset();
  });

  it("starts empty and idle", () => {
    const s = useImportStore.getState();
    expect(s.items).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.selected).toEqual([]);
    expect(s.adding).toBe(false);
  });

  it("begin marks loading and clears a stale error; setItems ends loading", () => {
    useImportStore.getState().setError("old");
    useImportStore.getState().begin();
    expect(useImportStore.getState().loading).toBe(true);
    expect(useImportStore.getState().error).toBeNull();
    useImportStore.getState().setItems(items);
    expect(useImportStore.getState().loading).toBe(false);
    expect(useImportStore.getState().items).toEqual(items);
  });

  it("setError ends loading and adding", () => {
    useImportStore.getState().begin();
    useImportStore.getState().setAdding(true);
    useImportStore.getState().setError("boom");
    const s = useImportStore.getState();
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
    expect(s.adding).toBe(false);
  });

  it("toggle ticks and unticks a row", () => {
    const s = useImportStore.getState();
    s.toggle("a");
    s.toggle("b");
    expect(useImportStore.getState().selected).toEqual(["a", "b"]);
    s.toggle("a");
    expect(useImportStore.getState().selected).toEqual(["b"]);
  });

  it("reset returns to the initial state", () => {
    const s = useImportStore.getState();
    s.setItems(items);
    s.toggle("x");
    s.setAdding(true);
    s.setError("e");
    s.reset();
    const after = useImportStore.getState();
    expect(after.items).toBeNull();
    expect(after.selected).toEqual([]);
    expect(after.error).toBeNull();
    expect(after.adding).toBe(false);
  });
});

describe("folderName", () => {
  it("is the last component, or the whole root", () => {
    expect(folderName("B:\\projects\\guild-auth")).toBe("guild-auth");
    expect(folderName("B:\\projects\\guild-auth\\")).toBe("guild-auth");
    expect(folderName("/home/me/src")).toBe("src");
    expect(folderName("C:\\")).toBe("C:\\");
    expect(folderName("/")).toBe("/");
  });
});

describe("importRows / selectedToAdd", () => {
  it("lists only existing folders, labelled, marked on canvas as Rust decided", () => {
    const rows = importRows(items);
    expect(rows.map((r) => r.project.dir)).toEqual(["B--projects-ide", "B--projects-guild-auth", "-home-me-src"]);
    expect(rows.map((r) => r.label)).toEqual(["ide", "guild-auth", "src"]);
    expect(rows.map((r) => r.onCanvas)).toEqual([true, false, false]);
    expect(rows[0]?.project.sessions).toBe(12);
  });

  it("selectedToAdd skips rows on the canvas and unknown cwds", () => {
    const rows = importRows(items);
    expect(selectedToAdd(rows, ["B:\\projects\\ide", "B:\\projects\\guild-auth", "/elsewhere"])).toEqual([
      "B:\\projects\\guild-auth",
    ]);
    expect(selectedToAdd(rows, [])).toEqual([]);
  });
});
