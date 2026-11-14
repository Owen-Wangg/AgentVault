// `pnpm sandbox:reset`: create a new seeded sandbox workspace and retire
// the current one (audit-and-approvals AUD-9). Nothing is deleted.
import { createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { loadLocalEnv } from "./lib/load-env";

async function main() {
  loadLocalEnv();
  const database = createDb(env.databaseUrl());
  try {
    const { workspaceId, retired } = await resetSandbox(database.db);
    console.log(`New sandbox workspace: ${workspaceId}`);
    console.log(retired.length > 0 ? `Retired: ${retired.join(", ")}` : "There was no previous sandbox.");
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Sandbox reset failed.");
  process.exit(1);
});
