import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
  ],

  // Required for Tauri: assets must be referenced with relative paths,
  // not absolute paths from "/", because Tauri serves via tauri:// protocol.
  base: "./",

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,          // prevent Vite from obscuring rust errors
  server: {
    port: 1420,
    strictPort: true,          // tauri expects a fixed port, fail if not available
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"], // tell Vite to ignore watching src-tauri
    },
  },
}));
