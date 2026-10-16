import { useEffect, useState, type CSSProperties } from "react";
import { appInfo, hasTauriRuntime } from "./ipc";
import { useAppStore } from "./state/app";

type Status = "loading" | "ready" | "no-runtime" | "error";

const styles = {
  root: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
  },
  title: {
    margin: 0,
    fontSize: "1.5rem",
    fontWeight: 500,
    letterSpacing: "0.01em",
  },
  muted: {
    margin: 0,
    color: "var(--fg-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.85rem",
  },
} satisfies Record<string, CSSProperties>;

export default function App() {
  const info = useAppStore((s) => s.appInfo);
  const setAppInfo = useAppStore((s) => s.setAppInfo);
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

  return (
    <main style={styles.root}>
      <h1 style={styles.title}>Switchboard</h1>
      {status === "loading" && <p style={styles.muted}>connecting…</p>}
      {status === "ready" && info && (
        <p style={styles.muted}>
          {info.name} {info.version}
        </p>
      )}
      {status === "no-runtime" && <p style={styles.muted}>no Tauri runtime</p>}
      {status === "error" && <p style={styles.muted}>app_info failed: {error}</p>}
    </main>
  );
}
