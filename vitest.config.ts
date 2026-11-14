import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests whose name contains "@live" hit real testnets or Stripe test mode
// (testing-standards.md). `pnpm test` skips them; `pnpm test:live` runs only them.
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,mjs}", "app/**/*.test.{ts,tsx}"],
    environment: "node",
    testNamePattern: mode === "live" ? /@live/ : /^(?!.*@live)/,
  },
}));
