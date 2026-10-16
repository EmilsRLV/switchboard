// The one place the frontend calls into Rust. Every command gets a typed
// wrapper here; nothing else imports `@tauri-apps/api/core` or `/event` directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `ipc::AppInfo` in `src-tauri/src/ipc/mod.rs`. */
export type AppInfo = {
  name: string;
  version: string;
};

/** Mirrors `settings::Settings` (the on-disk `settings.json` schema, version 1). */
export type Settings = {
  version: number;
  claude: { path: string | null };
  git: { path: string | null };
  defaults: {
    model: string | null;
    effort: string | null;
    permission_mode: string | null;
  };
  worktrees_root: string | null;
  external_editor: string | null;
  shell: string | null;
  theme: string;
  poll: { agents_ms: number; git_ms: number };
};

/** Mirrors `settings::BinaryStatus`. */
export type BinaryStatus = "pending" | "found" | "missing" | "configured_missing" | "version_failed";

/** Mirrors `settings::Binary`. */
export type Binary = {
  name: string;
  path: string | null;
  version: string | null;
  status: BinaryStatus;
  /** True when the path came from `settings.json` rather than detection. */
  configured: boolean;
};

/** Mirrors `settings::Banner`: an ambient notice derived from state, gone when the cause is. */
export type Banner = {
  id: string;
  text: string;
};

/** Mirrors `settings::Snapshot`: what `settings_get` returns and `settings://changed` carries. */
export type SettingsSnapshot = {
  /** Absolute path of `settings.json`; `null` when no config dir could be determined. */
  path: string | null;
  settings: Settings;
  binaries: { claude: Binary; git: Binary };
  banners: Banner[];
};

/** Event name Rust emits with a fresh `SettingsSnapshot` on every change. */
export const SETTINGS_CHANGED_EVENT = "settings://changed";

/** Return type of every command, keyed by command name. */
type Commands = {
  app_info: AppInfo;
  settings_get: SettingsSnapshot;
  settings_reveal: void;
  binaries_redetect: SettingsSnapshot;
  app_quit: void;
};

declare global {
  interface Window {
    /** Injected by Tauri into its webview; absent in a plain browser. */
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when the UI is running inside the Tauri webview rather than a plain browser. */
export function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export class NoTauriRuntimeError extends Error {
  constructor(command: string) {
    super(`no Tauri runtime: cannot invoke "${command}"`);
    this.name = "NoTauriRuntimeError";
  }
}

async function call<K extends keyof Commands>(
  command: K,
  args?: Record<string, unknown>,
): Promise<Commands[K]> {
  if (!hasTauriRuntime()) {
    throw new NoTauriRuntimeError(command);
  }
  return invoke<Commands[K]>(command, args);
}

/** `ipc::app_info` -- the Cargo package name and version. */
export function appInfo(): Promise<AppInfo> {
  return call("app_info");
}

/** `ipc::settings_get` -- the current snapshot (path, settings, binaries, banners). */
export function settingsGet(): Promise<SettingsSnapshot> {
  return call("settings_get");
}

/** `ipc::settings_reveal` -- open the config folder with `settings.json` selected. */
export function settingsReveal(): Promise<void> {
  return call("settings_reveal");
}

/** `ipc::binaries_redetect` -- re-run `claude`/`git` detection; resolves with the new snapshot. */
export function binariesRedetect(): Promise<SettingsSnapshot> {
  return call("binaries_redetect");
}

/** `ipc::app_quit` -- exit the app with status 0. Resolves only if the exit did not happen. */
export function appQuit(): Promise<void> {
  return call("app_quit");
}

/**
 * Subscribe to `settings://changed`. Resolves with the unlisten function; without a Tauri
 * runtime it resolves with a no-op so callers need no branch.
 */
export async function onSettingsChanged(
  callback: (snapshot: SettingsSnapshot) => void,
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<SettingsSnapshot>(SETTINGS_CHANGED_EVENT, (event) => callback(event.payload));
}
