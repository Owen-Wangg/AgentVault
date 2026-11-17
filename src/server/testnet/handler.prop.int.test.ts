import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock } from "@/server/payments/test-fixtures";
import { TESTNET_LIMITS, handleTestnetPay } from "./handler";
import { ORIGIN, RecordingX402, footprint, press, testnetDeps } from "./test-fixtures";
import { type TestnetWorkspace, createTestnetWorkspace } from "./workspace";

/**
 * Sequential properties with hundreds of presses each, so they run on
 * in-memory PGlite even when DATABASE_URL_TEST is set (testing-standards).
 * The example tests in handler.int.test.ts run the same handler on
 * Postgres.
 */
let database: Awaited<ReturnType<typeof createTestDb>>;
let testnet: TestnetWorkspace;
const db = () => database.db;
const DAY = 86_400_000;
// Each case starts 30 days after the last, so no rate-limit window or envelope day carries over.
let caseStart = Date.UTC(2026, 10, 18, 0, 0, 0, 500);
const nextCaseClock = () => {
  caseStart += 30 * DAY;
  return new FakeClock(caseStart);
};

beforeAll(async () => {
  database = await createTestDb({ driver: "pglite" });
  testnet = await createTestnetWorkspace(db(), { appOrigin: ORIGIN, key: TEST_HEAD_KEY, now: new Date(caseStart) });
}, 60_000);
afterAll(async () => {
  await database?.close();
});

/** The fixed windows hitRateLimit uses, aligned to the epoch. */
const windowOf = (ms: number, windowMs: number) => Math.floor(ms / windowMs);

/**
 * What TN-5 allows, worked out on its own: a press counts against the
 * per-IP hour first, then the all-visitor minute, then the all-visitor
 * day, and each counter is only reached if the one before it passed.
 */
class LimitModel {
  private readonly counts = new Map<string, number>();
  private hit(key: string, limit: number): boolean {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= limit;
  }
  press(ip: string, ms: number): "allowed" | "RATE_LIMITED" | "TESTNET_QUOTA_USED" {
    const l = TESTNET_LIMITS;
    if (!this.hit(`ip:${ip}:${windowOf(ms, l.perIp.windowMs)}`, l.perIp.limit)) return "RATE_LIMITED";
    if (!this.hit(`minute:${windowOf(ms, l.perMinute.windowMs)}`, l.perMinute.limit)) return "RATE_LIMITED";
    if (!this.hit(`day:${windowOf(ms, l.perDay.windowMs)}`, l.perDay.limit)) return "TESTNET_QUOTA_USED";
    return "allowed";
  }
}

const pressArb = fc.record({
  ip: fc.constantFrom("198.51.100.1", "198.51.100.2", "198.51.100.3", "203.0.113.9"),
  // Gaps that cross the minute, hour, and day windows, but never land exactly on a trailing-window edge.
  gapMs: fc.constantFrom(0, 1_700, 13_000, 61_000, 3_601_000, DAY + 1_000),
});

describe("POST /api/v1/testnet/pay: properties", () => {
  // testnet-demo property 1, Limits hold (TN-5): for any sequence of presses from any IPs at any
  // times, no IP gets more than 2 payments in an hour, all visitors get at most 6 in a minute and 20
  // in a UTC day, and every refused press creates no session, no audit event, and no rail call.
  it("TN-5: property 1, every press gets exactly what the limits allow, and a refused press leaves no trace", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pressArb, { minLength: 1, maxLength: 14 }), async (presses) => {
        const clock = nextCaseClock();
        const rail = new RecordingX402();
        const deps = testnetDeps(db(), clock, rail);
        const model = new LimitModel();
        let paid = 0;
        for (const { ip, gapMs } of presses) {
          clock.advance(gapMs);
          const expected = model.press(ip, clock.now().getTime());
          const before = await footprint(db(), testnet.workspaceId, testnet.agentId);
          const response = await handleTestnetPay(press({ ip }), deps);
          const body = (await response.json()) as { error?: string; decision?: string };
          if (expected === "allowed") {
            expect(response.status).toBe(200);
            // At most 20 a UTC day keeps every trailing 24 hours under the envelope's 33, so each one is allowed.
            expect(body.decision).toBe("allow");
            paid += 1;
          } else {
            expect([response.status, body.error]).toEqual([429, expected]);
            expect(await footprint(db(), testnet.workspaceId, testnet.agentId)).toEqual(before);
          }
          expect(rail.requests).toHaveLength(paid);
        }
      }),
      { numRuns: 200 },
    );
  }, 600_000);

  // testnet-demo property 2, Fixed payment (TN-2, TN-7): for any request body other than `{}`, and any
  // Authorization header, nothing is paid; for `{}`, the rail is asked for exactly one $0.0015 payment
  // to the vendor's registered x402_url, never anything else.
  it("TN-2, TN-7: property 2, only an empty body without a key pays, and always the same payment", async () => {
    const bodyArb = fc.oneof(
      { weight: 4, arbitrary: fc.constant("{}") },
      { weight: 4, arbitrary: fc.jsonValue().map((v) => JSON.stringify(v) ?? "null").filter((s) => s !== "{}") },
      { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
      {
        weight: 2,
        arbitrary: fc
          .dictionary(fc.constantFrom("vendor", "tool", "amount_micros", "session_id", "__proto__", "x402_url", "amount"), fc.jsonValue(), { minKeys: 1 })
          .map((o) => JSON.stringify(o)),
      },
    );
    const headerArb = fc.option(fc.constantFrom("Bearer av_123", "Basic abc", "bearer", ""), { nil: undefined, freq: 2 });
    let paying = 0;
    await fc.assert(
      fc.asyncProperty(bodyArb, headerArb, async (body, authorization) => {
        const clock = nextCaseClock();
        const rail = new RecordingX402();
        const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
        const response = await handleTestnetPay(press({ body, headers }), testnetDeps(db(), clock, rail));
        if (body === "{}" && authorization === undefined) {
          paying += 1;
          expect(response.status).toBe(200);
          expect(rail.requests).toHaveLength(1);
          expect(rail.requests[0]).toMatchObject({ vendorUrl: `${ORIGIN}/vendor/api/weather`, approvedMicros: 1500n });
        } else {
          expect([400, 403]).toContain(response.status);
          expect(rail.requests).toHaveLength(0);
        }
      }),
      { numRuns: 500 },
    );
    // About a sixth of the cases (a third are "{}", half have no header) take the paying branch: about 80, more than 4 standard deviations above 50.
    expect(paying).toBeGreaterThan(50);
  }, 600_000);
});
