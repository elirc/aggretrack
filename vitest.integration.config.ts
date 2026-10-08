import { defineConfig } from "vitest/config";
import path from "node:path";

// Integration tests — real PostgreSQL. DB name comes from TEST_DB_NAME
// (default aggretrack_test). Suites share one database per run, so files
// must not interleave: fileParallelism is off.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
