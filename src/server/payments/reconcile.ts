import { and, asc, eq, lt, lte, sql } from "drizzle-orm";
import type { Rail } from "@/core/money";
import type { RailLookup } from "@/rails/types";
import { RAIL_TIMEOUT_MS } from "@/rails/types";
import { appendEvent } from "@/server/audit/append";
import { type Db, queryRows } from "@/server/db/client";
import { agents, auditEvents, idempotency, rateLimits, spendReservations, workspaces } from "@/server/db/schema";
import { findTool } from "@/server/tools/registry";
import { type GuardedDeps, allowedResponse, storeResponse } from "./guarded";

/**
 * The reconciler (audit-and-approvals design, "Reservations and rail
 * outcomes", RES-6 to RES-9). It finds reservations still `reserved` 10
 * minutes after creation and asks the rail what happened, using only the
 * adapter's read-only `lookup()` with the reservation's own rail
 * idempotency key (RES-8). It never calls execute() or refund(), so it can
 * never start a payment.
 *
 * - settled: the reservation is settled (RES-3).
 * - failed: proof that no money moved. Only then is it released (RES-4).
 * - unknown, a lookup error, or no adapter: nothing changes, and the next
 *   run tries again (RES-7).
 *
 * The lookup runs outside any transaction. The write then locks the
 * reservation with FOR UPDATE SKIP LOCKED and re-checks that it is still
 * reserved, so two runs can't resolve the same reservation twice.
 */

/** The original request has written its rail_result or died by then: the rail timeout is 30 seconds. */
export const STALE_AFTER_MS = 10 * 60_000;
/** Reservations still unknown after this long are listed by `pnpm reconcile` for manual review. Listing never releases. */
export const REVIEW_AFTER_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const RAILS: ReadonlySet<string> = new Set<Rail>(["stripe", "x402", "mock"]);

export interface ReconcileDeps {
  db: Db;
  key: Uint8Array;
  now: () => Date;
  railFor: GuardedDeps["railFor"];
  lookupTimeoutMs?: number;
  /** Where attempts that changed nothing are reported. Defaults to console.info. */
  log?: (message: string) => void;
}

export interface ReconcileOptions {
  /** Only this agent's reservations (the after-request trigger). */
  agentId?: string;
  limit?: number;
}

export interface ReconcileSummary {
  checked: number;
  settled: number;
  released: number;
  /** Still unknown, or the rail couldn't be asked. Left reserved (RES-7). */
  unknown: number;
  /** Resolved by someone else between the lookup and the write. */
  skipped: number;
}

type Resolved = Extract<RailLookup, { status: "settled" | "failed" }>;

async function lookUp(deps: ReconcileDeps, c: Candidate): Promise<RailLookup> {
  if (!RAILS.has(c.rail)) return { status: "unknown" };
  // railFor sends sandbox reservations to the mock adapter, whatever RAIL_MODE says (RAIL-2).
  const adapter = deps.railFor(c.rail as Rail, { isSandbox: c.isSandbox });
  // reservedAt is the same created_at the original execute() got, so the x402 adapter can rebuild the authorization's deadline.
  return adapter.lookup(c.railIdempotencyKey, { signal: AbortSignal.timeout(deps.lookupTimeoutMs ?? RAIL_TIMEOUT_MS), reservedAt: c.createdAt });
}

interface Candidate {
  id: string;
  createdAt: Date;
  agentId: string;
  workspaceId: string;
  isSandbox: boolean;
  rail: string;
  railIdempotencyKey: string;
}

/** Resolve stale reservations (RES-6). Safe to run concurrently with itself and with live requests. */
export async function reconcile(deps: ReconcileDeps, options: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const log = deps.log ?? ((message: string) => console.info(message));
  const staleBefore = new Date(deps.now().getTime() - STALE_AFTER_MS);
  const filters = [eq(spendReservations.status, "reserved"), lte(spendReservations.createdAt, staleBefore)];
  if (options.agentId) filters.push(eq(spendReservations.agentId, options.agentId));
  const candidates: Candidate[] = await deps.db
    .select({
      id: spendReservations.id,
      createdAt: spendReservations.createdAt,
      agentId: spendReservations.agentId,
      workspaceId: agents.workspaceId,
      isSandbox: workspaces.isSandbox,
      rail: spendReservations.rail,
      railIdempotencyKey: spendReservations.railIdempotencyKey,
    })
    .from(spendReservations)
    .innerJoin(agents, eq(agents.id, spendReservations.agentId))
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(and(...filters))
    .orderBy(asc(spendReservations.createdAt), asc(spendReservations.id))
    .limit(options.limit ?? 100);

  const summary: ReconcileSummary = { checked: 0, settled: 0, released: 0, unknown: 0, skipped: 0 };
  for (const c of candidates) {
    summary.checked += 1;
    let found: RailLookup;
    try {
      found = await lookUp(deps, c);
    } catch (error) {
      // No adapter, a timeout, or a network error proves nothing.
      log(`reconcile: lookup failed for reservation ${c.id} on ${c.rail}: ${error instanceof Error ? error.message : "unknown error"}`);
      summary.unknown += 1;
      continue;
    }
    if (found.status === "unknown") {
      log(`reconcile: reservation ${c.id} on ${c.rail} is still unknown; it stays reserved`);
      summary.unknown += 1;
      continue;
    }
    const applied = await resolve(deps, c, found);
    if (!applied) summary.skipped += 1;
    else if (found.status === "settled") summary.settled += 1;
    else summary.released += 1;
  }
  return summary;
}

