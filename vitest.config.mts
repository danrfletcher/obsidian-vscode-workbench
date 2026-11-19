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
    // Many tests start a real server or a child process. On a busy machine (a load average of 13 was seen) the 5 s and
    // 10 s defaults ran out in unrelated files; a test that is stuck still fails, 30 s later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    // Runs once, before any test file: names the run (WORKBENCH_TEST_RUN, the runner's pid, which is in every temp dir name), writes
    // the run's lease and ends what earlier killed runs left behind. Registered here only, in the one config.
    globalSetup: ["./tests/global-setup.ts"],
    coverage: {
      provider: "v8",
      // skipFull: false lists every file, including those at 100% (the new terminal files are), so per-file coverage is reported
      reporter: [["text", { skipFull: false }]],
      include: ["src/**/*.ts"],
    },
  },
});
