// `pnpm reconcile`: resolve reservations still reserved 10 minutes after
// creation, using the rails' read-only lookup() (audit-and-approvals
// RES-6 to RES-9), clean up idempotency rows past 24 hours, and list
// reservations still unknown after 24 hours for manual review. It never
// starts a payment and never releases anything without a confirmed failure.
import { loadRailConfig } from "@/rails/config";
import { railFor } from "@/rails/select";
import { createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { runReconcileJob } from "@/server/payments/reconcile";
import { loadLocalEnv } from "./lib/load-env";

async function main() {
  loadLocalEnv();
  const database = createDb(env.databaseUrl());
  try {
    const config = loadRailConfig();
    const { summary, cleanup, stuck } = await runReconcileJob({
      db: database.db,
      key: env.auditHeadKey(),
      now: () => new Date(),
      railFor: (rail, workspace) => railFor(rail, workspace, { config }),
    });
    console.log(
      `Checked ${summary.checked}: ${summary.settled} settled, ${summary.released} released, ${summary.unknown} still unknown, ${summary.skipped} already resolved.`,
    );
    console.log(`Deleted ${cleanup.idempotency} expired idempotency rows and ${cleanup.rateLimits} old rate-limit windows.`);
    if (stuck.length === 0) {
      console.log("No reservation has been unknown for over 24 hours.");
    } else {
      console.log(`${stuck.length} reservation(s) unknown for over 24 hours. Check them on the rail by hand:`);
      for (const r of stuck) console.log(`  ${r.id}  agent ${r.agent_id}  ${r.rail}  ${r.amount_micros} micros  since ${r.created_at}`);
    }
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Reconcile failed.");
  process.exit(1);
});