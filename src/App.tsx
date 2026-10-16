import { useEffect, useState } from "react";
import { appInfo, hasTauriRuntime, onSettingsChanged, settingsGet } from "./ipc";
import { useAppStore } from "./state/app";
import { useSettingsStore } from "./state/settings";
import { Banners } from "./components/Banners";
import { SettingsPane } from "./components/SettingsPane";
import "./components/shell.css";

type Status = "loading" | "ready" | "no-runtime" | "error";

/**
 * The shell: banner strip on top, content area, settings pane on the right when open.
 * `ctrl+,` toggles the pane, Esc closes it. The canvas (Epic 2) replaces the content area.
 */
export default function App() {
  const info = useAppStore((s) => s.appInfo);
  const setAppInfo = useAppStore((s) => s.setAppInfo);
  const paneOpen = useSettingsStore((s) => s.paneOpen);
  const togglePane = useSettingsStore((s) => s.togglePane);
  const closePane = useSettingsStore((s) => s.closePane);
  const applySnapshot = useSettingsStore((s) => s.applySnapshot);
  const setLoadError = useSettingsStore((s) => s.setLoadError);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasTauriRuntime()) {
      setStatus("no-runtime");
      return;
    }
    let cancelled = false;
    appInfo()
      .then((result) => {
        if (cancelled) return;
        setAppInfo(result);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [setAppInfo]);

  // Settings: subscribe first so no change between the initial read and the listener is lost,
  // then read the current snapshot.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onSettingsChanged((snapshot) => {
      if (!cancelled) applySnapshot(snapshot);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
        return settingsGet();
      })
      .then((snapshot) => {
        // A `settings://changed` event may already have delivered something newer than
        // this response; never overwrite it with the older read.
        if (!cancelled && useSettingsStore.getState().snapshot === null) {
          applySnapshot(snapshot);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(`settings load failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applySnapshot, setLoadError]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A held key auto-repeats; toggling on every repeat makes the pane flicker.
      if (event.repeat) return;
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === ",") {
        event.preventDefault();
        togglePane();
      } else if (event.key === "Escape" && useSettingsStore.getState().paneOpen) {
        event.preventDefault();
        closePane();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePane, closePane]);

  return (
    <div className="shell">
      <Banners />
      <div className="shell-body">
        <main className="content">
          <h1 className="content-title">Switchboard</h1>
          {status === "loading" && <p className="muted">connecting…</p>}
          {status === "ready" && info && (
            <p className="muted">
              {info.name} {info.version}
            </p>
          )}
          {status === "no-runtime" && <p className="muted">no Tauri runtime</p>}
          {status === "error" && <p className="muted">app_info failed: {error}</p>}
          <p className="muted">ctrl+, settings</p>
        </main>
        {paneOpen && <SettingsPane />}
      </div>
    </div>
  );
}
