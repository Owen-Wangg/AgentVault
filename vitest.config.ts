import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

/**
 * Integration tests use DATABASE_URL_TEST (testing-standards.md). Read it
 * from .env.local if the shell doesn't set it. Only this one variable is
 * loaded, so tests never see the other secrets in that file.
 */
function testDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const file = fileURLToPath(new URL("./.env.local", import.meta.url));
  if (!existsSync(file)) return undefined;
  return parseEnv(readFileSync(file, "utf8")).DATABASE_URL_TEST || undefined;
}

// Tests whose name contains "@live" hit real testnets or Stripe test mode
// (testing-standards.md). `pnpm test` skips them; `pnpm test:live` runs only them.
export default defineConfig(({ mode }) => {
  const databaseUrlTest = testDatabaseUrl();
  return {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,mjs}", "app/**/*.test.{ts,tsx}"],
      environment: "node",
      testNamePattern: mode === "live" ? /@live/ : /^(?!.*@live)/,
      env: databaseUrlTest ? { DATABASE_URL_TEST: databaseUrlTest } : {},
    },
  };
});
