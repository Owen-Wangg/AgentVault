import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { mockRef } from "@/rails/mock";
import { RailUnavailableError } from "@/rails/select";
import { verifyChain } from "@/server/audit/append";
import { type Database, queryRows } from "@/server/db/client";
import { agents, approvals, idempotency, spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type GuardedDeps, requestHash, runGuardedRequest } from "./guarded";
import { FakeClock, createScene, eventsOf, expectAuditBeforeSpend, testDeps } from "./test-fixtures";

let database: Database;

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
let keyCounter = 0;
const key = () => `key-${(keyCounter += 1)}`;

async function reservationsOf(agentId: string) {
  return db().select().from(spendReservations).where(eq(spendReservations.agentId, agentId));
}

describe("PXY-4, PXY-5, PXY-6: the allow path", () => {
  it("PXY-5: an allowed payment is audited, reserved, paid, and settled, in that order", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db());
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: "k1", body: scene.body() }, deps);

    const [reservation] = await reservationsOf(scene.agent.id);
    expect(response).toEqual({
      status: 200,
      body: { decision: "allow", reasons: [], rail_status: "settled", rail_ref: mockRef(reservation!.id), event_seq: 1 },
    });
    expect(reservation).toMatchObject({ status: "settled", amountMicros: micros(1_500n), rail: "x402", decisionSeq: 1 });
    expect(reservation!.railIdempotencyKey).toBe(reservation!.id);
    expect(mocks.x402.calls).toBe(1);

    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["decision", "rail_result"]);
    expect(events[1]?.payload).toMatchObject({ status: "settled", rail: "x402", decision_seq: 1, settled_micros: "1500" });
    expect((await verifyChain(db(), scene.workspaceId, { key: deps.key })).ok).toBe(true);
  });

  it("MON-10: an mpp.pay amount is counted after rounding up to Stripe cents", async () => {
    const scene = await createScene(db());
    const { deps } = testDeps(db());
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ tool: "mpp.pay", amountMicros: fromDecimalString("0.501") }) }, deps);
    const [reservation] = await reservationsOf(scene.agent.id);
    expect(reservation?.amountMicros).toBe(micros(510_000n));
  });

  it("AUD-5: the decision event holds the request without any secret", async () => {
    const scene = await createScene(db());
    const { deps } = testDeps(db());
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    const [decision] = await eventsOf(db(), scene.workspaceId);
    expect(decision?.payload).toMatchObject({
      agent_id: scene.agent.id,
      decision: "allow",
      request: { vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", counted_micros: "1500", session_id: scene.sessionId },
    });
    expect(JSON.stringify(decision?.payload)).not.toContain(scene.apiKey);
    expect(JSON.stringify(decision?.payload)).not.toContain("av_test_");
  });
});

