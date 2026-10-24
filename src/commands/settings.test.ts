import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "../ipc";
import { useImportStore } from "../state/import";
import { useSettingsStore } from "../state/settings";
import { useUiStore } from "../state/ui";
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
    notifications: { finished: true, waiting: true },
    peers: { nudge: true },
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
    useSettingsStore.setState({ snapshot: null, loadError: null, actionBusy: false, actionError: null });
    useUiStore.setState({ pane: null, flashed: [] });
    useImportStore.getState().reset();
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
    expect(useUiStore.getState().pane).toBe("settings");
  });

  it("a failure with the import pane open switches to settings and resets the import store", async () => {
    useUiStore.getState().openPane("import");
    useImportStore.getState().setItems([{ dir: "X--one", cwd: "/x/one", exists: true, sessions: 1, on_canvas: false }]);
    useImportStore.getState().toggle("/x/one");
    settingsReveal.mockRejectedValueOnce(new Error("explorer refused"));
    await revealSettingsFile();
    expect(useUiStore.getState().pane).toBe("settings");
    expect(useImportStore.getState().items).toBeNull();
    expect(useImportStore.getState().selected).toEqual([]);
    expect(useSettingsStore.getState().actionBusy).toBe(false);
  });
});
