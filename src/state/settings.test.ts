import { beforeEach, describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../ipc";
import { selectBanners, useSettingsStore } from "./settings";

const snapshot: SettingsSnapshot = {
  path: "C:\\Users\\me\\AppData\\Roaming\\switchboard\\settings.json",
  settings: {
    version: 1,
    claude: { path: "C:\\Users\\me\\.local\\bin\\claude.exe" },
    git: { path: null },
    defaults: { model: null, effort: null, permission_mode: "default" },
    worktrees_root: null,
    external_editor: "code -g {file}:{line}",
    shell: "pwsh",
    theme: "dark",
    poll: { agents_ms: 2000, git_ms: 5000 },
  },
  binaries: {
    claude: {
      name: "claude",
      path: "C:\\Users\\me\\.local\\bin\\claude.exe",
      version: "2.1.301",
      status: "found",
      configured: true,
    },
    git: { name: "git", path: null, version: null, status: "missing", configured: false },
  },
  banners: [{ id: "git.missing", text: "git not found — searched: C:\\bin" }],
};

describe("settings store", () => {
  beforeEach(() => {
    useSettingsStore.setState({ snapshot: null, loadError: null, paneOpen: false });
  });

  it("starts with no snapshot, no load error and the pane closed", () => {
    const s = useSettingsStore.getState();
    expect(s.snapshot).toBeNull();
    expect(s.loadError).toBeNull();
    expect(s.paneOpen).toBe(false);
  });

  it("setLoadError records why loading failed and can clear it", () => {
    useSettingsStore.getState().setLoadError("settings_get failed: boom");
    expect(useSettingsStore.getState().loadError).toBe("settings_get failed: boom");
    useSettingsStore.getState().setLoadError(null);
    expect(useSettingsStore.getState().loadError).toBeNull();
  });

  it("a load error does not touch an existing snapshot", () => {
    useSettingsStore.getState().applySnapshot(snapshot);
    useSettingsStore.getState().setLoadError("later failure");
    expect(useSettingsStore.getState().snapshot).toEqual(snapshot);
  });

  it("applySnapshot stores what Rust sent", () => {
    useSettingsStore.getState().applySnapshot(snapshot);
    expect(useSettingsStore.getState().snapshot).toEqual(snapshot);
  });

  it("applySnapshot replaces an earlier snapshot wholesale", () => {
    useSettingsStore.getState().applySnapshot(snapshot);
    const fixed: SettingsSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, theme: "light" },
      banners: [],
    };
    useSettingsStore.getState().applySnapshot(fixed);
    const s = useSettingsStore.getState().snapshot;
    expect(s?.settings.theme).toBe("light");
    expect(s?.banners).toEqual([]);
  });

  it("applySnapshot(null) clears it", () => {
    useSettingsStore.getState().applySnapshot(snapshot);
    useSettingsStore.getState().applySnapshot(null);
    expect(useSettingsStore.getState().snapshot).toBeNull();
  });

  it("togglePane flips the pane, open/close set it", () => {
    const s = useSettingsStore.getState();
    s.togglePane();
    expect(useSettingsStore.getState().paneOpen).toBe(true);
    s.togglePane();
    expect(useSettingsStore.getState().paneOpen).toBe(false);
    s.openPane();
    s.openPane();
    expect(useSettingsStore.getState().paneOpen).toBe(true);
    s.closePane();
    s.closePane();
    expect(useSettingsStore.getState().paneOpen).toBe(false);
  });

  it("closePane clears a stale action error; openPane and toggle leave it alone", () => {
    useSettingsStore.getState().openPane();
    useSettingsStore.getState().setActionError("reveal failed");
    useSettingsStore.getState().togglePane();
    useSettingsStore.getState().togglePane();
    expect(useSettingsStore.getState().actionError).toBe("reveal failed");
    useSettingsStore.getState().closePane();
    expect(useSettingsStore.getState().actionError).toBeNull();
    expect(useSettingsStore.getState().paneOpen).toBe(false);
  });

  it("pane state survives a new snapshot", () => {
    useSettingsStore.getState().openPane();
    useSettingsStore.getState().applySnapshot(snapshot);
    expect(useSettingsStore.getState().paneOpen).toBe(true);
  });
});

describe("selectBanners", () => {
  beforeEach(() => {
    useSettingsStore.setState({ snapshot: null, loadError: null, paneOpen: false });
  });

  it("is an empty, reference-stable list before any snapshot", () => {
    const a = selectBanners(useSettingsStore.getState());
    const b = selectBanners(useSettingsStore.getState());
    expect(a).toEqual([]);
    expect(a).toBe(b);
  });

  it("returns the snapshot's banners", () => {
    useSettingsStore.getState().applySnapshot(snapshot);
    expect(selectBanners(useSettingsStore.getState())).toEqual(snapshot.banners);
  });

  it("is empty again once a snapshot without banners arrives", () => {
    useSettingsStore.getState().applySnapshot(snapshot);
    useSettingsStore.getState().applySnapshot({ ...snapshot, banners: [] });
    expect(selectBanners(useSettingsStore.getState())).toEqual([]);
  });
});