describe("deny and hold", () => {
  it("ENV-1: a denied request returns 403 with its reasons and never reaches the rail", async () => {
    const scene = await createScene(db(), {
      envelope: { limits: { txMaxMicros: fromDecimalString("1") }, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
    });
    const { deps, mocks } = testDeps(db());
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ amountMicros: fromDecimalString("2") }) }, deps);
    expect(response).toEqual({
      status: 403,
      body: { decision: "deny", reasons: [{ code: "OVER_TX_MAX", detail: { level: "agent", limitMicros: "1000000" } }], event_seq: 1 },
    });
    expect(mocks.x402.calls).toBe(0);
    expect(await reservationsOf(scene.agent.id)).toEqual([]);
    expect((await eventsOf(db(), scene.workspaceId)).map((e) => e.type)).toEqual(["decision"]);
  });

  it("HITL-1: a held request creates a pending approval with the request, reasons, and a 15-minute expiry", async () => {
    const scene = await createScene(db(), {
      envelope: { limits: { approvalThresholdMicros: fromDecimalString("100") }, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
    });
    const { deps, mocks, clock } = testDeps(db());
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ amountMicros: fromDecimalString("480") }) }, deps);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ decision: "hold", reasons: [{ code: "NEEDS_APPROVAL" }], event_seq: 1 });
    const [approval] = await db().select().from(approvals).where(eq(approvals.id, response.body.approval_id!));
    expect(approval).toMatchObject({ status: "pending", workspaceId: scene.workspaceId });
    expect(approval?.expiresAt.getTime()).toBe(clock.now().getTime() + 15 * 60_000);
    expect(approval?.request).toMatchObject({ agent_id: scene.agent.id, amount_micros: "480000000", tool: "x402.pay" });
    expect(approval?.reasons).toEqual([{ code: "NEEDS_APPROVAL", detail: { level: "agent", thresholdMicros: "100000000" } }]);
    expect((await eventsOf(db(), scene.workspaceId)).map((e) => e.type)).toEqual(["decision", "approval_created"]);
    expect(mocks.x402.calls).toBe(0);
    expect(await reservationsOf(scene.agent.id)).toEqual([]);
  });

  it("fails closed with INVALID_REQUEST for a session that doesn't exist or belongs to another agent", async () => {
    const scene = await createScene(db());
    const other = await createScene(db(), { workspaceId: scene.workspaceId });
    const { deps, mocks } = testDeps(db());
    for (const sessionId of [other.sessionId, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ sessionId }) }, deps);
      expect(response).toMatchObject({ status: 403, body: { reasons: [{ code: "INVALID_REQUEST", detail: { field: "session_id" } }] } });
    }
    expect(mocks.x402.calls).toBe(0);
  });

  it("TAINT-8: a tool that isn't in the registry is denied", async () => {
    const scene = await createScene(db());
    const { deps } = testDeps(db());
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ tool: "drain_wallet" }) }, deps);
    expect(response.body.reasons).toEqual([{ code: "TOOL_NOT_ALLOWED", detail: { tool: "drain_wallet", reason: "not in the tool registry" } }]);
  });

  it("ENV-5: a frozen agent gets AGENT_FROZEN even for an unknown tool or a bad session, which keep their own reason", async () => {
    const scene = await createScene(db());
    await db().update(agents).set({ frozenAt: new Date() }).where(eq(agents.id, scene.agent.id));
    const { deps, mocks } = testDeps(db());

    const unknownTool = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ tool: "drain_wallet" }) }, deps);
    expect(unknownTool.status).toBe(403);
    expect(unknownTool.body.reasons).toEqual([
      { code: "AGENT_FROZEN" },
      { code: "TOOL_NOT_ALLOWED", detail: { tool: "drain_wallet", reason: "not in the tool registry" } },
    ]);

    const badSession = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ sessionId: "not-a-uuid" }) }, deps);
    expect(badSession.body.reasons).toEqual([{ code: "AGENT_FROZEN" }, { code: "INVALID_REQUEST", detail: { field: "session_id" } }]);
    expect(mocks.x402.calls).toBe(0);
  });
});

describe("INT-2 to INT-6: intent scope through the database", () => {
  it("INT-5, INT-6: a vendor that isn't in the workspace registry is denied as the unknown category", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db());
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ vendor: "weather-free-for-all" }) }, deps);
    expect(response).toMatchObject({
      status: 403,
      body: { decision: "deny", reasons: [{ code: "DENY_INTENT_DRIFT", detail: { check: "vendor_category", expected: "weather", actual: "unknown" } }] },
    });
    expect(mocks.x402.calls).toBe(0);
  });

  it("INT-2: a registered vendor in another category is denied with exactly DENY_INTENT_DRIFT (drift scenario)", async () => {
    const scene = await createScene(db());
    const { deps } = testDeps(db());
    expect((await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps)).body.decision).toBe("allow");
    const gpu = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ vendor: "gpu-cloud" }) }, deps);
    expect(gpu.body.reasons).toEqual([{ code: "DENY_INTENT_DRIFT", detail: { check: "vendor_category", expected: "weather", actual: "compute" } }]);
  });

  it("INT-4: session spend from reservations counts toward the task budget", async () => {
    const scene = await createScene(db(), { task: { budgetMicros: micros(3_000n) } });
    const { deps } = testDeps(db());
    const decisions: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
      decisions.push([r.body.decision, ...(r.body.reasons ?? []).map((x) => x.code)].join(" "));
    }
    expect(decisions).toEqual(["allow", "allow", "deny OVER_TASK_BUDGET"]);
  });

  it("INT-4: an unknown rail outcome keeps counting toward the task budget", async () => {
    const scene = await createScene(db(), { task: { budgetMicros: micros(1_500n) } });
    const { deps, mocks } = testDeps(db());
    mocks.x402.setFailureMode("RAIL_TIMEOUT");
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    mocks.x402.setFailureMode(null);
    const r = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect(r.body.reasons?.map((x) => x.code)).toEqual(["OVER_TASK_BUDGET"]);
  });
});

