import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAgentVaultMcpServer } from "./tools";

/**
 * The stdio MCP server (mcp-server MCP-6 to MCP-8), for local clients like
 * Kiro and Claude Desktop: `pnpm --silent mcp`. It calls the deployed
 * AgentVault API with the agent key from AGENTVAULT_API_KEY and holds no
 * database credentials.
 *
 * stdout carries the protocol, so this process writes nothing else there:
 * diagnostics go to stderr, and never include the key.
 */

/** https anywhere; http only for this machine, as in local development. */
export const StdioEnvSchema = z.object({
  AGENTVAULT_URL: z
    .url()
    .refine((value) => {
      // Zod runs this even when z.url() has already failed, so a bad URL must not throw here.
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    }, "must be https, or http://localhost")
    .transform((value) => new URL(value).origin),
  AGENTVAULT_API_KEY: z.string().min(1).optional(),
});

export function optionsFromEnv(env: Readonly<Record<string, string | undefined>>): { baseUrl: string; apiKey: string | undefined } {
  const parsed = StdioEnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid AgentVault MCP settings: ${fields}. Set AGENTVAULT_URL (https) and AGENTVAULT_API_KEY.`);
  }
  return { baseUrl: parsed.data.AGENTVAULT_URL, apiKey: parsed.data.AGENTVAULT_API_KEY };
}

async function main(): Promise<void> {
  const options = optionsFromEnv(process.env);
  // A missing key still starts the server, so the client shows each call's authentication error (MCP-7).
  if (!options.apiKey) console.error("AGENTVAULT_API_KEY is not set: every tool call will fail with an authentication error.");
  const server = createAgentVaultMcpServer(options);
  await server.connect(new StdioServerTransport());
  console.error(`AgentVault MCP server running on stdio for ${options.baseUrl}`);
}

// Run only as the entry point, so tests can import optionsFromEnv.
if (process.argv[1] && /stdio\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "AgentVault MCP server failed to start.");
    process.exit(1);
  });
}