/** Record a confirmed outcome in one transaction (RES-6, RES-9). Returns false if the reservation was no longer reserved. */
async function resolve(deps: ReconcileDeps, c: Candidate, found: Resolved): Promise<boolean> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [reservation] = await tx
      .select()
      .from(spendReservations)
      .where(and(eq(spendReservations.id, c.id), eq(spendReservations.status, "reserved")))
      .for("update", { skipLocked: true });
    if (!reservation) return false;

    // The decision event holds the client's idempotency key and, for a refund, the payment reference.
    const [decision] = await tx
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, c.workspaceId), eq(auditEvents.seq, reservation.decisionSeq)));
    const request = (decision?.payload as { request?: { idempotency_key?: unknown; args?: { payment_ref?: unknown } } } | undefined)?.request;
    const clientKey = typeof request?.idempotency_key === "string" ? request.idempotency_key : null;
    const paymentRef = typeof request?.args?.payment_ref === "string" ? request.args.payment_ref : undefined;
    const refundOf = findTool(reservation.tool)?.operation === "refund" ? paymentRef : undefined;

    const outcome = found.status === "settled" ? "settled" : "failed";
    await appendEvent(
      tx,
      {
        workspaceId: c.workspaceId,
        type: "rail_result",
        payload: {
          status: outcome,
          reconciled: true,
          rail: reservation.rail,
          decision_seq: reservation.decisionSeq,
          reservation_id: reservation.id,
          refund_of: refundOf,
          rail_ref: found.status === "settled" ? found.ref || undefined : undefined,
          explorer_url: found.status === "settled" ? found.explorerUrl : undefined,
          settled_micros: found.status === "settled" ? found.settledMicros : undefined,
          code: found.status === "failed" ? found.code : undefined,
        },
      },
      { key: deps.key, now },
    );
    await tx
      .update(spendReservations)
      .set({ status: outcome === "settled" ? "settled" : "released", resolvedAt: now })
      .where(eq(spendReservations.id, reservation.id));

    // RES-9: replays of the original request now return the resolved result. A row created
    // after the reservation belongs to a newer request that reused the key after 24 hours.
    if (clientKey) {
      const [row] = await tx
        .select({ createdAt: idempotency.createdAt })
        .from(idempotency)
        .where(and(eq(idempotency.agentId, reservation.agentId), eq(idempotency.key, clientKey)));
      if (row && row.createdAt.getTime() <= reservation.createdAt.getTime()) {
        const response = allowedResponse(
          reservation.decisionSeq,
          outcome,
          found.status === "settled" ? { ref: found.ref, explorerUrl: found.explorerUrl } : { code: found.code },
        );
        await storeResponse(tx, reservation.agentId, clientKey, response);
      }
    }
    return true;
  });
}

/** Delete idempotency rows past their 24 hours (PXY-13) and old rate-limit windows. These are operational rows, not audit events. */
export async function cleanupExpired(deps: Pick<ReconcileDeps, "db" | "now">): Promise<{ idempotency: number; rateLimits: number }> {
  const cutoff = new Date(deps.now().getTime() - IDEMPOTENCY_TTL_MS);
  const keys = await deps.db.delete(idempotency).where(lt(idempotency.createdAt, cutoff)).returning({ key: idempotency.key });
  const windows = await deps.db.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff)).returning({ key: rateLimits.key });
  return { idempotency: keys.length, rateLimits: windows.length };
}

export interface StuckReservation {
  id: string;
  agent_id: string;
  rail: string;
  amount_micros: string;
  created_at: string;
}

/** Reservations still unknown after 24 hours, for manual review. Read-only. */
export async function listStuckReservations(deps: Pick<ReconcileDeps, "db" | "now">): Promise<StuckReservation[]> {
  const before = new Date(deps.now().getTime() - REVIEW_AFTER_MS).toISOString();
  return queryRows<StuckReservation>(
    deps.db,
    sql`SELECT id, agent_id, rail, amount_micros::text AS amount_micros, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        FROM spend_reservations WHERE status = 'reserved' AND created_at <= ${before}::timestamptz ORDER BY created_at`,
  );
}

/** One full run: resolve, clean up, and list what still needs a human. Used by the cron route and `pnpm reconcile`. */
export async function runReconcileJob(deps: ReconcileDeps): Promise<{ summary: ReconcileSummary; cleanup: { idempotency: number; rateLimits: number }; stuck: StuckReservation[] }> {
  const summary = await reconcile(deps);
  const cleanup = await cleanupExpired(deps);
  const stuck = await listStuckReservations(deps);
  return { summary, cleanup, stuck };
}
