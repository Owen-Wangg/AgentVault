// `pnpm db:seed`: create the first seeded sandbox workspace if there is
// none. Safe to run again; it does nothing when a sandbox exists. Use
// `pnpm sandbox:reset` to replace an existing sandbox.
import { createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { ensureSandbox } from "@/server/sandbox/sandbox";
import { loadLocalEnv } from "./lib/load-env";

async function main() {
  loadLocalEnv();
  const database = createDb(env.databaseUrl());
  try {
    const { workspaceId, created } = await ensureSandbox(database.db);
    console.log(created ? `Created sandbox workspace ${workspaceId}.` : `Sandbox workspace ${workspaceId} already exists.`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seeding failed.");
  process.exit(1);
});
