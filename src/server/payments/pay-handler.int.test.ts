import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { MockRail } from "@/rails/mock";
import type { MockRails } from "@/rails/select";
import { type Database, type Db, queryRows } from "@/server/db/client";
import { agents, idempotency, spendReservations } from "@/server/db/schema";
import { AGENT_REQUEST_LIMIT } from "@/server/http/agent-route";
import { hitRateLimit } from "@/server/http/rate-limit";
import { createTestDb } from "@/server/db/test-db";
import { type PayDeps, handlePay } from "./pay-handler";
import { FakeClock, type Scene, createScene, eventsOf, expectAuditBeforeSpend, testDeps } from "./test-fixtures";

/** Tests that need real concurrent connections run only against DATABASE_URL_TEST (testing-standards.md). */
const realPostgres = Boolean(process.env.DATABASE_URL_TEST);

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  if (database) {
    await expectAuditBeforeSpend(database.db);
    await database.close();
  }
});

const db = () => database.db;

function payDeps(options: { mocks?: MockRails; clock?: FakeClock; key?: Uint8Array } = {}) {
  const { deps, mocks, clock } = testDeps(db(), options);
  const pay: PayDeps = {
    // The handler closes what it opens; the test database stays open for the whole file.
    openDb: () => ({ db: db(), close: async () => {} }),
    key: () => options.key ?? deps.key,
    now: deps.now,
    railFor: deps.railFor,
  };
  return { pay, mocks, clock };
}

let n = 0;
const nextKey = () => `route-${(n += 1)}`;

function request(scene: Scene, body: Record<string, unknown> = {}, headers: Record<string, string | null> = {}) {
  const h = new Headers({ "content-type": "application/json" });
  const auth = "authorization" in headers ? headers.authorization : `Bearer ${scene.apiKey}`;
  if (auth) h.set("authorization", auth);
  const key = "idempotency-key" in headers ? headers["idempotency-key"] : nextKey();
  if (key) h.set("idempotency-key", key);
  const payload = { vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", session_id: scene.sessionId, ...body };
  return new Request("https://agentvault.example/api/v1/pay", { method: "POST", headers: h, body: JSON.stringify(payload) });
}

const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });
/** The test database, except that every insert throws, as when the rate-limit count can't be written. */
const brokenRateLimits = (real: Db): Db =>
  new Proxy(real, {
    get: (target, prop, receiver) =>
      prop === "insert"
        ? () => {
            throw new Error("rate limit store unavailable");
          }
        : Reflect.get(target, prop, receiver),
  });

