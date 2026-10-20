// The launch sheet's pure rules (Story 4.2): the form a prefill becomes, its validation, the
// request it sends, the add-dir list edits, and the key rule (Enter starts from a single-line
// field or select, Enter in the prompt is a newline, ctrl+Enter starts from anywhere). Rust owns
// the launch itself (`claude/launch.rs`): it validates again, assigns the id and builds the argv.

import type { LaunchPrefill, LaunchRequest, WorktreePlanPreview } from "../ipc";

/** The choice that leaves a flag out (`claude`'s own default applies). */
export const DEFAULT_CHOICE = "default";

/** The model select's entry for free text. */
export const CUSTOM_MODEL = "custom";

/** The model select's entries: the named models, then free text. */
export const MODEL_CHOICES = [DEFAULT_CHOICE, "fable", "opus", "sonnet", "haiku", CUSTOM_MODEL] as const;

/** The effort select's entries. */
export const EFFORT_CHOICES = [DEFAULT_CHOICE, "low", "medium", "high", "xhigh", "max"] as const;

/** The permission mode select's entries. `bypassPermissions` is never offered. */
export const PERMISSION_CHOICES = [DEFAULT_CHOICE, "manual", "acceptEdits", "plan", "auto", "dontAsk"] as const;

/** Mirrors `launch::ADD_DIR_MISSING`: the start of Rust's error for add-dirs that are gone (one path per line). */
export const ADD_DIR_MISSING = "add-dir does not exist: ";

/** True when `text` has a control character (a newline, an escape). */
function hasControl(text: string): boolean {
  return Array.from(text).some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/** What the sheet edits. `model` is a select entry; `customModel` its text when `custom`. */
export type LaunchForm = {
  name: string;
  model: string;
  customModel: string;
  effort: string;
  permissionMode: string;
  addDirs: string[];
  prompt: string;
  background: boolean;
  /** Story 5.3, the project's sheet only: "Let Claude make a worktree (`--worktree`)". */
  useWorktree: boolean;
  /** The `--worktree` name: the session name slugged until the operator edits it. */
  worktreeName: string;
  /** True once the operator typed in the worktree name (it then stops following the session name). */
  worktreeNameEdited: boolean;
};

/** The prefix of the branch `claude --worktree <name>` makes (mirrors `launch::CLAUDE_WORKTREE_BRANCH_PREFIX`). */
export const CLAUDE_WORKTREE_BRANCH_PREFIX = "worktree-";

/**
 * `<top>/.claude/worktrees/<name>`: where `claude --worktree <name>` puts its worktree, in the
 * separator style of `top` (mirrors `launch::claude_worktree_path`).
 */
export function claudeWorktreeFolder(top: string, name: string): string {
  const sep = top.includes("\\") ? "\\" : "/";
  const base = top.replace(/[\\/]+$/, "");
  return [base, ".claude", "worktrees", ...name.split("/").filter((p) => p !== "")].join(sep);
}

/**
 * A session name as a `--worktree` name: lower case, every run of characters other than
 * `a-z 0-9 . _ -` one `-`, no `.` / `-` at either end, no `..`; `session` when nothing is left.
 */
export function worktreeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    // git refuses a ref part ending in `.lock`.
    .replace(/\.lock$/, "-lock");
  return slug === "" ? "session" : slug;
}

/** True for a Windows path (a drive letter or a backslash). */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.includes("\\");
}

/**
 * Why a `--worktree` name would be refused, checked as the sheet types; Rust checks it again
 * at Start. The name itself (Rust's rules): not blank, not starting with `-`, no whitespace or
 * control characters, and on Windows (`windows`: the repo path is a Windows path) no `< > " |`.
 * Then the branch Claude makes, `worktree-<name>`, as `git check-ref-format --branch` checks
 * it: no `~ ^ : ? * [ \`, no `..`, `@{`, `//`, no part starting with `.` or ending with
 * `.lock`, not ending with `/` or `.`. `null` when it looks fine.
 */
