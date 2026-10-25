import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../ipc";
import {
  FILTERS,
  buildTree,
  countsText,
  fileOrder,
  filterLabel,
  languageFor,
  orderForRequest,
  otherLayout,
  pickSelected,
  rowLabel,
  statusMark,
  stepPath,
  totals,
} from "./model";

function file(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return { path, oldPath: null, status: "modified", added: 1, removed: 0, binary: false, submodule: false, unreadableName: false, tooLarge: false, onDisk: false, ...over };
}

describe("the changed-files tree", () => {
  it("lists folders before files, each by name, and folds a chain of single folders into one row", () => {
    const rows = buildTree([file("src/b.ts"), file("README.md"), file("src/a.ts"), file("src/auth/deep/x.ts"), file("docs/guide/intro.md")]);
    expect(rows.map((r) => [r.kind, r.name, r.depth])).toEqual([
      ["dir", "docs/guide", 0],
      ["file", "intro.md", 1],
      ["dir", "src", 0],
      ["dir", "auth/deep", 1],
      ["file", "x.ts", 2],
      ["file", "a.ts", 1],
      ["file", "b.ts", 1],
      ["file", "README.md", 0],
    ]);
    expect(buildTree([])).toEqual([]);
  });

  it("shows plain marks and counts, and totals over the files", () => {
    expect(statusMark("renamed")).toEqual({ mark: "R", word: "renamed" });
    expect(statusMark("untracked").word).toBe("untracked");
    expect(countsText(file("a", { added: 3, removed: 12 }))).toBe("+3 −12");
    expect(countsText(file("a.png", { binary: true, added: 0 }))).toBe("binary file");
    expect(countsText(file("sub", { submodule: true }))).toBe("submodule");
    expect(countsText(file("x", { unreadableName: true }))).toBe("unreadable name");
    expect(countsText(file("huge.log", { status: "untracked", tooLarge: true }))).toBe("too large");
    // The status word is in each row's accessible name.
    expect(rowLabel(file("src/a.ts", { added: 3, removed: 1 }), "a.ts")).toBe("a.ts, modified, +3 \u22121");
    expect(rowLabel(file("b.ts", { status: "renamed", oldPath: "a.ts" }), "b.ts")).toBe("b.ts, renamed, renamed from a.ts, +1 \u22120");
    expect(rowLabel(file("a.txt", { status: "deleted", onDisk: true, added: 0 }), "a.txt")).toContain("deleted from index, still on disk");
    expect(totals([file("a", { added: 2, removed: 1 }), file("b", { added: 5 })])).toEqual({ files: 2, added: 7, removed: 1 });
  });
});

describe("the filter and the layout", () => {
  it("is All, Staged, Unstaged in that order, All first (the default)", () => {
    expect(FILTERS.map((f) => f.id)).toEqual(["all", "staged", "unstaged"]);
    expect(filterLabel("unstaged")).toBe("Unstaged");
    expect(otherLayout("split")).toBe("unified");
    expect(otherLayout("unified")).toBe("split");
  });
});

describe("languageFor", () => {
  it("picks a pack by extension, case-insensitively; anything else is plain text", () => {
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("a/b.TS")).toBe("typescript");
    expect(languageFor("x.jsx")).toBe("jsx");
    expect(languageFor("x.mjs")).toBe("javascript");
    expect(languageFor("src-tauri/src/lib.rs")).toBe("rust");
    expect(languageFor("tool.py")).toBe("python");
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("shell.css")).toBe("css");
    expect(languageFor("index.html")).toBe("html");
    expect(languageFor("docs/DESIGN.md")).toBe("markdown");
    expect(languageFor(".github/workflows/ci.yml")).toBe("yaml");
    expect(languageFor("Makefile")).toBeNull();
    expect(languageFor(".gitignore")).toBeNull();
    expect(languageFor("notes.txt")).toBeNull();
    expect(languageFor("weird.constructor")).toBeNull();
  });
});

describe("a review request's paths", () => {
  const files = [file("src/a.ts"), file("src/auth/x.ts"), file("src/auth/y.ts"), file("README.md"), file("new.ts", { status: "renamed", oldPath: "old.ts" })];

  it("come first, in the request's order, and the rest of the files go to the tree", () => {
    // Rust keys each path to the folder: `./src/auth`, an absolute path inside it, `src\\auth` all
    // arrive as `src/auth`; an add-dir's path outside it has no key.
    const key = (display: string, k: string | null, missing = false) => ({ display, key: k, missing, outside: k === null });
    const { requested, rest } = orderForRequest(files, [
      key("./src/auth", "src/auth"),
      key("/w/api/README.md", "README.md"),
      key("src/gone.ts", "src/gone.ts", true),
      key("src/same.ts", "src/same.ts"),
      key("old.ts", "old.ts", true),
      key("/w/docs/x.md", null),
    ]);
    expect(requested.map((r) => [r.display, r.files.map((f) => f.path), r.mark])).toEqual([
      ["./src/auth", ["src/auth/x.ts", "src/auth/y.ts"], null],
      ["/w/api/README.md", ["README.md"], null],
      ["src/gone.ts", [], "missing"],
      ["src/same.ts", [], "unchanged"],
      ["old.ts", ["new.ts"], null],
      ["/w/docs/x.md", [], "outside this folder"],
    ]);
    expect(rest.map((f) => f.path)).toEqual(["src/a.ts"]);
    // Every requested row is selected in turn (the marked ones too), before the tree's.
    const order = fileOrder(requested, buildTree(rest));
    expect(order).toEqual([
      "src/auth/x.ts",
      "src/auth/y.ts",
      "README.md",
      "req:src/gone.ts",
      "req:src/same.ts",
      "new.ts",
      "req:/w/docs/x.md",
      "src/a.ts",
    ]);
    expect(stepPath(order, "README.md", 1)).toBe("req:src/gone.ts");
    expect(pickSelected(null, order)).toBe("src/auth/x.ts");
    // The folder itself names every file.
    expect(orderForRequest(files, [key(".", "")]).requested[0]!.files).toHaveLength(files.length);
  });

  it("without a request every file is in the tree", () => {
    const { requested, rest } = orderForRequest(files, []);
    expect(requested).toEqual([]);
    expect(rest).toHaveLength(files.length);
  });
});

describe("stepping and the selection after a read", () => {
  it("steps through the order, clamped, and keeps a selection still listed", () => {
    const order = ["a", "b", "c"];
    expect(stepPath(order, "a", 1)).toBe("b");
    expect(stepPath(order, "c", 1)).toBe("c");
    expect(stepPath(order, "a", -1)).toBe("a");
    expect(stepPath(order, "zzz", 1)).toBe("a");
    expect(stepPath([], "a", 1)).toBeNull();
    expect(pickSelected("b", order)).toBe("b");
    expect(pickSelected("gone", order)).toBe("a");
    expect(pickSelected("gone", [])).toBeNull();
  });
});
