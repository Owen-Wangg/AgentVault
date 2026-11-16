// `pnpm mcp:agent [--preset billing|weather] [--name <agent name>]`: create
// an agent, task, and session in the current public sandbox for an MCP
// client, and print the API key and session ID once (docs/MCP.md). The
// sandbox always uses mock rails, and the nightly reset revokes the key.
//
// It prints the key to this terminal only, because that is the point of
// the script. Paste it into your MCP client's local config, never into
// the repo.
import { parseArgs } from "node:util";
import { createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { MCP_PRESETS, createMcpAgent, isMcpPreset } from "@/server/mcp/provision";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { loadLocalEnv } from "./lib/load-env";

const NAME = /^[A-Za-z0-9._:-]{1,100}$/;

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { preset: { type: "string", default: "billing" }, name: { type: "string" } }, strict: true });
  const preset = values.preset;
  if (!isMcpPreset(preset)) {
    console.error(`Unknown preset. Use one of: ${Object.keys(MCP_PRESETS).join(", ")}.`);
    return 1;
  }
  const name = values.name ?? `mcp-${preset}-agent`;
  if (!NAME.test(name)) {
    console.error("Use letters, digits, and . _ : - for the name (at most 100 characters).");
    return 1;
  }

  loadLocalEnv();
  const database = createDb(env.databaseUrl());
  try {
    const sandbox = await currentSandbox(database.db);
    if (!sandbox) {
      console.error("There's no sandbox yet. Run pnpm db:seed first.");
      return 1;
    }
    const now = new Date();
    const agent = await createMcpAgent(database.db, { workspaceId: sandbox.id, name, preset, actor: "cli" }, { key: env.auditHeadKey(), now });
    const scope = MCP_PRESETS[preset].task;
    console.log(`Created ${name} in the sandbox (audit event ${agent.eventSeq}).`);
    console.log(`Task: ${scope.description}. Tools: ${scope.allowedTools.join(", ")}. Vendor categories: ${scope.allowedVendorCategories.join(", ")}.`);
    console.log("");
    console.log(`AGENTVAULT_URL=${env.appOrigin()}`);
    console.log(`AGENTVAULT_API_KEY=${agent.apiKey}`);
    console.log(`Session ID: ${agent.sessionId}`);
    console.log("");
    console.log("The key is shown once and isn't stored. Put it in your MCP client's local config, never in the repo.");
    return 0;
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Creating the MCP agent failed.");
    process.exit(1);
  },
);
