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
 * `pnpm test:live` also needs the x402, Stripe, and Gemini variables
 * (docs/SETUP.md, sections 6 to 8). They're loaded only in live mode, so
 * `pnpm test` never sees the agent wallet key, the Stripe key, or the
 * Gemini key. Values set in the shell win.
 */
const LIVE_VARIABLES = [
  // The live Gemini agent (docs/SETUP.md, section 8). Each live run uses a few of the free tier's daily requests.
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "X402_PAY_TO",
  "X402_NETWORK",
  "X402_MIN_UNITS",
  "AGENT_WALLET_PRIVATE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PROFILE_ID",
  // The PayPal sandbox (docs/SETUP.md, section 9), for the guarded PayPal payout.
  "PAYPAL_ENV",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_SUPPLIER_RECEIVER",
  "PAYPAL_ATTACKER_RECEIVER",
];
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
// `--mode pglite` (`pnpm verify:local`) runs every integration test on in-memory PGlite, even
// with DATABASE_URL_TEST set, so a routine run doesn't spend the Neon project's free compute
// hours (docs/OPERATIONS.md). The tests that need real concurrent connections skip.
export default defineConfig(({ mode }) => {
  const databaseUrlTest = mode === "pglite" ? "" : testDatabaseUrl();
  const live = mode === "live" ? liveEnv() : {};
  return {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,mjs}", "app/**/*.test.{ts,tsx}"],
      environment: "node",
      // Each property test runs 1,000 generated cases. Alone they finish in a few seconds, but with
      // every test file running at once they can pass Vitest's 5 s default. This only raises the
      // ceiling for a hung test; it doesn't change what any test checks.
      testTimeout: 30_000,
      // @x402/next's ESM build imports "next/server" without a file extension, which Node's
      // resolver refuses. Inlining it lets Vite resolve the import, as Next.js's bundler does.
      server: { deps: { inline: ["@x402/next"] } },
      testNamePattern: mode === "live" ? /@live/ : /^(?!.*@live)/,
      // An empty value overrides one set in the shell; every reader treats it as unset.
      env: { ...live, ...(databaseUrlTest !== undefined ? { DATABASE_URL_TEST: databaseUrlTest } : {}) },
    },
  };
});