describe("PXY-8, PXY-12, PXY-13, PXY-14: idempotency", () => {
  it("PXY-8: replaying a key with the same body returns the original response without paying again", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db());
    const req = { agent: scene.agent, idempotencyKey: "replay", body: scene.body() };
    const first = await runGuardedRequest(req, deps);
    const events = (await eventsOf(db(), scene.workspaceId)).length;
    for (let i = 0; i < 3; i += 1) expect(await runGuardedRequest(req, deps)).toEqual(first);
    expect(mocks.x402.calls).toBe(1);
    expect((await eventsOf(db(), scene.workspaceId)).length).toBe(events);
  });

  it("PXY-8: replays of a denied request return the stored deny", async () => {
    const scene = await createScene(db(), {
      envelope: { limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: [], allowedTools: "*" },
    });
    const { deps } = testDeps(db());
    const req = { agent: scene.agent, idempotencyKey: "deny-replay", body: scene.body() };
    const first = await runGuardedRequest(req, deps);
    expect(first.status).toBe(403);
    expect(await runGuardedRequest(req, deps)).toEqual(first);
  });

  it("PXY-12: the same key with a different body returns 422 without evaluating or paying", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db());
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: "reused", body: scene.body() }, deps);
    const events = (await eventsOf(db(), scene.workspaceId)).length;
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: "reused", body: scene.body({ amountMicros: micros(1_501n) }) }, deps);
    expect(response).toEqual({ status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } });
    expect(mocks.x402.calls).toBe(1);
    expect((await eventsOf(db(), scene.workspaceId)).length).toBe(events);
  });

  it("PXY-14: a key whose original request hasn't finished returns 409", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = testDeps(db());
    const body = scene.body();
    await db().insert(idempotency).values({ agentId: scene.agent.id, key: "busy", requestHash: requestHash(body), response: null, createdAt: clock.now() });
    expect(await runGuardedRequest({ agent: scene.agent, idempotencyKey: "busy", body }, deps)).toEqual({
      status: 409,
      body: { error: "IDEMPOTENCY_IN_PROGRESS" },
    });
    expect(mocks.x402.calls).toBe(0);
  });

  it("PXY-13: a key reused more than 24 hours later is a new request", async () => {
    const scene = await createScene(db());
    const { deps, mocks, clock } = testDeps(db());
    const req = { agent: scene.agent, idempotencyKey: "daily", body: scene.body() };
    await runGuardedRequest(req, deps);
    clock.advance(24 * 60 * 60_000 - 1);
    await runGuardedRequest(req, deps);
    expect(mocks.x402.calls).toBe(1);
    clock.advance(2);
    const third = await runGuardedRequest(req, deps);
    expect(third.status).toBe(200);
    expect(mocks.x402.calls).toBe(2);
    expect(await reservationsOf(scene.agent.id)).toHaveLength(2);
  });
});

