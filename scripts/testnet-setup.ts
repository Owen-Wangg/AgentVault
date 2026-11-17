// `pnpm testnet:setup [--origin <origin>]`: create the public testnet
// workspace (testnet-demo TN-9), or print the existing one. Its vendor's
// x402_url points at <origin>/vendor/api/weather, so <origin> must be the
// deployment that serves the button: APP_ORIGIN by default, which must be
// https, or http://localhost for development. Prints IDs only.
import { parseArgs } from "node:util";
import { createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { createTestnetWorkspace } from "@/server/testnet/workspace";
import { loadLocalEnv } from "./lib/load-env";

function checkedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !local) return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { origin: { type: "string" } }, strict: true });
  loadLocalEnv();
  const origin = checkedOrigin(values.origin ?? env.appOrigin());
  if (!origin) {
    console.error("The origin must be https://<host>, or http://localhost for development, with no path.");
    return 1;
  }
  const database = createDb(env.databaseUrl());
  try {
    const result = await createTestnetWorkspace(database.db, { appOrigin: origin, key: env.auditHeadKey() });
    console.log(result.created ? "Created the public testnet workspace." : "The public testnet workspace already exists; nothing changed.");
    console.log(`Workspace: ${result.workspaceId}`);
    console.log(`Demo agent: ${result.agentId}`);
    console.log(`Vendor x402 URL: ${origin}/vendor/api/weather${result.created ? "" : " (as created; an existing workspace keeps its URL)"}`);
    return 0;
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Creating the testnet workspace failed.");
    process.exit(1);
  },
);
