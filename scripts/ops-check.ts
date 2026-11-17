// `pnpm ops:check`: a read-only check that the hosted app can stay up
// until judging ends (Jan 29, 2027). It reports the database size against
// Neon Free's 1 GB and a projection to Jan 29, when the nightly sandbox
// reset last ran, whether the reconciler's idempotency cleanup is running,
// and what's waiting on a person or the reconciler. It runs only SELECTs
// and prints sizes, counts, and timestamps, never row contents. Exits 1
// if anything needs attention.
//
// Neon compute hours, egress, and Vercel usage aren't visible from SQL;
// read them in the Neon and Vercel dashboards (docs/OPERATIONS.md).
import { sql } from "drizzle-orm";
import { createDb, queryRows } from "@/server/db/client";
import { env } from "@/server/env";
import { loadLocalEnv } from "./lib/load-env";
import {
  IDEMPOTENCY_MAX_AGE_MS,
  NEON_FREE_STORAGE_BYTES,
  RESET_MAX_AGE_MS,
  daysUntilJudgingEnds,
  formatMb,
  overStorageWarning,
  projectedBytes,
} from "./lib/ops-limits";

const RECENT_DAYS = 7n;

const iso = (value: Date | string | null): string => (value === null ? "none" : new Date(value).toISOString().replace(".000Z", "Z"));
const ageHours = (value: Date | string, nowMs: number): bigint => BigInt(Math.floor((nowMs - new Date(value).getTime()) / 3_600_000));

