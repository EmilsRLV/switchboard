import { describe, expect, it } from "vitest";
import {
  ADD_DIR_MISSING,
  canStart,
  claudeWorktreeFolder,
  editedForm,
  edgeVia,
  chosenModel,
  EFFORT_CHOICES,
  formErrors,
  formFromPrefill,
  launchKeyAction,
  launchKeyTarget,
  launchRequest,
  missingAddDirs,
  MODEL_CHOICES,
  PERMISSION_CHOICES,
  samePath,
  skippedNote,
  startBlockedReason,
  withAddDir,
  withoutAddDir,
  worktreeNameError,
  worktreeSlug,
  type LaunchForm,
  type LaunchKeyEvent,
} from "./launch";

const prefill = { sessionId: "3f2a-id", name: "ide-3f2a", model: "default", effort: "default", permissionMode: "default" };

function form(overrides: Partial<LaunchForm> = {}): LaunchForm {
  return { ...formFromPrefill(prefill), ...overrides };
}

describe("the prefill", () => {
  it("becomes the form: choices kept, add-dirs and prompt empty, background off", () => {
    expect(formFromPrefill({ ...prefill, model: "opus", effort: "high", permissionMode: "plan" })).toEqual({
      name: "ide-3f2a",
      model: "opus",
      customModel: "",
      effort: "high",
      permissionMode: "plan",
      addDirs: [],
      prompt: "",
      background: false,
      useWorktree: false,
      worktreeName: "ide-3f2a",
      worktreeNameEdited: false,
    });
  });

  it("puts a model that is not a named entry in the custom text", () => {
    const f = formFromPrefill({ ...prefill, model: "claude-opus-4-1" });
    expect([f.model, f.customModel]).toEqual(["custom", "claude-opus-4-1"]);
    expect(chosenModel(f)).toBe("claude-opus-4-1");
    expect(formFromPrefill({ ...prefill, model: "  " }).model).toBe("default");
  });

  it("reads an effort or mode the sheet does not offer as default", () => {
    const f = formFromPrefill({ ...prefill, effort: "ultra", permissionMode: "bypassPermissions" });
    expect([f.effort, f.permissionMode]).toEqual(["default", "default"]);
  });

  it("offers the spec's choices and never bypassPermissions", () => {
    expect(MODEL_CHOICES).toEqual(["default", "fable", "opus", "sonnet", "haiku", "custom"]);
    expect(EFFORT_CHOICES).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(PERMISSION_CHOICES).toEqual(["default", "manual", "acceptEdits", "plan", "auto", "dontAsk"]);
    expect(PERMISSION_CHOICES as readonly string[]).not.toContain("bypassPermissions");
  });
});

describe("context edges on the sheet (Story 6.2)", () => {
  const edgeDirs = [
    { path: "B:\\projects\\ui", via: "ui" },
    { path: "/work/ui-feat", via: "feat" },
  ];

  it("prefill the add-dirs with the folders Rust resolved, and the request sends them", () => {
    const f = formFromPrefill({ ...prefill, addDirs: edgeDirs, skipped: [{ label: "old", reason: "no worktree" }] });
    expect(f.addDirs).toEqual(["B:\\projects\\ui", "/work/ui-feat"]);
    expect(launchRequest("ide", "3f2a-id", f).addDirs).toEqual(["B:\\projects\\ui", "/work/ui-feat"]);
    // Removed on the sheet: not sent this time.
    const removed = { ...f, addDirs: withoutAddDir(f.addDirs, 0) };
    expect(launchRequest("ide", "3f2a-id", removed).addDirs).toEqual(["/work/ui-feat"]);
    // A prefill without edges (an older reply) starts empty.
    expect(formFromPrefill(prefill).addDirs).toEqual([]);
  });

  it("mark a prefilled row with its edge's target, not a folder added by hand", () => {
    expect(edgeVia(edgeDirs, "b:\\Projects\\UI\\")).toBe("ui");
    expect(edgeVia(edgeDirs, "/work/ui-feat")).toBe("feat");
    expect(edgeVia(edgeDirs, "/work/other")).toBeNull();
    expect(edgeVia([], "/work/ui-feat")).toBeNull();
  });

  it("name the unusable targets in one line, and never block Start", () => {
    const skipped = [
      { label: "feat", reason: "no worktree" },
      { label: "ui", reason: "folder missing" },
    ];
    expect(skippedNote("not added", skipped)).toBe("not added: feat (no worktree), ui (folder missing)");
    expect(skippedNote("resumed without", [{ label: "feat", reason: "no worktree" }])).toBe("resumed without: feat (no worktree)");
    expect(skippedNote("not added", [])).toBeNull();
    expect(skippedNote("not added", undefined)).toBeNull();
    expect(startBlockedReason(formFromPrefill({ ...prefill, skipped }), [], false)).toBeNull();
  });
});

