import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// The app ships three documents: the operator console (index.html), the
// projection surface (display.html) that is loaded into one window per screen,
// and the phone remote (remote.html), which is only ever served over the
// network — never loaded into a window here.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        display: resolve(root, "display.html"),
        remote: resolve(root, "remote.html"),
      },
    },
  },
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
});