describe("POST /api/v1/pay", () => {
  it("PXY-4: allow returns 200 with the rail reference", async () => {
    const scene = await createScene(db());
    const { pay } = payDeps();
    const r = await read(await handlePay(request(scene), pay));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ decision: "allow", reasons: [], rail_status: "settled", event_seq: 1 });
    expect(String(r.body.rail_ref)).toMatch(/^mock_tx_[0-9a-f]{16}$/);
  });

  it("ENV-6: deny returns 403 with the reasons", async () => {
    const scene = await createScene(db(), { envelope: { limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: ["gpu-cloud"], allowedTools: "*" } });
    const { pay, mocks } = payDeps();
    const r = await read(await handlePay(request(scene), pay));
    expect(r).toEqual({ status: 403, body: { decision: "deny", reasons: [{ code: "VENDOR_NOT_ALLOWED", detail: { vendor: "nimbus-weather" } }], event_seq: 1 } });
    expect(mocks.x402.calls).toBe(0);
  });

  it("HITL-1: hold returns 202 with the approval ID", async () => {
    const scene = await createScene(db(), {
      envelope: { limits: { approvalThresholdMicros: fromDecimalString("1") }, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
    });
    const { pay } = payDeps();
    const r = await read(await handlePay(request(scene, { amount_micros: "5000000" }), pay));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ decision: "hold", reasons: [{ code: "NEEDS_APPROVAL" }] });
    expect(String(r.body.approval_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("PXY-8: a replay returns the original response and pays once", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    const first = await read(await handlePay(request(scene, {}, { "idempotency-key": "same" }), pay));
    const second = await read(await handlePay(request(scene, {}, { "idempotency-key": "same" }), pay));
    expect(second).toEqual(first);
    expect(mocks.x402.calls).toBe(1);
  });

  it("PXY-8: key order in the JSON body doesn't make a replay look like a different request", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    const body = { session_id: scene.sessionId, amount_micros: "1500", tool: "x402.pay", vendor: "nimbus-weather" };
    const make = () =>
      new Request("https://x.example/api/v1/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${scene.apiKey}`, "idempotency-key": "reordered" },
        body: JSON.stringify(body),
      });
    await handlePay(request(scene, {}, { "idempotency-key": "reordered" }), pay);
    expect((await handlePay(make(), pay)).status).toBe(200);
    expect(mocks.x402.calls).toBe(1);
  });

  it("PXY-12: the same key with a different body returns 422", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    await handlePay(request(scene, {}, { "idempotency-key": "reuse" }), pay);
    const r = await read(await handlePay(request(scene, { amount_micros: "1600" }, { "idempotency-key": "reuse" }), pay));
    expect(r).toEqual({ status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } });
    expect(mocks.x402.calls).toBe(1);
  });

  it("PXY-13: an expired key is treated as new", async () => {
    const scene = await createScene(db());
    const { pay, mocks, clock } = payDeps();
    await handlePay(request(scene, {}, { "idempotency-key": "old" }), pay);
    clock.advance(24 * 60 * 60_000 + 1);
    expect((await handlePay(request(scene, {}, { "idempotency-key": "old" }), pay)).status).toBe(200);
    expect(mocks.x402.calls).toBe(2);
  });

  it("RES-5: an unknown rail outcome returns 202 with rail_status unknown", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    mocks.x402.setFailureMode("RAIL_TIMEOUT");
    const r = await read(await handlePay(request(scene), pay));
    expect(r).toEqual({ status: 202, body: { decision: "allow", reasons: [], rail_status: "unknown", event_seq: 1 } });
  });

  it("RES-4: a confirmed rail failure returns 502 with the typed code", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    mocks.x402.setFailureMode("RAIL_REJECTED");
    expect(await read(await handlePay(request(scene), pay))).toMatchObject({ status: 502, body: { rail_status: "failed", error: "RAIL_REJECTED" } });
  });

  it("PXY-11: a frozen agent gets AGENT_FROZEN", async () => {
    const scene = await createScene(db());
    const { pay } = payDeps();
    await db().update(agents).set({ frozenAt: new Date() }).where(eq(agents.id, scene.agent.id));
    const r = await read(await handlePay(request(scene), pay));
    expect(r).toEqual({ status: 403, body: { decision: "deny", reasons: [{ code: "AGENT_FROZEN" }], event_seq: 1 } });
  });
});