describe("validation and the request", () => {
  it("needs a name that is not blank and a custom model that is not blank", () => {
    expect(formErrors(form())).toEqual({ name: null, model: null, worktree: null });
    expect(formErrors(form({ name: "   " })).name).toBe("name must not be blank");
    expect(formErrors(form({ name: "-x" })).name).toBe("name must not start with -");
    expect(formErrors(form({ model: "custom", customModel: " " })).model).toBe("custom model must not be blank");
    expect(formErrors(form({ model: "custom", customModel: "--x" })).model).toBe("model must not start with -");
    expect(formErrors(form({ name: "a\nb" })).name).toBe("name must not contain control characters");
    expect(formErrors(form({ name: "a\u001b[31m" })).name).toBe("name must not contain control characters");
    expect(canStart(form(), [])).toBe(true);
    expect(canStart(form({ name: "" }), [])).toBe(false);
  });

  it("blocks Start while a listed add-dir is marked missing, and says why", () => {
    const f = form({ addDirs: ["/work/a", "/work/b"] });
    expect(canStart(f, ["/work/a/"])).toBe(false);
    expect(startBlockedReason(f, ["/work/a/"], false)).toBe("Remove the missing folder to start");
    expect(startBlockedReason(f, ["/work/a", "/work/b"], false)).toBe("Remove the 2 missing folders to start");
    expect(canStart(f, ["/elsewhere"])).toBe(true);
    expect(canStart(form(), ["/work/a"])).toBe(true);
    expect(startBlockedReason(form({ name: "" }), [], false)).toBe("Start needs a valid name: name must not be blank");
    expect(startBlockedReason(form({ model: "custom" }), [], false)).toBe("Start needs a model: custom model must not be blank");
    expect(startBlockedReason(form(), [], true)).toBe("starting…");
    expect(startBlockedReason(form(), [], false)).toBeNull();
  });

  it("builds the request: name trimmed, a blank prompt as null", () => {
    const f = form({ name: " ide-x ", model: "custom", customModel: " my-model ", effort: "high", permissionMode: "plan", addDirs: ["/a"], prompt: "hi\nthere", background: true });
    expect(launchRequest("p1", "sid", f)).toEqual({
      projectId: "p1",
      sessionId: "sid",
      name: "ide-x",
      model: "my-model",
      effort: "high",
      permissionMode: "plan",
      addDirs: ["/a"],
      prompt: "hi\nthere",
      background: true,
      branch: null,
      createWorktree: false,
      worktreeName: null,
    });
    expect(launchRequest("p1", "sid", form({ prompt: "  \n " })).prompt).toBeNull();
    expect(launchRequest("p1", "sid", form()).model).toBe("default");
  });
});

