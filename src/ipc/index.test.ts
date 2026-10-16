import { afterEach, describe, expect, it, vi } from "vitest";
import { appInfo, hasTauriRuntime, NoTauriRuntimeError } from "./index";

// vitest runs these in a node environment: there is no `window` at all, which
// is the plain-browser-without-Tauri case taken to its extreme.
describe("ipc runtime guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports no runtime when window is absent", () => {
    expect(hasTauriRuntime()).toBe(false);
  });

  it("reports no runtime in a plain browser window", () => {
    vi.stubGlobal("window", {});
    expect(hasTauriRuntime()).toBe(false);
  });

  it("reports a runtime when Tauri has injected its internals", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(hasTauriRuntime()).toBe(true);
  });

  it("rejects commands with NoTauriRuntimeError instead of throwing from Tauri's invoke", async () => {
    vi.stubGlobal("window", {});
    await expect(appInfo()).rejects.toBeInstanceOf(NoTauriRuntimeError);
    await expect(appInfo()).rejects.toThrow('cannot invoke "app_info"');
  });
});
