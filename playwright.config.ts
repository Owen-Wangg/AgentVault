import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (telemetry-dashboard task 7). Run them with
 * `pnpm test:e2e`, which creates the throwaway database and audit key
 * this config passes to the dev server (scripts/e2e.ts).
 */

const origin = process.env.E2E_ORIGIN ?? "http://localhost:3100";
const databaseUrl = process.env.E2E_DATABASE_URL;
const auditHeadKey = process.env.E2E_AUDIT_HEAD_KEY;
if (!databaseUrl || !auditHeadKey) throw new Error("Run end-to-end tests with pnpm test:e2e, which creates their database.");

export default defineConfig({
  testDir: "tests/e2e",
  // The dev server compiles each page on its first visit.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: origin, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev --port ${new URL(origin).port}`,
    // A static route, so readiness doesn't depend on the database.
    url: `${origin}/vendor/docs/integration`,
    timeout: 180_000,
    reuseExistingServer: false,
    // Set in the process, so they win over .env.local, which Next.js also loads.
    env: { DATABASE_URL: databaseUrl, AUDIT_HEAD_KEY: auditHeadKey, APP_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1" },
    stdout: "ignore",
    stderr: "pipe",
  },
});