describe("PXY-3: authentication and validation", () => {
  it.each([
    ["no Authorization header", null],
    ["an unknown key", `Bearer av_test_${"A".repeat(43)}`],
    ["a malformed header", "Bearer"],
  ])("PXY-3: %s returns 401 and writes nothing", async (_name, authorization) => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    const r = await read(await handlePay(request(scene, {}, { authorization }), pay));
    expect(r).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
    expect(mocks.x402.calls).toBe(0);
  });

  it("PXY-3: a revoked key returns 401", async () => {
    const scene = await createScene(db());
    const { pay } = payDeps();
    await db().update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, scene.agent.id));
    expect((await handlePay(request(scene), pay)).status).toBe(401);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a number amount (MON-4)", { amount_micros: 1500 }],
    ["a decimal amount", { amount_micros: "0.0015" }],
    ["a negative amount", { amount_micros: "-1" }],
    ["an amount above MAX_MICROS", { amount_micros: "1000000000000001" }],
    ["a privileged tool", { tool: "stripe.refund" }],
    ["an unknown tool", { tool: "drain_wallet" }],
    ["a session ID that isn't a UUID", { session_id: "abc" }],
    ["an unknown field", { vendor_category: "weather" }],
  ])("security §8: rejects %s with 400 before evaluating", async (_name, body) => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    const r = await read(await handlePay(request(scene, body), pay));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVALID_REQUEST");
    expect(mocks.x402.calls).toBe(0);
    const claims = await queryRows<{ n: number }>(db(), sql`SELECT count(*)::int AS n FROM idempotency WHERE agent_id = ${scene.agent.id}`);
    expect(claims[0]?.n).toBe(0);
  });

  it("PXY-15: past 120 requests a minute an agent gets 429 and nothing is written, while other agents carry on", async () => {
    const scene = await createScene(db());
    const other = await createScene(db(), { workspaceId: scene.workspaceId });
    const { pay, mocks } = payDeps();
    // Use up this minute's 120 for the first agent without sending 120 requests.
    for (let i = 0; i < AGENT_REQUEST_LIMIT.limit; i += 1) {
      await hitRateLimit(db(), { action: "agent-request", ip: `agent:${scene.agent.id}`, now: new Date(), ...AGENT_REQUEST_LIMIT });
    }
    const before = await eventsOf(db(), scene.workspaceId);
    const r = await read(await handlePay(request(scene), pay));
    expect(r).toEqual({ status: 429, body: { error: "RATE_LIMITED" } });
    expect(await eventsOf(db(), scene.workspaceId)).toHaveLength(before.length);
    expect(await db().select().from(idempotency).where(eq(idempotency.agentId, scene.agent.id))).toEqual([]);
    expect(mocks.x402.calls).toBe(0);
    expect((await handlePay(request(other), pay)).status).toBe(200);
  });

  it("PXY-15, PXY-7: if the request count can't be made, the request fails closed with 503", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps();
    const failing = { ...pay, openDb: () => ({ db: brokenRateLimits(db()), close: async () => {} }) };
    const r = await read(await handlePay(request(scene), failing));
    expect(r.status).toBe(503);
    expect(mocks.x402.calls).toBe(0);
    expect(await eventsOf(db(), scene.workspaceId)).toEqual([]);
  });

  it("rejects a missing or malformed Idempotency-Key with 400", async () => {
    const scene = await createScene(db());
    const { pay } = payDeps();
    for (const key of [null, "has space", "x".repeat(256)]) {
      const r = await read(await handlePay(request(scene, {}, { "idempotency-key": key }), pay));
      expect(r.body.error).toBe("INVALID_IDEMPOTENCY_KEY");
    }
  });

  it("rejects a body that isn't JSON or is too large", async () => {
    const scene = await createScene(db());
    const { pay } = payDeps();
    const make = (body: string) =>
      new Request("https://x.example/api/v1/pay", { method: "POST", headers: { authorization: `Bearer ${scene.apiKey}`, "idempotency-key": nextKey() }, body });
    expect((await handlePay(make("{not json"), pay)).status).toBe(400);
    expect((await handlePay(make(JSON.stringify({ vendor: "x".repeat(20_000) })), pay)).status).toBe(400);
  });
});

describe("PXY-7: fail closed", () => {
  it("PXY-7: an error before the rail call returns a generic 503 and makes no rail call", async () => {
    const scene = await createScene(db());
    const { pay, mocks } = payDeps({ key: new Uint8Array(32).fill(7) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await read(await handlePay(request(scene), pay));
    log.mockRestore();
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "SERVICE_UNAVAILABLE", correlation_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(mocks.x402.calls).toBe(0);
  });

  it("PXY-7: a database that can't be opened returns 503", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const scene = await createScene(db());
    const { pay } = payDeps();
    const r = await handlePay(request(scene), {
      ...pay,
      openDb: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
      },
    });
    log.mockRestore();
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("10.0.0.5");
  });
});