async function main() {
  loadLocalEnv();
  const database = createDb(env.databaseUrl());
  const nowMs = Date.now();
  const warnings: string[] = [];
  try {
    const db = database.db;

    const [size] = await queryRows<{ bytes: string }>(db, sql`SELECT pg_database_size(current_database())::text AS bytes`);
    const sizeBytes = BigInt(size?.bytes ?? "0");
    const tables = await queryRows<{ name: string; bytes: string; rows: string }>(
      db,
      sql`SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes, c.reltuples::bigint::text AS rows
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6`,
    );
    const [audit] = await queryRows<{ rows: string; recent: string }>(
      db,
      sql`SELECT count(*)::text AS rows,
                 count(*) FILTER (WHERE created_at > now() - make_interval(days => ${Number(RECENT_DAYS)}))::text AS recent
          FROM audit_events`,
    );
    const auditBytes = BigInt(tables.find((t) => t.name === "audit_events")?.bytes ?? "0");
    const daysLeft = daysUntilJudgingEnds(nowMs);
    const projected = projectedBytes({
      sizeBytes,
      auditBytes,
      auditRows: BigInt(audit?.rows ?? "0"),
      recentRows: BigInt(audit?.recent ?? "0"),
      recentDays: RECENT_DAYS,
      daysLeft,
    });

    console.log("Storage (Neon Free allows 1 GB per project, shared by all its branches)");
    console.log(`  database now      ${formatMb(sizeBytes)} of ${formatMb(NEON_FREE_STORAGE_BYTES)}`);
    for (const t of tables) console.log(`    ${t.name.padEnd(20)} ${formatMb(BigInt(t.bytes)).padStart(10)}  ~${t.rows} rows`);
    console.log(`  audit rows        ${audit?.rows ?? "0"} total, ${audit?.recent ?? "0"} in the last ${RECENT_DAYS} days`);
    console.log(`  estimate, Jan 29  ${formatMb(projected)} (${daysLeft} days left, at the last ${RECENT_DAYS} days' audit growth)`);
    if (overStorageWarning(sizeBytes)) warnings.push("The database is over 80% of Neon Free's 1 GB.");
    else if (overStorageWarning(projected)) warnings.push("At the current growth, the database passes 80% of Neon Free's 1 GB before Jan 29.");

    const sandboxes = await queryRows<{ created_at: string; retired_at: string | null }>(
      db,
      sql`SELECT created_at, retired_at FROM workspaces WHERE is_sandbox ORDER BY created_at DESC LIMIT 5`,
    );
    console.log("\nNightly sandbox reset (cron, daily in the 11:00 UTC hour)");
    for (const s of sandboxes) console.log(`  created ${iso(s.created_at)}  ${s.retired_at ? `retired ${iso(s.retired_at)}` : "current"}`);
    const latest = sandboxes[0];
    if (!latest) warnings.push("There is no sandbox workspace.");
    else if (nowMs - new Date(latest.created_at).getTime() > RESET_MAX_AGE_MS)
      warnings.push(`The current sandbox is ${ageHours(latest.created_at, nowMs)} hours old, so the nightly reset has missed at least one run.`);

    const [idem] = await queryRows<{ oldest: string | null; rows: string }>(db, sql`SELECT min(created_at) AS oldest, count(*)::text AS rows FROM idempotency`);
    console.log("\nReconciler cleanup (cron, daily in the 10:00 UTC hour; deletes idempotency rows past 24 hours)");
    console.log(`  idempotency rows  ${idem?.rows ?? "0"}, oldest ${iso(idem?.oldest ?? null)}`);
    if (idem?.oldest && nowMs - new Date(idem.oldest).getTime() > IDEMPOTENCY_MAX_AGE_MS)
      warnings.push(`The oldest idempotency row is ${ageHours(idem.oldest, nowMs)} hours old, so the reconciler's cleanup isn't running.`);

    const open = await queryRows<{ rail: string; rows: string; oldest: string }>(
      db,
      sql`SELECT rail, count(*)::text AS rows, min(created_at) AS oldest FROM spend_reservations WHERE status = 'reserved' GROUP BY rail ORDER BY rail`,
    );
    const [pending] = await queryRows<{ rows: string; oldest: string | null }>(
      db,
      sql`SELECT count(*)::text AS rows, min(created_at) AS oldest FROM approvals WHERE status = 'pending'`,
    );
    console.log("\nWaiting");
    if (open.length === 0) console.log("  reservations      none open");
    for (const r of open) console.log(`  reservations      ${r.rows} open on ${r.rail}, oldest ${iso(r.oldest)}`);
    console.log(`  approvals         ${pending?.rows ?? "0"} pending, oldest ${iso(pending?.oldest ?? null)} (expiry is applied when they're read)`);

    // testnet-demo TN-10: real payments from the public button, by outcome.
    const testnetRows = await queryRows<{ status: string; total: string; today: string }>(
      db,
      sql`SELECT r.status, count(*)::text AS total,
                 count(*) FILTER (WHERE r.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS today
          FROM spend_reservations r
          JOIN agents a ON a.id = r.agent_id
          JOIN workspaces w ON w.id = a.workspace_id
          WHERE w.public_testnet
          GROUP BY r.status ORDER BY r.status`,
    );
    const [testnetWs] = await queryRows<{ n: string }>(db, sql`SELECT count(*)::text AS n FROM workspaces WHERE public_testnet`);
    console.log("\nPublic testnet payments (Base Sepolia; check the wallet with pnpm x402:status)");
    if (testnetWs?.n === "0") console.log("  no testnet workspace (pnpm testnet:setup creates it)");
    else if (testnetRows.length === 0) console.log("  none yet");
    for (const r of testnetRows) console.log(`  ${r.status.padEnd(9)} ${r.today} today (UTC), ${r.total} in total`);
    const stuckTestnet = testnetRows.find((r) => r.status === "reserved");
    if (stuckTestnet && stuckTestnet.total !== "0") warnings.push(`${stuckTestnet.total} testnet payment(s) still have an unknown outcome; the reconciler should resolve them.`);

    console.log(warnings.length === 0 ? "\nNothing needs attention." : `\nNeeds attention:\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
    if (warnings.length > 0) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The check failed.");
  process.exit(1);
});
