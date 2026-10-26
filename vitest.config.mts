import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // No test ever scans the real /Applications or reads the real Application Support folder.
    env: {
      WORKBENCH_SCAN_ROOTS: "/nonexistent-workbench-scan-root",
      WORKBENCH_APP_SUPPORT_ROOT: "/nonexistent-workbench-app-support",
    },
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
    },
  },
});