describe("a session on a branch, and --worktree (Story 5.3)", () => {
  it("names the branch on a branch sheet and never sends --worktree there", () => {
    const f = form({ useWorktree: true, worktreeName: "spike" });
    expect(launchRequest("p1", "sid", f, { branch: "feat", createWorktree: false })).toMatchObject({ branch: "feat", createWorktree: false, worktreeName: null });
    expect(launchRequest("p1", "sid", f, { branch: "free", createWorktree: true })).toMatchObject({ branch: "free", createWorktree: true, worktreeName: null });
    // The project's sheet: the trimmed name while the option is on.
    expect(launchRequest("p1", "sid", form({ useWorktree: true, worktreeName: " spike " }))).toMatchObject({ branch: null, createWorktree: false, worktreeName: "spike" });
    expect(launchRequest("p1", "sid", form({ worktreeName: "spike" })).worktreeName).toBeNull();
  });

  it("prefills the worktree name from the session name until it is edited", () => {
    expect(worktreeSlug("ide-3f2a")).toBe("ide-3f2a");
    expect(worktreeSlug("My Feature: Login!")).toBe("my-feature-login");
    expect(worktreeSlug("..a..b--")).toBe("a.b");
    expect(worktreeSlug("  ")).toBe("session");
    expect(worktreeSlug("my.lock")).toBe("my-lock");
    expect(worktreeNameError(worktreeSlug("x.LOCK"))).toBeNull();
    let f = editedForm(form(), { name: "Spike One" });
    expect(f.worktreeName).toBe("spike-one");
    f = editedForm(f, { worktreeName: "mine" });
    expect([f.worktreeName, f.worktreeNameEdited]).toEqual(["mine", true]);
    expect(editedForm(f, { name: "other" }).worktreeName).toBe("mine");
  });

  it("checks the worktree name as git check-ref-format would, only while the option is on", () => {
    expect(worktreeNameError("spike")).toBeNull();
    expect(worktreeNameError("team/spike")).toBeNull();
    // Checked as the branch `worktree-<name>`: a leading `.` is fine there, a later part's is not.
    expect(worktreeNameError(".a")).toBeNull();
    // `< > " |` only when the repo is on Windows.
    for (const c of ["<", ">", '"', "|"]) {
      expect(worktreeNameError(`a${c}b`), c).toBeNull();
      expect(worktreeNameError(`a${c}b`, true), c).not.toBeNull();
    }
    expect(formErrors(form({ useWorktree: true, worktreeName: "a|b" }), "B:\\r\\ide").worktree).not.toBeNull();
    expect(formErrors(form({ useWorktree: true, worktreeName: "a|b" }), "/r/ide").worktree).toBeNull();
    for (const bad of ["", "-x", "a b", "a..b", "a~b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "a//b", "a/", "a.", "a/.b", "a.lock", "a/b.lock"]) {
      expect(worktreeNameError(bad), bad).not.toBeNull();
    }
    expect(formErrors(form({ worktreeName: "a..b" })).worktree).toBeNull();
    expect(formErrors(form({ useWorktree: true, worktreeName: "a..b" })).worktree).not.toBeNull();
    expect(startBlockedReason(form({ useWorktree: true, worktreeName: " " }), [], false)).toBe(
      "Start needs a valid worktree name: worktree name must not be blank",
    );
  });

  it("blocks Start while Rust would not create the branch's worktree", () => {
    const plan = { command: "git worktree add /r/.worktrees/free free", path: "/r/.worktrees/free", error: null };
    expect(startBlockedReason(form(), [], false, plan)).toBeNull();
    expect(canStart(form(), [], { command: null, path: null, error: "folder already exists: /r/.worktrees/free" })).toBe(false);
    expect(startBlockedReason(form(), [], false, { command: null, path: null, error: "x" })).toBe("No worktree would be created: see above");
  });

  it("states Claude's worktree folder in the repo's separator style", () => {
    expect(claudeWorktreeFolder("/r/ide", "spike")).toBe("/r/ide/.claude/worktrees/spike");
    expect(claudeWorktreeFolder("B:\\projects\\ide\\", "a/b")).toBe("B:\\projects\\ide\\.claude\\worktrees\\a\\b");
  });

  it("drops an add-dir equal to the folder the session runs in", () => {
    expect(withAddDir([], "/r/.worktrees/feat/", "/r/.worktrees/feat")).toEqual([]);
    expect(withAddDir([], "/r", "/r/.worktrees/feat")).toEqual(["/r"]);
  });
});

describe("add-dirs", () => {
  it("drop blanks, duplicates and the project's own folder", () => {
    let dirs = withAddDir([], "/work/a", "/p/ide");
    dirs = withAddDir(dirs, "/work/a/", "/p/ide");
    dirs = withAddDir(dirs, "/p/ide", "/p/ide");
    dirs = withAddDir(dirs, "  ", "/p/ide");
    dirs = withAddDir(dirs, "/work/b", "/p/ide");
    expect(dirs).toEqual(["/work/a", "/work/b"]);
    expect(withoutAddDir(dirs, 0)).toEqual(["/work/b"]);
    expect(withAddDir(["C:\\Work\\A"], "c:\\work\\a\\", "B:\\projects\\ide")).toEqual(["C:\\Work\\A"]);
    expect(withAddDir([], "b:\\Projects\\IDE", "B:\\projects\\ide")).toEqual([]);
  });

  it("compare Windows paths without case and Unix paths with it", () => {
    expect(samePath("C:\\x", "c:\\X\\")).toBe(true);
    expect(samePath("/x", "/X")).toBe(false);
    expect(samePath("/", "/")).toBe(true);
    expect(samePath("C:\\", "C:\\")).toBe(true);
  });

  it("find every row Rust named as missing", () => {
    expect(missingAddDirs(`${ADD_DIR_MISSING}/work/gone`, ["/work/a", "/work/gone"])).toEqual(["/work/gone"]);
    expect(missingAddDirs(`${ADD_DIR_MISSING}/work/gone\nC:\\Old\\`, ["/work/a", "/work/gone", "c:\\old"])).toEqual(["/work/gone", "c:\\old"]);
    expect(missingAddDirs(`${ADD_DIR_MISSING}/work/other`, ["/work/a"])).toEqual([]);
    expect(missingAddDirs("claude not found; set claude.path in settings", ["/work/a"])).toEqual([]);
  });
});

describe("the key rule", () => {
  const key = (k: string, mods: Partial<LaunchKeyEvent> = {}): LaunchKeyEvent => ({
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it("tells fields, the prompt and the rest apart", () => {
    expect(launchKeyTarget({ tagName: "INPUT" })).toBe("field");
    expect(launchKeyTarget({ tagName: "INPUT", type: "text" })).toBe("field");
    expect(launchKeyTarget({ tagName: "INPUT", type: "checkbox" })).toBe("other");
    expect(launchKeyTarget({ tagName: "INPUT", type: "Radio" })).toBe("other");
    expect(launchKeyTarget({ tagName: "SELECT" })).toBe("field");
    expect(launchKeyTarget({ tagName: "TEXTAREA" })).toBe("prompt");
    expect(launchKeyTarget({ tagName: "BUTTON" })).toBe("other");
    expect(launchKeyTarget(null)).toBe("other");
  });

  it("starts on Enter in a field, on ctrl+Enter anywhere, and leaves the prompt's Enter a newline", () => {
    expect(launchKeyAction(key("Enter"), "field")).toBe("start");
    expect(launchKeyAction(key("Enter"), "prompt")).toBeNull();
    expect(launchKeyAction(key("Enter"), "other")).toBeNull();
    for (const target of ["field", "prompt", "other"] as const) {
      expect(launchKeyAction(key("Enter", { ctrlKey: true }), target)).toBe("start");
    }
    expect(launchKeyAction(key("Enter", { shiftKey: true }), "field")).toBeNull();
    expect(launchKeyAction(key("Enter", { isComposing: true }), "field")).toBeNull();
    expect(launchKeyAction(key("Enter", { altKey: true }), "field")).toBeNull();
    expect(launchKeyAction(key("a"), "field")).toBeNull();
    expect(launchKeyAction(key("Escape"), "field")).toBeNull();
  });
});
