import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    css: true,
  },
});
