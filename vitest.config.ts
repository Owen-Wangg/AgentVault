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

/**
 * `pnpm test:live` also needs the x402 variables (docs/SETUP.md, section
 * 6). They're loaded only in live mode, so `pnpm test` never sees the
 * agent wallet key. Values set in the shell win.
 */
const LIVE_VARIABLES = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "X402_PAY_TO", "X402_NETWORK", "X402_MIN_UNITS", "AGENT_WALLET_PRIVATE_KEY"];
function liveEnv(): Record<string, string> {
  const file = fileURLToPath(new URL("./.env.local", import.meta.url));
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const out: Record<string, string> = {};
  for (const name of LIVE_VARIABLES) {
    const value = process.env[name] || fromFile[name];
    if (value) out[name] = value;
  }
  return out;
}

// Tests whose name contains "@live" hit real testnets or Stripe test mode
// (testing-standards.md). `pnpm test` skips them; `pnpm test:live` runs only them.
export default defineConfig(({ mode }) => {
  const databaseUrlTest = testDatabaseUrl();
  const live = mode === "live" ? liveEnv() : {};
  return {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,mjs}", "app/**/*.test.{ts,tsx}"],
      environment: "node",
      // @x402/next's ESM build imports "next/server" without a file extension, which Node's
      // resolver refuses. Inlining it lets Vite resolve the import, as Next.js's bundler does.
      server: { deps: { inline: ["@x402/next"] } },
      testNamePattern: mode === "live" ? /@live/ : /^(?!.*@live)/,
      env: { ...live, ...(databaseUrlTest ? { DATABASE_URL_TEST: databaseUrlTest } : {}) },
    },
  };
});
