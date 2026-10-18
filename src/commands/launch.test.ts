import { describe, expect, it } from "vitest";
import {
  ADD_DIR_MISSING,
  canStart,
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
  startBlockedReason,
  withAddDir,
  withoutAddDir,
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

describe("validation and the request", () => {
  it("needs a name that is not blank and a custom model that is not blank", () => {
    expect(formErrors(form())).toEqual({ name: null, model: null });
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
    });
    expect(launchRequest("p1", "sid", form({ prompt: "  \n " })).prompt).toBeNull();
    expect(launchRequest("p1", "sid", form()).model).toBe("default");
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
