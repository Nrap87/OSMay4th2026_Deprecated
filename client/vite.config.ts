import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5175",
        changeOrigin: true,
        timeout: 600_000,
      },
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
