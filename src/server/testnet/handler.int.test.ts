import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, eventsOf } from "@/server/payments/test-fixtures";
import { handleTestnetPay } from "./handler";
import { ORIGIN, RecordingX402, footprint, press, testnetDeps } from "./test-fixtures";
import { type TestnetWorkspace, createTestnetWorkspace } from "./workspace";

let database: Awaited<ReturnType<typeof createTestDb>>;
let testnet: TestnetWorkspace;
const db = () => database.db;
// Each test starts a week after the last, so no rate-limit window or envelope day carries over.
let start = Date.UTC(2026, 10, 18, 9, 30);
const freshClock = () => {
  start += 7 * 24 * 60 * 60_000;
  return new FakeClock(start);
};

beforeAll(async () => {
  database = await createTestDb();
  testnet = await createTestnetWorkspace(db(), { appOrigin: ORIGIN, key: TEST_HEAD_KEY, now: new Date(start) });
}, 60_000);
afterAll(async () => {
  await database?.close();
});

describe("POST /api/v1/testnet/pay", () => {
  it("TN-2, TN-3: one press makes one $0.0015 x402 payment to the registered x402_url, and returns the decision and the rail result", async () => {
    const clock = freshClock();
    const rail = new RecordingX402();
    const response = await handleTestnetPay(press(), testnetDeps(db(), clock, rail));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ decision: "allow", reasons: [], rail_status: "settled", vendor: "nimbus-weather", amount_micros: "1500" });
    expect(typeof body.rail_ref).toBe("string");
    expect(typeof body.event_seq).toBe("number");
    expect(rail.requests).toHaveLength(1);
    expect(rail.requests[0]).toMatchObject({ vendorUrl: `${ORIGIN}/vendor/api/weather`, approvedMicros: 1500n });
    // The guarded flow wrote the decision before the rail result, in the testnet workspace's own chain.
    const types = (await eventsOf(db(), testnet.workspaceId)).map((e) => e.type);
    expect(types.slice(-2)).toEqual(["decision", "rail_result"]);
    expect(await verifyChain(db(), testnet.workspaceId, { key: TEST_HEAD_KEY })).toMatchObject({ ok: true });
  });

  it("TN-1: with real rails not ready, a press is 404 TESTNET_OFF and nothing is created or paid", async () => {
    const rail = new RecordingX402();
    const before = await footprint(db(), testnet.workspaceId, testnet.agentId);
    const response = await handleTestnetPay(press(), testnetDeps(db(), freshClock(), rail, { railReady: () => false }));
    expect([response.status, await response.json()]).toEqual([404, { error: "TESTNET_OFF" }]);
    expect(await footprint(db(), testnet.workspaceId, testnet.agentId)).toEqual(before);
    expect(rail.requests).toHaveLength(0);
  });

  it("TN-5: the third press from one IP in an hour is 429 RATE_LIMITED and creates nothing", async () => {
    const clock = freshClock();
    const rail = new RecordingX402();
    const deps = testnetDeps(db(), clock, rail);
    expect((await handleTestnetPay(press({ ip: "198.51.100.1" }), deps)).status).toBe(200);
    expect((await handleTestnetPay(press({ ip: "198.51.100.1" }), deps)).status).toBe(200);
    const before = await footprint(db(), testnet.workspaceId, testnet.agentId);
    const third = await handleTestnetPay(press({ ip: "198.51.100.1" }), deps);
    expect([third.status, await third.json()]).toEqual([429, { error: "RATE_LIMITED" }]);
    expect(await footprint(db(), testnet.workspaceId, testnet.agentId)).toEqual(before);
    expect(rail.requests).toHaveLength(2);
    // Another IP still gets through.
    expect((await handleTestnetPay(press({ ip: "198.51.100.2" }), deps)).status).toBe(200);
  });

  it("TN-5: after 20 payments in a UTC day, everyone gets 429 TESTNET_QUOTA_USED", async () => {
    const clock = freshClock();
    const rail = new RecordingX402();
    const deps = testnetDeps(db(), clock, rail, { limits: { perIp: { limit: 100, windowMs: 3_600_000 }, perMinute: { limit: 100, windowMs: 60_000 }, perDay: { limit: 20, windowMs: 86_400_000 } } });
    for (let i = 0; i < 20; i += 1) expect((await handleTestnetPay(press({ ip: `192.0.2.${i}` }), deps)).status).toBe(200);
    const refused = await handleTestnetPay(press({ ip: "192.0.2.200" }), deps);
    expect([refused.status, await refused.json()]).toEqual([429, { error: "TESTNET_QUOTA_USED" }]);
    expect(rail.requests).toHaveLength(20);
  }, 60_000);

  it("TN-6: past the envelope's $0.05 day, the guarded flow denies with OVER_WINDOW_CAP and pays nothing", async () => {
    const clock = freshClock();
    const rail = new RecordingX402();
    const open = { limit: 1_000, windowMs: 60_000 };
    const deps = testnetDeps(db(), clock, rail, { limits: { perIp: open, perMinute: open, perDay: open } });
    // 33 × $0.0015 = $0.0495, under $0.05; the 34th would make $0.051.
    for (let i = 0; i < 33; i += 1) {
      expect(await (await handleTestnetPay(press(), deps)).json()).toMatchObject({ decision: "allow" });
      clock.advance(2_100); // stays under 30 calls a minute
    }
    const denied = (await (await handleTestnetPay(press(), deps)).json()) as { decision: string; reasons: { code: string }[] };
    expect(denied.decision).toBe("deny");
    expect(denied.reasons.map((r) => r.code)).toEqual(["OVER_WINDOW_CAP"]);
    expect(rail.requests).toHaveLength(33);
  }, 120_000);

  it("TN-7: an agent key, a cross-site request, or any field in the body is refused before anything happens", async () => {
    const rail = new RecordingX402();
    const deps = testnetDeps(db(), freshClock(), rail);
    const before = await footprint(db(), testnet.workspaceId, testnet.agentId);
    const bearer = await handleTestnetPay(press({ headers: { authorization: "Bearer av_x" } }), deps);
    expect([bearer.status, await bearer.json()]).toEqual([403, { error: "AGENT_KEY_FORBIDDEN" }]);
    const crossSite = await handleTestnetPay(press({ headers: { origin: "https://evil.example" } }), deps);
    expect([crossSite.status, await crossSite.json()]).toEqual([403, { error: "CROSS_ORIGIN" }]);
    for (const body of ['{"amount_micros":"1000000"}', '{"vendor":"gpu-cloud"}', "[]", "", "not json"]) {
      expect((await handleTestnetPay(press({ body }), deps)).status).toBe(400);
    }
    expect(await footprint(db(), testnet.workspaceId, testnet.agentId)).toEqual(before);
    expect(rail.requests).toHaveLength(0);
  });

  it("TN-1: with no testnet workspace, a press is 404 TESTNET_OFF", async () => {
    const empty = await createTestDb({ driver: "pglite" });
    try {
      const response = await handleTestnetPay(press(), testnetDeps(empty.db, freshClock(), new RecordingX402()));
      expect([response.status, await response.json()]).toEqual([404, { error: "TESTNET_OFF" }]);
    } finally {
      await empty.close();
    }
  }, 60_000);
});
