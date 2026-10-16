import { create } from "zustand";
import type { AppInfo } from "../ipc";

export type AppState = {
  /** Set once `app_info` has answered; `null` until then or when there is no runtime. */
  appInfo: AppInfo | null;
  setAppInfo: (info: AppInfo | null) => void;
};

export const useAppStore = create<AppState>()((set) => ({
  appInfo: null,
  setAppInfo: (info) => set({ appInfo: info }),
}));
