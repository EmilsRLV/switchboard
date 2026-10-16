// The one place the frontend calls into Rust. Every command gets a typed
// wrapper here; nothing else imports `@tauri-apps/api/core` directly.

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `ipc::AppInfo` in `src-tauri/src/ipc/mod.rs`. */
export type AppInfo = {
  name: string;
  version: string;
};

/** Return type of every command, keyed by command name. */
type Commands = {
  app_info: AppInfo;
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
