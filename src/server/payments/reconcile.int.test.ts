import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { micros } from "@/core/money";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { mockRef } from "@/rails/mock";
import { type MockRails, railFor } from "@/rails/select";
import type { RailAdapter, RailFailureCode, RailLookup } from "@/rails/types";
import { verifyChain } from "@/server/audit/append";
import { queryRows } from "@/server/db/client";
import { idempotency, spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type ReconcileCronDeps, handleReconcileCron } from "@/server/cron/reconcile";
import { handleTool } from "@/server/tools/tool-handler";
import { type GuardedDeps, type GuardedRequest, runGuardedRequest } from "./guarded";
import { type PayDeps, handlePay } from "./pay-handler";
import { type ReconcileDeps, STALE_AFTER_MS, cleanupExpired, listStuckReservations, reconcile } from "./reconcile";
import { FakeClock, MOCK_CONFIG, OPEN_ENVELOPE, type Scene, createScene, eventsOf, expectAuditBeforeSpend, testDeps } from "./test-fixtures";

let database: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  if (database) {
    expect(await expectAuditBeforeSpend(database.db)).toBeGreaterThan(0);
    await database.close();
  }
});

const db = () => database.db;
let n = 0;
const nextKey = () => `rec-${(n += 1)}`;
const quiet = () => {};

function setup(options: { clock?: FakeClock; mocks?: MockRails } = {}) {
  const t = testDeps(db(), options);
  const rec: ReconcileDeps = { db: db(), key: TEST_HEAD_KEY, now: t.clock.now, railFor: t.deps.railFor, log: quiet };
  return { ...t, rec };
}

async function reservationsOf(agentId: string) {
  return db().select().from(spendReservations).where(eq(spendReservations.agentId, agentId));
}

/** Pay with the mock x402 rail failing in `mode`, and return the request so it can be replayed. */
async function payWith(scene: Scene, deps: GuardedDeps, mocks: MockRails, mode: RailFailureCode | null): Promise<GuardedRequest> {
  const req = { agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() };
  mocks.x402.setFailureMode(mode);
  await runGuardedRequest(req, deps);
  mocks.x402.setFailureMode(null);
  return req;
}

/** Every adapter call except lookup() fails the test: the reconciler must never start a payment (RES-8). */
function lookupOnly(lookup: (key: string) => Promise<RailLookup>): RailAdapter {
  const never = async (): Promise<never> => {
    throw new Error("the reconciler called a paying method");
  };
  return { rail: "x402", minimumUnits: 1n, quote: never, execute: never, refund: never, payout: never, checkDestination: never, lookup };
}

