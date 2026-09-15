import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/preload/preload.ts",
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    outDir: "dist-electron/preload",
    rollupOptions: {
      external: ["electron"],
    },
  },
});
