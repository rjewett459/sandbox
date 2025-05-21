// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "./client", // 👈 base directory
  build: {
    outDir: "../dist/client", // 👈 where Render looks
    emptyOutDir: true,
  },
});


