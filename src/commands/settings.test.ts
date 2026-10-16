import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "../ipc";
import { useSettingsStore } from "../state/settings";
import { hasSettingsPath, redetectBinaries, revealSettingsFile } from "./settings";

vi.mock("../ipc", () => ({
  binariesRedetect: vi.fn(),
  settingsReveal: vi.fn(),
}));

const ipc = await import("../ipc");
const binariesRedetect = vi.mocked(ipc.binariesRedetect);
const settingsReveal = vi.mocked(ipc.settingsReveal);

const snapshot: SettingsSnapshot = {
  path: "/home/me/.config/switchboard/settings.json",
  settings: {
    version: 1,
    claude: { path: null },
    git: { path: null },
    defaults: { model: null, effort: null, permission_mode: "default" },
    worktrees_root: null,
    external_editor: null,
    shell: null,
    theme: "dark",
    poll: { agents_ms: 2000, git_ms: 5000 },
  },
  binaries: {
    claude: { name: "claude", path: "/usr/bin/claude", version: "2.1.301", status: "found", configured: false },
    git: { name: "git", path: "/usr/bin/git", version: "2.47.0", status: "found", configured: false },
  },
  banners: [],
};

describe("settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ snapshot: null, loadError: null, paneOpen: false, actionBusy: false, actionError: null });
  });

  it("hasSettingsPath follows the snapshot", () => {
    expect(hasSettingsPath()).toBe(false);
    useSettingsStore.getState().applySnapshot(snapshot);
    expect(hasSettingsPath()).toBe(true);
    useSettingsStore.getState().applySnapshot({ ...snapshot, path: null });
    expect(hasSettingsPath()).toBe(false);
  });

  it("redetectBinaries applies the snapshot and is busy only while running", async () => {
    let resolve!: (s: SettingsSnapshot) => void;
    binariesRedetect.mockReturnValueOnce(new Promise<SettingsSnapshot>((r) => (resolve = r)));
    const done = redetectBinaries();
    expect(useSettingsStore.getState().actionBusy).toBe(true);
    resolve(snapshot);
    await done;
    expect(useSettingsStore.getState().snapshot).toEqual(snapshot);
    expect(useSettingsStore.getState().actionBusy).toBe(false);
    expect(useSettingsStore.getState().actionError).toBeNull();
    expect(binariesRedetect).toHaveBeenCalledOnce();
  });

  it("redetectBinaries does nothing while an action is busy", async () => {
    useSettingsStore.setState({ actionBusy: true });
    await redetectBinaries();
    expect(binariesRedetect).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().actionBusy).toBe(true);
  });

  it("revealSettingsFile clears a stale error before calling and guards against double runs", async () => {
    useSettingsStore.setState({ actionError: "old failure" });
    let resolve!: () => void;
    settingsReveal.mockReturnValueOnce(new Promise<void>((r) => (resolve = r)));
    const first = revealSettingsFile();
    expect(useSettingsStore.getState().actionError).toBeNull();
    expect(useSettingsStore.getState().actionBusy).toBe(true);
    await revealSettingsFile(); // second run while busy: no second file-manager window
    expect(settingsReveal).toHaveBeenCalledOnce();
    resolve();
    await first;
    expect(useSettingsStore.getState().actionBusy).toBe(false);
  });

  it("a failure lands in actionError and opens the pane so it is seen", async () => {
    settingsReveal.mockRejectedValueOnce(new Error("explorer refused"));
    await revealSettingsFile();
    expect(useSettingsStore.getState().actionError).toBe("explorer refused");
    expect(useSettingsStore.getState().paneOpen).toBe(true);
    expect(useSettingsStore.getState().actionBusy).toBe(false);
  });
});
