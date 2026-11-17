import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Traces and screenshots go outside the repo. Written under the project root, they're files the
  // dev server can see change during a test, a suspected trigger of the end-to-end reload loop.
  outputDir: join(tmpdir(), "agentvault-e2e-results"),
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
    // NEXT_DIST_DIR: a build folder of its own (next.config.ts).
    env: { DATABASE_URL: databaseUrl, AUDIT_HEAD_KEY: auditHeadKey, APP_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-e2e" },
    // Piped, so a server-rendering error behind a reload loop shows up in the run's output.
    stdout: "pipe",
    stderr: "pipe",
  },
});
