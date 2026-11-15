import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps asset URLs relative, so the same build works under
// `greview serve` and on any static host or sub-path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
  server: {
    // During `npm run dev`, forward the API to a running `greview serve --port 4173`.
    proxy: { "/api": "http://127.0.0.1:4173" },
  },
});
