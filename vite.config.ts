/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Node's `process` without pulling in @types/node; only `env` is read here.
declare const process: { env: Record<string, string | undefined> };

// Vite options tailored for Tauri development (see https://v2.tauri.app/start/frontend/vite/).
export default defineConfig({
  plugins: [react()],

  // Do not clear the terminal; Rust errors from `tauri dev` share it.
  clearScreen: false,

  // Tauri expects a fixed port and fails if it is taken.
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust sources are rebuilt by cargo, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Expose Tauri's environment variables (platform, arch, debug flag) to the frontend.
  envPrefix: ["VITE_", "TAURI_ENV_*"],

  build: {
    // Target the webview Tauri ships on each platform (WebView2 / webkit2gtk).
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    // Keep debug builds readable: no minification, with source maps.
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