describe("RES-1 to RES-5: reservations and rail outcomes", () => {
  const capped = { limits: { windowCapsMicros: { minute: micros(3_000n) } }, vendorLimits: {}, toolLimits: {}, allowedVendors: "*" as const, allowedTools: "*" as const };

  it("RES-5: a timeout returns 202 unknown, keeps the reservation, and still counts toward the cap", async () => {
    const scene = await createScene(db(), { envelope: capped });
    const { deps, mocks } = testDeps(db());
    mocks.x402.setFailureMode("RAIL_TIMEOUT");
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect(response).toEqual({ status: 202, body: { decision: "allow", reasons: [], rail_status: "unknown", event_seq: 1 } });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
    const [, railResult] = await eventsOf(db(), scene.workspaceId);
    expect(railResult?.payload).toMatchObject({ status: "unknown", code: "RAIL_TIMEOUT" });

    // 1500 unknown + 1500 = the 3000 cap; one more would exceed it.
    mocks.x402.setFailureMode(null);
    expect((await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps)).status).toBe(200);
    const third = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect(third.body.reasons?.map((r) => r.code)).toEqual(["OVER_WINDOW_CAP"]);
  });

  it("RES-4: a confirmed failure returns 502, releases the reservation, and stops counting", async () => {
    const scene = await createScene(db(), { envelope: capped });
    const { deps, mocks } = testDeps(db());
    mocks.x402.setFailureMode("RAIL_REJECTED");
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect(response).toEqual({ status: 502, body: { decision: "allow", reasons: [], rail_status: "failed", error: "RAIL_REJECTED", event_seq: 1 } });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("released");
    mocks.x402.setFailureMode(null);
    for (let i = 0; i < 2; i += 1) expect((await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps)).status).toBe(200);
  });

  it("RAIL-4: an amount below the Stripe minimum is a confirmed failure", async () => {
    const scene = await createScene(db());
    const { deps } = testDeps(db());
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body({ tool: "mpp.pay" }) }, deps);
    expect(response).toMatchObject({ status: 502, body: { error: "BELOW_RAIL_MINIMUM" } });
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("released");
  });

  it("RES-5: an adapter that throws is an unknown outcome", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db());
    mocks.x402.execute = async () => {
      throw new Error("socket hang up");
    };
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect(response.body.rail_status).toBe("unknown");
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
  });

  it("RES-5: replays of an unknown outcome return the stored 202", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db());
    mocks.x402.setFailureMode("RAIL_TIMEOUT");
    const req = { agent: scene.agent, idempotencyKey: key(), body: scene.body() };
    const first = await runGuardedRequest(req, deps);
    expect(await runGuardedRequest(req, deps)).toEqual(first);
  });
});

