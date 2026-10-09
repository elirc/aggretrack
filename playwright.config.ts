import { defineConfig, devices } from "@playwright/test";

// E2E runs against a dev server bound to the dedicated aggretrack_e2e
// database, seeded beforehand (pnpm seed with DATABASE_URL pointed at it).
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/aggretrack_e2e";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4137",
    trace: "retain-on-failure",
    viewport: { width: 360, height: 740 }, // mobile-first per spec
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 740 } } }],
  webServer: {
    command: "pnpm start --port 4137",
    url: "http://localhost:4137/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      APP_ENV: "development",
      SMS_DRIVER: "mock",
      EMAIL_DRIVER: "mock",
      PAYMENTS_DRIVER: "mock",
      STORAGE_DRIVER: "local",
      BETTER_AUTH_SECRET: "e2e-secret",
      BETTER_AUTH_URL: "http://localhost:4137",
      NEXT_PUBLIC_APP_URL: "http://localhost:4137",
    },
  },
});