export function worktreeNameError(raw: string, windows = false): string | null {
  const name = raw.trim();
  if (name === "") return "worktree name must not be blank";
  if (name.startsWith("-")) return "worktree name must not start with -";
  if (hasControl(name) || /\s/.test(name)) return "worktree name must not contain spaces or control characters";
  if (windows && /[<>"|]/.test(name)) return 'worktree name must not contain < > " | on Windows';
  const ref = `${CLAUDE_WORKTREE_BRANCH_PREFIX}${name}`;
  if (/[~^:?*[\\]/.test(ref)) return "worktree name must not contain ~ ^ : ? * [ or \\";
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return "worktree name must not contain .., @{ or //";
  if (ref.endsWith("/") || ref.endsWith(".")) return "worktree name must not end with / or .";
  if (ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) return "no part may start with . or end with .lock";
  return null;
}

/**
 * The form after `patch`: while the operator has not typed in the worktree name, it follows the
 * session name (slugged); typing in it stops that.
 */
export function editedForm(form: LaunchForm, patch: Partial<LaunchForm>): LaunchForm {
  const next = { ...form, ...patch };
  if (patch.worktreeName !== undefined && patch.worktreeNameEdited === undefined) next.worktreeNameEdited = true;
  else if (patch.name !== undefined && !next.worktreeNameEdited) next.worktreeName = worktreeSlug(next.name);
  return next;
}

function offered(value: string, choices: readonly string[]): string {
  return choices.includes(value) ? value : DEFAULT_CHOICE;
}

/**
 * The sheet's first state from Rust's prefill (the project's last choices, else settings, else
 * `default`): a model that is not a named entry is `custom` with its text; an effort or mode
 * not offered reads as `default`. Add-dirs and the prompt start empty, background off.
 */
export function formFromPrefill(prefill: LaunchPrefill): LaunchForm {
  const model = prefill.model.trim() || DEFAULT_CHOICE;
  const named = model !== CUSTOM_MODEL && (MODEL_CHOICES as readonly string[]).includes(model);
  return {
    name: prefill.name,
    model: named ? model : CUSTOM_MODEL,
    customModel: named ? "" : model,
    effort: offered(prefill.effort, EFFORT_CHOICES),
    permissionMode: offered(prefill.permissionMode, PERMISSION_CHOICES),
    addDirs: [],
    prompt: "",
    background: false,
    useWorktree: false,
    worktreeName: worktreeSlug(prefill.name),
    worktreeNameEdited: false,
  };
}

/** The model the form asks for: the named entry, or the custom text (trimmed). */
export function chosenModel(form: LaunchForm): string {
  return form.model === CUSTOM_MODEL ? form.customModel.trim() : form.model;
}

/** Why the form cannot start, per field; `null` when the field is fine. */
export type FormErrors = { name: string | null; model: string | null; worktree: string | null };

/**
 * The name must not be blank (trimmed), start with `-` or hold a control character (Rust's
 * rules); a custom model must not be blank or start with `-`; with `--worktree` on, its name
 * must pass {@link worktreeNameError}.
 */
export function formErrors(form: LaunchForm, repoTop: string | null = null): FormErrors {
  const name = form.name.trim();
  const model = chosenModel(form);
  return {
    name:
      name === ""
        ? "name must not be blank"
        : name.startsWith("-")
          ? "name must not start with -"
          : hasControl(name)
            ? "name must not contain control characters"
            : null,
    model:
      form.model !== CUSTOM_MODEL ? null : model === "" ? "custom model must not be blank" : model.startsWith("-") ? "model must not start with -" : null,
    worktree: form.useWorktree ? worktreeNameError(form.worktreeName, repoTop !== null && isWindowsPath(repoTop)) : null,
  };
}

/** True when Start may run: no field error and no listed add-dir marked missing. */
export function canStart(
  form: LaunchForm,
  missingDirs: readonly string[],
  worktreePlan: WorktreePlanPreview | null = null,
  repoTop: string | null = null,
): boolean {
  return startBlockedReason(form, missingDirs, false, worktreePlan, repoTop) === null;
}

/**
 * Why Start is disabled, shown beside it; `null` when it is not. A branch sheet whose worktree
 * Rust would not create (`worktreePlan.error`, Story 5.3) cannot start either.
 */
export function startBlockedReason(
  form: LaunchForm,
  missingDirs: readonly string[],
  starting: boolean,
  worktreePlan: WorktreePlanPreview | null = null,
  repoTop: string | null = null,
): string | null {
  if (starting) return "starting…";
  const errors = formErrors(form, repoTop);
  if (errors.name !== null) return `Start needs a valid name: ${errors.name}`;
  if (errors.model !== null) return `Start needs a model: ${errors.model}`;
  if (errors.worktree !== null) return `Start needs a valid worktree name: ${errors.worktree}`;
  if (worktreePlan !== null && worktreePlan.error !== null) return "No worktree would be created: see above";
  const missing = form.addDirs.filter((d) => missingDirs.some((m) => samePath(d, m))).length;
  if (missing > 0) return missing === 1 ? "Remove the missing folder to start" : `Remove the ${missing} missing folders to start`;
  return null;
}

/** Where a sheet starts (Story 5.3): the branch card it was opened on, and whether its Start creates the worktree. */
export type LaunchTarget = { branch: string | null; createWorktree: boolean };

const PROJECT_TARGET: LaunchTarget = { branch: null, createWorktree: false };

/**
 * The request the form sends for `projectId`, with the session id the sheet was given
 * (`sessionId`, which its default name was made from): the name trimmed, a blank prompt as
 * `null`. On a branch (`target`) it names the branch (Rust resolves the folder) and never asks
 * for `--worktree`; on the project's sheet `worktreeName` is the trimmed name while the
 * option is on, else `null`.
 */
export function launchRequest(projectId: string, sessionId: string, form: LaunchForm, target: LaunchTarget = PROJECT_TARGET): LaunchRequest {
  const onBranch = target.branch !== null;
  return {
    projectId,
    sessionId,
    name: form.name.trim(),
    model: chosenModel(form),
    effort: form.effort,
    permissionMode: form.permissionMode,
    addDirs: [...form.addDirs],
    prompt: form.prompt.trim() === "" ? null : form.prompt,
    background: form.background,
    branch: target.branch,
    createWorktree: onBranch && target.createWorktree,
    worktreeName: !onBranch && form.useWorktree ? form.worktreeName.trim() : null,
  };
}

/** A path with trailing separators dropped (a root keeps its own). */
function trimSeparators(path: string): string {
  const trimmed = path.trim();
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return stripped === "" || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped;
}

/**
 * Two paths name the same folder: equal after dropping trailing separators, ignoring case for
 * Windows paths (a drive letter or a backslash), which is how Rust compares them there.
 */
export function samePath(a: string, b: string): boolean {
  const x = trimSeparators(a);
  const y = trimSeparators(b);
  const windows = (p: string) => /^[A-Za-z]:/.test(p) || p.includes("\\");
  return windows(x) || windows(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * `dirs` with `path` added at the end, unless it is blank, already listed, or the folder the
 * session runs in (`targetPath`: the project folder, or the branch's worktree, Story 5.3).
 */
export function withAddDir(dirs: readonly string[], path: string, targetPath: string): string[] {
  const trimmed = path.trim();
  if (trimmed === "" || samePath(trimmed, targetPath) || dirs.some((d) => samePath(d, trimmed))) return [...dirs];
  return [...dirs, trimmed];
}

/** `dirs` without the entry at `index`. */
export function withoutAddDir(dirs: readonly string[], index: number): string[] {
  return dirs.filter((_, i) => i !== index);
}

/** The listed add-dirs Rust's error names as missing (all of them); none when the error is about something else. */
export function missingAddDirs(message: string, dirs: readonly string[]): string[] {
  if (!message.startsWith(ADD_DIR_MISSING)) return [];
  const paths = message.slice(ADD_DIR_MISSING.length).split("\n");
  return dirs.filter((d) => paths.some((p) => samePath(d, p)));
}

/** Where a key went in the sheet: a single-line field or select, the prompt, or anything else (a button). */
export type LaunchKeyTarget = "field" | "prompt" | "other";

/** Input types that are not single-line text: Enter on one does not start. */
const NOT_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]);

/** The kind of element a key event's target is, for {@link launchKeyAction}: text inputs and selects are fields. */
export function launchKeyTarget(target: unknown): LaunchKeyTarget {
  if (typeof target !== "object" || target === null) return "other";
  const el = target as { tagName?: unknown; type?: unknown };
  if (el.tagName === "TEXTAREA") return "prompt";
  if (el.tagName === "SELECT") return "field";
  if (el.tagName === "INPUT") return typeof el.type === "string" && NOT_TEXT_INPUTS.has(el.type.toLowerCase()) ? "other" : "field";
  return "other";
}

/** The slice of a key event the rule reads. */
export type LaunchKeyEvent = {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
};

/**
 * What a key does in the sheet: `start` for ctrl+Enter anywhere and for a bare Enter in a
 * single-line field or select; `null` otherwise (Enter in the prompt adds a newline, Enter on a
 * button presses it; Esc is the dispatcher's `pane.close`).
 */
export function launchKeyAction(event: LaunchKeyEvent, target: LaunchKeyTarget): "start" | null {
  if (event.key !== "Enter" || event.isComposing === true || event.altKey || event.metaKey) return null;
  if (event.ctrlKey) return event.shiftKey ? null : "start";
  if (event.shiftKey) return null;
  return target === "field" ? "start" : null;
}
