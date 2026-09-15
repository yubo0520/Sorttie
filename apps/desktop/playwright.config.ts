import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "electron.ui.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "line",
  use: {
    trace: "retain-on-failure",
  },
});