describe.runIf(realPostgres)("PXY-9: concurrency (real Postgres only)", () => {
  // Property 2, concurrency (PXY-9, RES-1, RES-2): 50 parallel requests whose
  // total exceeds the cap produce allowed spend <= cap, including when the
  // mock rail is set to RAIL_TIMEOUT for some of them.
  it("PXY-9, RES-2: 50 parallel requests never exceed the minute cap, even with timeouts", async () => {
    const cap = micros(30n * 1_500n);
    const scene = await createScene(db(), {
      envelope: { limits: { windowCapsMicros: { minute: cap } }, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
    });
    const { pay, mocks } = payDeps();
    // Every third payment times out after recording, like a rail that charged but never answered.
    const inner = mocks.x402;
    let count = 0;
    const flaky = new MockRail("x402", 1n);
    flaky.execute = async (req, ctx) => {
      count += 1;
      if (count % 3 === 0) {
        inner.setFailureMode("RAIL_TIMEOUT");
        const r = await inner.execute(req, ctx);
        inner.setFailureMode(null);
        return r;
      }
      return inner.execute(req, ctx);
    };
    pay.railFor = () => flaky;

    const responses = await Promise.all(Array.from({ length: 50 }, () => handlePay(request(scene), pay).then(read)));
    const allowed = responses.filter((r) => r.body.decision === "allow");
    const denied = responses.filter((r) => r.body.decision === "deny");
    expect(allowed).toHaveLength(30);
    expect(denied).toHaveLength(20);
    for (const d of denied) expect(d.body.reasons).toEqual([{ code: "OVER_WINDOW_CAP", detail: { window: "minute", level: "agent" } }]);
    expect(responses.some((r) => r.body.rail_status === "unknown")).toBe(true);

    const rows = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    const counted = rows.filter((r) => r.status !== "released").reduce((total, r) => total + r.amountMicros, 0n);
    expect(counted <= cap).toBe(true);
    expect(rows).toHaveLength(30);
  }, 120_000);

  // Property 3, idempotency (PXY-8, PXY-12, PXY-14): replaying a request N
  // times, sequentially or concurrently, produces exactly one rail call.
  // Replaying the same key with any different body returns 422 and makes no rail call.
  it("PXY-8, PXY-12, PXY-14: concurrent replays of one key make exactly one rail call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.boolean(),
        fc.bigInt({ min: 1n, max: 999_999n }).filter((a) => a !== 1_500n),
        async (replays, concurrent, otherAmount) => {
          const scene = await createScene(db());
          const { pay, mocks } = payDeps();
          const key = nextKey();
          const send = () => handlePay(request(scene, {}, { "idempotency-key": key }), pay).then(read);
          const results = concurrent ? await Promise.all(Array.from({ length: replays }, send)) : await sequence(replays, send);
          expect(mocks.x402.calls).toBe(1);
          // Each response is the paid result, or 409 while the first request was still running.
          for (const r of results) expect([200, 409]).toContain(r.status);
          expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
          const different = await read(await handlePay(request(scene, { amount_micros: String(otherAmount) }, { "idempotency-key": key }), pay));
          expect(different).toEqual({ status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } });
          expect(mocks.x402.calls).toBe(1);
        },
      ),
      { numRuns: 15 },
    );
  }, 180_000);
});

describe("PXY-8, PXY-12: idempotency property (sequential)", () => {
  // Property 3 in its sequential form, which also runs on PGlite.
  it("PXY-8, PXY-12: sequential replays of one key make exactly one rail call", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.bigInt({ min: 1n, max: 999_999n }).filter((a) => a !== 1_500n), async (replays, otherAmount) => {
        const scene = await createScene(db());
        const { pay, mocks } = payDeps();
        const key = nextKey();
        const results = await sequence(replays, () => handlePay(request(scene, {}, { "idempotency-key": key }), pay).then(read));
        expect(mocks.x402.calls).toBe(1);
        for (const r of results) expect(r).toEqual(results[0]);
        const different = await handlePay(request(scene, { amount_micros: String(otherAmount) }, { "idempotency-key": key }), pay);
        expect(different.status).toBe(422);
        expect(mocks.x402.calls).toBe(1);
      }),
      { numRuns: 10 },
    );
  }, 180_000);
});

async function sequence<T>(count: number, fn: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) out.push(await fn());
  return out;
}