describe("RES-6, RES-3, RES-9: resolving unknown outcomes", () => {
  it("RES-6, RES-3, RES-9: a timed-out payment that went through is settled, and replays return the settled result", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock, rec } = setup();
    const req = await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    expect(await runGuardedRequest(req, deps)).toMatchObject({ status: 202, body: { rail_status: "unknown" } });
    const [reservation] = await reservationsOf(scene.agent.id);

    // Not yet stale: the original request might still be running.
    clock.advance(STALE_AFTER_MS - 1);
    expect(await reconcile(rec, { agentId: scene.agent.id })).toMatchObject({ checked: 0 });

    clock.advance(1);
    const callsBefore = mocks.x402.calls;
    expect(await reconcile(rec, { agentId: scene.agent.id })).toEqual({ checked: 1, settled: 1, released: 0, unknown: 0, skipped: 0 });
    expect(mocks.x402.calls).toBe(callsBefore);

    expect((await reservationsOf(scene.agent.id))[0]).toMatchObject({ status: "settled", resolvedAt: clock.now() });
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["decision", "rail_result", "rail_result"]);
    expect(events[2]?.payload).toEqual({
      status: "settled",
      reconciled: true,
      rail: "x402",
      decision_seq: 1,
      reservation_id: reservation!.id,
      rail_ref: mockRef(reservation!.id),
      settled_micros: "1500",
    });
    expect(await runGuardedRequest(req, deps)).toEqual({
      status: 200,
      body: { decision: "allow", reasons: [], event_seq: 1, rail_status: "settled", rail_ref: mockRef(reservation!.id) },
    });
    expect((await verifyChain(db(), scene.workspaceId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  });

  it("RES-4, RES-9: a confirmed failure from lookup releases the reservation, and replays return 502", async () => {
    const capped = { ...OPEN_ENVELOPE, limits: { windowCapsMicros: { hour: micros(1_500n) } } };
    const scene = await createScene(db(), { envelope: capped });
    const { deps, mocks, clock, rec } = setup();
    const req = await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    const [reservation] = await reservationsOf(scene.agent.id);
    clock.advance(STALE_AFTER_MS);

    // While unknown it counts toward the cap.
    const blocked = await runGuardedRequest({ ...req, idempotencyKey: nextKey() }, deps);
    expect(blocked.body.reasons?.map((r) => r.code)).toEqual(["OVER_WINDOW_CAP"]);

    mocks.x402.setLookupResult(reservation!.id, { status: "failed", code: "RAIL_REJECTED" });
    expect(await reconcile(rec, { agentId: scene.agent.id })).toMatchObject({ released: 1 });
    expect((await reservationsOf(scene.agent.id)).find((r) => r.id === reservation!.id)?.status).toBe("released");
    expect((await eventsOf(db(), scene.workspaceId)).at(-1)?.payload).toMatchObject({ status: "failed", reconciled: true, code: "RAIL_REJECTED" });
    expect(await runGuardedRequest(req, deps)).toEqual({
      status: 502,
      body: { decision: "allow", reasons: [], event_seq: 1, rail_status: "failed", error: "RAIL_REJECTED" },
    });
    // Released money stops counting.
    expect((await runGuardedRequest({ ...req, idempotencyKey: nextKey() }, deps)).status).toBe(200);
  });

  it("RES-7: an outcome that is still unknown changes nothing and is tried again on the next run", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock, rec } = setup();
    // The adapter threw, so the mock never recorded anything: lookup says unknown.
    const original = mocks.x402.execute.bind(mocks.x402);
    mocks.x402.execute = async () => {
      throw new Error("socket hang up");
    };
    const req = { agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() };
    await runGuardedRequest(req, deps);
    mocks.x402.execute = original;
    const [reservation] = await reservationsOf(scene.agent.id);
    clock.advance(STALE_AFTER_MS);
    const before = await eventsOf(db(), scene.workspaceId);

    expect(await reconcile(rec, { agentId: scene.agent.id })).toEqual({ checked: 1, settled: 0, released: 0, unknown: 1, skipped: 0 });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
    expect(await eventsOf(db(), scene.workspaceId)).toEqual(before);
    expect(await runGuardedRequest(req, deps)).toMatchObject({ status: 202, body: { rail_status: "unknown" } });

    mocks.x402.setLookupResult(reservation!.id, { status: "settled", ref: "late_ref", settledMicros: micros(1_500n) });
    expect(await reconcile(rec, { agentId: scene.agent.id })).toMatchObject({ settled: 1 });
    expect(await runGuardedRequest(req, deps)).toMatchObject({ status: 200, body: { rail_ref: "late_ref" } });
  });

  it("RES-7, RES-8: no adapter, a throwing lookup, or an unknown rail name leaves the reservation reserved", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = setup();
    await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    clock.advance(STALE_AFTER_MS);
    const base = { db: db(), key: TEST_HEAD_KEY, now: clock.now, log: quiet };
    // Real mode with no real adapter, as in Phase 8 outside the sandbox.
    const realMode: ReconcileDeps["railFor"] = (rail, ws) => railFor(rail, ws, { config: { ...MOCK_CONFIG, mode: "real" }, mocks });
    expect(await reconcile({ ...base, railFor: realMode }, { agentId: scene.agent.id })).toMatchObject({ unknown: 1 });
    const throwing = lookupOnly(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await reconcile({ ...base, railFor: () => throwing }, { agentId: scene.agent.id })).toMatchObject({ unknown: 1 });
    // A rail name the reconciler doesn't know.
    await db().update(spendReservations).set({ rail: "venmo" }).where(eq(spendReservations.agentId, scene.agent.id));
    expect(await reconcile({ ...base, railFor: deps.railFor }, { agentId: scene.agent.id })).toMatchObject({ unknown: 1 });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
  });

  it("RES-8: the reconciler only ever calls lookup(), with the reservation's own rail idempotency key", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = setup();
    await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    await payWith(scene, deps, mocks, "INVALID_RAIL_RESPONSE");
    clock.advance(STALE_AFTER_MS);
    const asked: string[] = [];
    const adapter = lookupOnly(async (key) => {
      asked.push(key);
      return { status: "settled", ref: `ref_${key}`, settledMicros: micros(1_500n) };
    });
    expect(await reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: () => adapter, log: quiet }, { agentId: scene.agent.id })).toMatchObject({ settled: 2 });
    const reservations = await reservationsOf(scene.agent.id);
    expect(asked.sort()).toEqual(reservations.map((r) => r.railIdempotencyKey).sort());
  });

  it("RES-9: a process that died before writing the rail result is filled in, so replays stop getting 409", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock, rec } = setup();
    let calls = 0;
    const dying: GuardedDeps = {
      ...deps,
      db: new Proxy(db(), {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return (fn: never) => {
              calls += 1;
              return calls === 2 ? Promise.reject(new Error("process died")) : target.transaction(fn);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
    const req = { agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() };
    await expect(runGuardedRequest(req, dying)).rejects.toThrow("process died");
    expect(await runGuardedRequest(req, deps)).toEqual({ status: 409, body: { error: "IDEMPOTENCY_IN_PROGRESS" } });
    clock.advance(STALE_AFTER_MS);
    expect(await reconcile(rec, { agentId: scene.agent.id })).toMatchObject({ settled: 1 });
    expect(await runGuardedRequest(req, deps)).toMatchObject({ status: 200, body: { rail_status: "settled" } });
    expect(mocks.x402.calls).toBe(1);
  });

  it("RES-9: a key reused after 24 hours belongs to the new request, so its response is not overwritten", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock, rec } = setup();
    const req = await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    clock.advance(24 * 60 * 60_000 + 1);
    const reused = await runGuardedRequest(req, deps);
    expect(reused.status).toBe(200);
    expect(await reconcile(rec, { agentId: scene.agent.id })).toMatchObject({ settled: 1 });
    expect(await runGuardedRequest(req, deps)).toEqual(reused);
  });

  it("RES-6: a refund reconciled later keeps its payment reference in the rail result", async () => {
    const scene = await createScene(db(), { task: { allowedTools: ["stripe.refund"] } });
    const { deps, mocks, clock, rec } = setup();
    const toolDeps = { openDb: () => ({ db: db(), close: async () => {} }), key: () => TEST_HEAD_KEY, now: clock.now, railFor: deps.railFor };
    mocks.stripe.setFailureMode("RAIL_TIMEOUT");
    const r = await handleTool(
      new Request("https://agentvault.example/api/v1/tool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${scene.apiKey}`, "idempotency-key": nextKey() },
        body: JSON.stringify({ tool: "stripe.refund", session_id: scene.sessionId, args: { vendor: "nimbus-weather", amount_micros: "5000000", payment_ref: "pi_seed_500" } }),
      }),
      toolDeps,
    );
    expect(r.status).toBe(202);
    clock.advance(STALE_AFTER_MS);
    expect(await reconcile(rec, { agentId: scene.agent.id })).toMatchObject({ settled: 1 });
    expect((await eventsOf(db(), scene.workspaceId)).at(-1)?.payload).toMatchObject({ reconciled: true, rail: "stripe", refund_of: "pi_seed_500" });
  });

  it("RES-6: the after-request trigger reconciles only this agent, at most 5 at a time", async () => {
    const scene = await createScene(db());
    const other = await createScene(db(), { workspaceId: scene.workspaceId });
    const { deps, mocks, clock, rec } = setup();
    for (let i = 0; i < 7; i += 1) await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    await payWith(other, deps, mocks, "RAIL_TIMEOUT");
    clock.advance(STALE_AFTER_MS);

    const tasks: (() => Promise<void>)[] = [];
    const pay: PayDeps = {
      openDb: () => ({ db: db(), close: async () => {} }),
      key: () => TEST_HEAD_KEY,
      now: clock.now,
      railFor: deps.railFor,
      afterResponse: (task) => tasks.push(task),
    };
    const response = await handlePay(
      new Request("https://agentvault.example/api/v1/pay", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${scene.apiKey}`, "idempotency-key": nextKey() },
        body: JSON.stringify({ vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", session_id: scene.sessionId }),
      }),
      pay,
    );
    expect(response.status).toBe(200);
    // Nothing is reconciled until the response is out.
    expect((await reservationsOf(scene.agent.id)).filter((r) => r.status === "reserved")).toHaveLength(7);
    expect(tasks).toHaveLength(1);
    await tasks[0]!();
    expect((await reservationsOf(scene.agent.id)).filter((r) => r.status === "reserved")).toHaveLength(2);
    expect((await reservationsOf(other.agent.id))[0]?.status).toBe("reserved");
    await reconcile(rec);
    expect((await reservationsOf(other.agent.id))[0]?.status).toBe("settled");
  }, 30_000);

  it.skipIf(!process.env.DATABASE_URL_TEST)("RES-6: concurrent runs resolve each reservation exactly once (SKIP LOCKED)", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock, rec } = setup();
    for (let i = 0; i < 6; i += 1) await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    clock.advance(STALE_AFTER_MS);
    const runs = await Promise.all(Array.from({ length: 4 }, () => reconcile(rec, { agentId: scene.agent.id })));
    expect(runs.reduce((s, r) => s + r.settled, 0)).toBe(6);
    const reconciled = await queryRows<{ n: number }>(
      db(),
      sql`SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = ${scene.workspaceId} AND type = 'rail_result' AND payload->>'reconciled' = 'true'`,
    );
    expect(reconciled[0]?.n).toBe(6);
  }, 30_000);
});

describe("PXY-13: cleanup and manual review", () => {
  it("PXY-13: idempotency rows older than 24 hours are deleted, newer ones kept", async () => {
    const scene = await createScene(db());
    const { deps, clock } = setup();
    const old = { agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() };
    await runGuardedRequest(old, deps);
    clock.advance(12 * 60 * 60_000);
    const recent = { ...old, idempotencyKey: nextKey() };
    await runGuardedRequest(recent, deps);
    clock.advance(12 * 60 * 60_000 + 1);
    expect((await cleanupExpired({ db: db(), now: clock.now })).idempotency).toBeGreaterThanOrEqual(1);
    const keys = (await db().select().from(idempotency).where(eq(idempotency.agentId, scene.agent.id))).map((r) => r.key);
    expect(keys).toEqual([recent.idempotencyKey]);
  });

  it("RES-7: reservations unknown for over 24 hours are listed, and listing changes nothing", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = setup();
    await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    const [reservation] = await reservationsOf(scene.agent.id);
    clock.advance(24 * 60 * 60_000);
    const stuck = await listStuckReservations({ db: db(), now: clock.now });
    expect(stuck.find((s) => s.id === reservation!.id)).toMatchObject({ agent_id: scene.agent.id, rail: "x402", amount_micros: "1500" });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
  });
});

describe("RES-6: GET /api/cron/reconcile", () => {
  const SECRET = "test-cron-secret-that-is-long-enough-456";
  const cronDeps = (clock: FakeClock, mocks: MockRails): ReconcileCronDeps => ({
    cronSecret: () => SECRET,
    openDb: () => ({ db: db(), close: async () => {} }),
    key: () => TEST_HEAD_KEY,
    now: clock.now,
    railFor: (rail, ws) => railFor(rail, ws, { config: MOCK_CONFIG, mocks }),
  });

  it("RES-6: rejects a missing or wrong secret and resolves nothing", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = setup();
    await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    clock.advance(STALE_AFTER_MS);
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const r = await handleReconcileCron(new Request("https://agentvault.example/api/cron/reconcile", { headers }), cronDeps(clock, mocks));
      expect(r.status).toBe(401);
    }
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
  });

  it("RES-6: with the secret it reconciles and reports a summary", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = setup();
    await payWith(scene, deps, mocks, "RAIL_TIMEOUT");
    clock.advance(STALE_AFTER_MS);
    const r = await handleReconcileCron(
      new Request("https://agentvault.example/api/cron/reconcile", { headers: { authorization: `Bearer ${SECRET}` } }),
      cronDeps(clock, mocks),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ settled: expect.any(Number), cleaned_up: { idempotency: expect.any(Number) } });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("settled");
  });
});

describe("Property 6: no release without confirmed failure", () => {
  const RAIL_MODES: (RailFailureCode | null | "throw")[] = [null, "RAIL_TIMEOUT", "INVALID_RAIL_RESPONSE", "RAIL_REJECTED", "throw"];
  const LOOKUPS: (RailLookup | null)[] = [
    null,
    { status: "unknown" },
    { status: "settled", ref: "looked_up", settledMicros: micros(1_500n) },
    { status: "failed", code: "RAIL_REJECTED" },
  ];
  type Step = { kind: "pay"; mode: (typeof RAIL_MODES)[number] } | { kind: "lookup"; index: number; result: RailLookup | null } | { kind: "reconcile"; advanceMs: number };
  const step: fc.Arbitrary<Step> = fc.oneof(
    { arbitrary: fc.constantFrom(...RAIL_MODES).map((mode) => ({ kind: "pay" as const, mode })), weight: 3 },
    { arbitrary: fc.record({ kind: fc.constant("lookup" as const), index: fc.nat({ max: 9 }), result: fc.constantFrom(...LOOKUPS) }), weight: 2 },
    { arbitrary: fc.constantFrom(0, 60_000, STALE_AFTER_MS).map((advanceMs) => ({ kind: "reconcile" as const, advanceMs })), weight: 2 },
  );

  // Property 6, no release without confirmed failure (RES-4, RES-5, RES-7):
  // for any sequence of rail outcomes and reconciler runs, a reservation is
  // `released` only if a confirmed-failure `rail_result` exists for it, and
  // no reconciler run starts a new payment.
  it(
    "RES-4, RES-5, RES-7, RES-8: any sequence of rail outcomes and reconciler runs releases only on a confirmed failure",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
          const scene = await createScene(db());
          const { deps, mocks, clock, rec } = setup({ clock: new FakeClock() });
          const original = mocks.x402.execute.bind(mocks.x402);
          // What the rail itself said: reservations it rejected outright, and lookups currently reporting failure.
          const confirmedByRail = new Set<string>();
          const failedLookups = new Set<string>();
          for (const s of steps) {
            if (s.kind === "pay") {
              const before = new Set((await reservationsOf(scene.agent.id)).map((r) => r.id));
              mocks.x402.execute = s.mode === "throw" ? async () => Promise.reject(new Error("socket hang up")) : original;
              mocks.x402.setFailureMode(s.mode === "throw" ? null : s.mode);
              await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, deps);
              mocks.x402.setFailureMode(null);
              mocks.x402.execute = original;
              if (s.mode === "RAIL_REJECTED") for (const r of await reservationsOf(scene.agent.id)) if (!before.has(r.id)) confirmedByRail.add(r.id);
            } else if (s.kind === "lookup") {
              const all = await reservationsOf(scene.agent.id);
              const target = all.sort((a, b) => a.id.localeCompare(b.id))[s.index % Math.max(all.length, 1)];
              if (target) {
                mocks.x402.setLookupResult(target.railIdempotencyKey, s.result);
                if (s.result?.status === "failed") failedLookups.add(target.id);
                else failedLookups.delete(target.id);
              }
            } else {
              for (const id of failedLookups) confirmedByRail.add(id);
              clock.advance(s.advanceMs);
              const calls = mocks.x402.calls;
              await reconcile(rec, { agentId: scene.agent.id });
              // RES-8: a reconciler run never reaches execute() or refund().
              expect(mocks.x402.calls).toBe(calls);
            }
          }
          const releasedWithoutProof = await queryRows<{ id: string }>(
            db(),
            sql`SELECT r.id FROM spend_reservations r
                WHERE r.agent_id = ${scene.agent.id} AND r.status = 'released'
                  AND NOT EXISTS (
                    SELECT 1 FROM audit_events e
                    WHERE e.workspace_id = ${scene.workspaceId} AND e.type = 'rail_result'
                      AND e.payload->>'reservation_id' = r.id::text AND e.payload->>'status' = 'failed')`,
          );
          expect(releasedWithoutProof).toEqual([]);
          // The proof must come from the rail, not from the reconciler deciding on its own.
          const released = (await reservationsOf(scene.agent.id)).filter((r) => r.status === "released").map((r) => r.id);
          for (const id of released) expect(confirmedByRail, `released ${id} without the rail confirming a failure`).toContain(id);
          // And the converse: every confirmed failure released its reservation.
          const failedButHeld = await queryRows<{ id: string }>(
            db(),
            sql`SELECT r.id FROM spend_reservations r
                JOIN audit_events e ON e.workspace_id = ${scene.workspaceId} AND e.type = 'rail_result'
                  AND e.payload->>'reservation_id' = r.id::text AND e.payload->>'status' = 'failed'
                WHERE r.agent_id = ${scene.agent.id} AND r.status <> 'released'`,
          );
          expect(failedButHeld).toEqual([]);
        }),
        { numRuns: database.driver === "postgres" ? 10 : 30 },
      );
    },
    600_000,
  );
});
