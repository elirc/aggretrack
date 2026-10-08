import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests only — pure domain logic, no database.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