describe("PXY-7: fail closed", () => {
  it("PXY-7: an audit failure before the rail call rolls everything back and never calls the rail", async () => {
    const scene = await createScene(db());
    const { deps, mocks } = testDeps(db(), { key: new Uint8Array(32).fill(9) });
    await expect(runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps)).rejects.toThrow();
    expect(mocks.x402.calls).toBe(0);
    expect(await reservationsOf(scene.agent.id)).toEqual([]);
    expect(await eventsOf(db(), scene.workspaceId)).toEqual([]);
    const claims = await db().select().from(idempotency).where(eq(idempotency.agentId, scene.agent.id));
    expect(claims).toEqual([]);
  });

  it("PXY-7: a rail with no adapter rolls back the decision and the reservation", async () => {
    const scene = await createScene(db());
    const { deps } = testDeps(db(), {
      railFor: (rail) => {
        throw new RailUnavailableError(rail);
      },
    });
    await expect(runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps)).rejects.toThrow(RailUnavailableError);
    expect(await reservationsOf(scene.agent.id)).toEqual([]);
    expect(await eventsOf(db(), scene.workspaceId)).toEqual([]);
  });

  it("PXY-7: if recording the rail result fails, the reservation stays reserved and replays get 409", async () => {
    const scene = await createScene(db());
    const base = testDeps(db());
    let calls = 0;
    const deps: GuardedDeps = {
      ...base.deps,
      // Fail only the second transaction (the rail result).
      db: new Proxy(db(), {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return (fn: never) => {
              calls += 1;
              if (calls === 2) return Promise.reject(new Error("connection lost"));
              return target.transaction(fn);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
    const req = { agent: scene.agent, idempotencyKey: key(), body: scene.body() };
    await expect(runGuardedRequest(req, deps)).rejects.toThrow("connection lost");
    expect(base.mocks.x402.calls).toBe(1);
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
    expect(await runGuardedRequest(req, base.deps)).toEqual({ status: 409, body: { error: "IDEMPOTENCY_IN_PROGRESS" } });
  });
});

describe("PXY-10, PXY-11: velocity freezes the agent", () => {
  it("PXY-10, AGT-7: the runaway loop is allowed 30 times, then denied for velocity and frozen", async () => {
    const scene = await createScene(db(), {
      envelope: {
        limits: { windowCapsMicros: { minute: fromDecimalString("0.50") }, callsPerMinute: 30 },
        vendorLimits: {},
        toolLimits: {},
        allowedVendors: "*",
        allowedTools: "*",
      },
    });
    const { deps, mocks } = testDeps(db());
    const seen: string[][] = [];
    for (let i = 0; i < 36; i += 1) {
      const r = await runGuardedRequest({ agent: scene.agent, idempotencyKey: `loop-${i}`, body: scene.body() }, deps);
      seen.push([r.body.decision!, ...(r.body.reasons ?? []).map((x) => x.code)]);
    }
    expect(seen).toEqual([
      ...Array.from({ length: 30 }, () => ["allow"]),
      ["deny", "VELOCITY_EXCEEDED"],
      ...Array.from({ length: 5 }, () => ["deny", "AGENT_FROZEN", "VELOCITY_EXCEEDED"]),
    ]);
    expect(mocks.x402.calls).toBe(30);

    const [row] = await db().select().from(agents).where(eq(agents.id, scene.agent.id));
    expect(row?.frozenAt).toBeInstanceOf(Date);
    const frozenEvents = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "agent_frozen");
    expect(frozenEvents).toHaveLength(1);
  }, 60_000); // 36 sequential requests, each several round trips to the test database

  it("PXY-11: a frozen agent is denied even after the minute passes", async () => {
    const scene = await createScene(db());
    const { deps, clock } = testDeps(db());
    await db().update(agents).set({ frozenAt: clock.now() }).where(eq(agents.id, scene.agent.id));
    clock.advance(60 * 60_000);
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect(response.body.reasons).toEqual([{ code: "AGENT_FROZEN" }]);
  });
});

describe("RES-2: trailing windows", () => {
  it("RES-2: spend leaves the minute window after 60 seconds but stays in the hour", async () => {
    const scene = await createScene(db(), {
      envelope: {
        limits: { windowCapsMicros: { minute: micros(1_500n), hour: micros(3_000n) } },
        vendorLimits: {},
        toolLimits: {},
        allowedVendors: "*",
        allowedTools: "*",
      },
    });
    const { deps, clock } = testDeps(db(), { clock: new FakeClock() });
    const pay = () => runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps);
    expect((await pay()).status).toBe(200);
    expect((await pay()).body.reasons?.map((r) => r.detail?.window)).toEqual(["minute"]);
    clock.advance(60_000);
    expect((await pay()).status).toBe(200);
    clock.advance(60_000);
    expect((await pay()).body.reasons?.map((r) => r.detail?.window)).toEqual(["hour"]);
  });

  it("RES-2: reservations of other agents don't count", async () => {
    const scene = await createScene(db(), {
      envelope: { limits: { windowCapsMicros: { day: micros(1_500n) } }, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
    });
    const other = await createScene(db(), { workspaceId: scene.workspaceId });
    const { deps } = testDeps(db());
    await runGuardedRequest({ agent: other.agent, idempotencyKey: key(), body: other.body() }, deps);
    expect((await runGuardedRequest({ agent: scene.agent, idempotencyKey: key(), body: scene.body() }, deps)).status).toBe(200);
  });
});

describe("audit chain", () => {
  it("AUD-2: every workspace touched by the pay flow still verifies", async () => {
    const rows = await queryRows<{ id: string }>(db(), sql`SELECT DISTINCT workspace_id AS id FROM audit_events`);
    for (const { id } of rows) expect((await verifyChain(db(), id, { key: testDeps(db()).deps.key })).ok).toBe(true);
    expect(rows.length).toBeGreaterThan(5);
  });

  it("RES-1: only allowed money-moving requests have reservations", async () => {
    const rows = await queryRows<{ n: number }>(
      db(),
      sql`SELECT count(*)::int AS n FROM spend_reservations r
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_events d JOIN agents a ON a.workspace_id = d.workspace_id
            WHERE a.id = r.agent_id AND d.seq = r.decision_seq AND d.type = 'decision' AND d.payload->>'decision' = 'allow')`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
