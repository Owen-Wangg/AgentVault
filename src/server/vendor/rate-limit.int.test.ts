import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock } from "@/server/payments/test-fixtures";
import { type VendorLimitDeps, withVendorRateLimit } from "./rate-limit";

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const request = () => new Request("https://agentvault.example/vendor/api/weather");

describe("RAIL-28: the demo vendor's paid APIs are rate-limited per IP", () => {
  it("RAIL-28: runs the handler up to the limit, then answers 429 without running it", async () => {
    const clock = new FakeClock();
    const deps: VendorLimitDeps = { openDb: () => ({ db: database.db, close: async () => {} }), now: clock.now, limit: { limit: 2, windowMs: 60_000 } };
    let ran = 0;
    const handler = async () => {
      ran += 1;
      return new Response("paid", { status: 402 });
    };
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await withVendorRateLimit(request(), "vendor weather test", handler, deps)).status);
    expect(statuses).toEqual([402, 402, 429]);
    expect(ran).toBe(2);
    clock.advance(60_000);
    expect((await withVendorRateLimit(request(), "vendor weather test", handler, deps)).status).toBe(402);
  });

  it("RAIL-28: fails closed with 503 when the count can't be made", async () => {
    let ran = false;
    const deps: VendorLimitDeps = {
      openDb: () => {
        throw new Error("no database");
      },
      now: () => new Date(),
    };
    const response = await withVendorRateLimit(request(), "vendor weather test", async () => {
      ran = true;
      return new Response("paid");
    }, deps);
    expect(response.status).toBe(503);
    expect(ran).toBe(false);
  });
});
