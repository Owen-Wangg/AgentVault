import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Layering rules from .kiro/steering/structure.md.
const ioModules = ["fs", "net", "http", "https", "child_process", "dgram", "dns", "tls", "worker_threads"];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-e2e/**", "node_modules/**", "coverage/**", "next-env.d.ts"]),
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ioModules.flatMap((m) => [
            { name: m, message: "src/core is pure: no I/O modules." },
            { name: `node:${m}`, message: "src/core is pure: no I/O modules." },
          ]),
          patterns: [
            { group: ["@/server", "@/server/*", "**/server/**"], message: "src/core must not import src/server." },
            { group: ["@/rails", "@/rails/*", "**/rails/**"], message: "src/core must not import src/rails." },
            { group: ["**/app/**"], message: "src/core must not import app/." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "src/core is pure: no network. Pass data in." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "src/core is pure: pass time in as an argument.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "src/core is pure: pass time in as an argument.",
        },
      ],
    },
  },
  {
    // UI code reaches the server only through server components and route handlers in app/.
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/server", "@/server/*", "**/server/**"], message: "src/ui must not import src/server. Load data in app/ and pass it in." }] },
      ],
    },
  },
  {
    // Agents reach AgentVault only through its HTTP API, like an external agent (demo-agents AGT-4).
    files: ["src/agents/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/server", "@/server/*", "**/server/**"], message: "src/agents must not import src/server. Use the HTTP API through AgentClient." },
            { group: ["@/rails", "@/rails/*", "**/rails/**"], message: "src/agents must not import src/rails." },
          ],
        },
      ],
    },
  },
  {
    // The stdio MCP server runs on a developer's machine with only an agent key, so it reaches
    // AgentVault through the HTTP API (mcp-server design). Not "**/server/**", which would also
    // match the SDK's own "@modelcontextprotocol/sdk/server/..." paths.
    files: ["src/mcp/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/server", "@/server/*", "../server", "../server/*"], message: "src/mcp must not import src/server. Use the HTTP API through AgentClient." },
            { group: ["@/rails", "@/rails/*", "../rails", "../rails/*"], message: "src/mcp must not import src/rails." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/rails/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/server", "@/server/*", "**/server/**"], message: "src/rails must not import src/server." },
            {
              group: ["@/core/*", "!@/core/money", "!@/core/money/*"],
              message: "src/rails may import only src/core/money from the core.",
            },
          ],
        },
      ],
    },
  },
]);
