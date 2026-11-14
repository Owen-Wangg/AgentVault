// `pnpm audit:verify [workspace-id ...]`: verify audit hash chains
// (audit-and-approvals AUD-4, AUD-8). With no IDs, verifies every
// workspace, including retired sandboxes. Exits 1 if any chain fails.
import { desc, inArray } from "drizzle-orm";
import { createDb } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { verifyChain } from "@/server/audit/append";
import { env } from "@/server/env";
import { loadLocalEnv } from "./lib/load-env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  loadLocalEnv();
  const ids = process.argv.slice(2);
  const bad = ids.find((id) => !UUID.test(id));
  if (bad !== undefined) throw new Error(`Not a workspace ID: ${bad.slice(0, 40)}`);
  const key = env.auditHeadKey();
  const database = createDb(env.databaseUrl());
  try {
    const query = database.db
      .select({ id: workspaces.id, name: workspaces.name, isSandbox: workspaces.isSandbox, retiredAt: workspaces.retiredAt })
      .from(workspaces);
    const list = await (ids.length > 0 ? query.where(inArray(workspaces.id, ids)) : query).orderBy(desc(workspaces.createdAt));
    if (ids.length > 0 && list.length !== ids.length) throw new Error("Some workspace IDs were not found");
    let failures = 0;
    for (const ws of list) {
      const result = await verifyChain(database.db, ws.id, { key });
      const kind = ws.isSandbox ? (ws.retiredAt ? "sandbox, retired" : "sandbox, current") : "workspace";
      const status = result.ok ? `OK, ${result.count} events` : `BROKEN at seq ${result.brokenAtSeq} (${result.why})`;
      if (!result.ok) failures += 1;
      console.log(`${ws.id}  ${status}  [${kind}] ${ws.name}  head seq: ${result.headSeq ?? "missing"}`);
    }
    console.log(failures === 0 ? `All ${list.length} chains verified.` : `${failures} of ${list.length} chains failed.`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Verification failed.");
  process.exit(1);
});
