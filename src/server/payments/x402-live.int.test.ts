import { randomUUID } from "node:crypto";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { fromRailUnits, micros } from "@/core/money";
import { loadX402PayerConfig, loadX402VendorConfig } from "@/rails/config";
import { X402Rail } from "@/rails/x402/adapter";
import { BaseSepoliaReader } from "@/rails/x402/chain";
import { spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { cdpFacilitator } from "@/server/vendor/cdp-facilitator";
import { createWeatherHandler } from "@/server/vendor/weather";
import { runGuardedRequest } from "./guarded";
import { SCENE_X402_URL, createScene, eventsOf, testDeps } from "./test-fixtures";

/**
 * x402 on Base Sepolia for real (rail-adapters task 5, `@live`). The
 * vendor endpoint runs in this process with the real CDP facilitator, the
 * agent wallet signs real authorizations, and settlements are real
 * Base Sepolia transactions in test USDC. Run with `pnpm test:live` after
 * `pnpm env:check` reports "x402 ready". Spends $0.0025 of test USDC per run
 * ($0.001 for the minimum check and $0.0015 for the guarded payment).
 */

const URL_ = "http://localhost:3000/vendor/api/weather";
const LIVE_TIMEOUT = 90_000;

function live(price = 1500n) {
  const vendor = loadX402VendorConfig();
  const payer = loadX402PayerConfig();
  const handler = createWeatherHandler({
    payTo: vendor.payTo,
    price: fromRailUnits(price, "x402"),
    facilitator: cdpFacilitator({ apiKeyId: vendor.cdpApiKeyId, apiKeySecret: vendor.cdpApiKeySecret }),
  });
  const urls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    return handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]));
  }) as typeof fetch;
  const chain = new BaseSepoliaReader();
  return { vendor, payer, handler, chain, urls, rail: (minUnits = 1000n) => new X402Rail({ account: payer.account, minUnits, fetch: fetchFn, chain }) };
}

let database: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterAll(async () => {
  await database?.close();
});

describe("@live x402 on Base Sepolia", () => {
  it(
    "@live RAIL-10: the vendor endpoint answers 402 with Base Sepolia USDC requirements from the real CDP facilitator",
    async () => {
      const { handler, vendor } = live();
      const response = await handler(new NextRequest(URL_));
      expect(response.status).toBe(402);
      const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
      expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "1500", payTo: vendor.payTo });
    },
    LIVE_TIMEOUT,
  );

  it(
    "@live RAIL-13: a vendor asking more than the approved amount is refused, and no USDC moves",
    async () => {
      const { rail, chain, payer } = live(1500n);
      const before = await chain.usdcBalance(payer.account.address);
      const result = await rail().execute({ vendorUrl: URL_, approvedMicros: micros(1000n), idempotencyKey: `live-${randomUUID()}` }, { reservedAt: new Date() });
      expect(result).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
      expect(await chain.usdcBalance(payer.account.address)).toBe(before);
    },
    LIVE_TIMEOUT,
  );

  it(
    "@live X402_MIN_UNITS: the CDP facilitator refuses 999 units and settles 1000 (the measured minimum)",
    async () => {
      const below = live(999n);
      const refused = await below.rail(1n).execute({ vendorUrl: URL_, approvedMicros: micros(999n), idempotencyKey: `live-${randomUUID()}` }, { reservedAt: new Date() });
      expect(refused).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
      const at = live(1000n);
      const settled = await at.rail(1n).execute({ vendorUrl: URL_, approvedMicros: micros(1000n), idempotencyKey: `live-${randomUUID()}` }, { reservedAt: new Date() });
      expect(settled).toMatchObject({ ok: true, settledMicros: 1000n });
    },
    LIVE_TIMEOUT,
  );

  it(
    "@live RAIL-11, RAIL-12, RAIL-21, RAIL-23: a guarded $0.0015 payment goes to the vendor's x402_url, settles on Base Sepolia, rail_result records the hash, and lookup() finds it on-chain",
    async () => {
      database = await createTestDb();
      const db = database.db;
      const { rail, urls } = live(1500n);
      const adapter = rail();
      const scene = await createScene(db);
      const { deps } = testDeps(db, { now: () => new Date() });
      const flow = { ...deps, railFor: (r: Parameters<typeof deps.railFor>[0], w: { isSandbox: boolean }) => (r === "x402" && !w.isSandbox ? adapter : deps.railFor(r, w)) };
      const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: `live-${randomUUID()}`, body: scene.body() }, flow);
      expect(response).toMatchObject({ status: 200, body: { rail_status: "settled" } });
      expect(urls).toEqual([SCENE_X402_URL, SCENE_X402_URL]);
      const hash = response.body.rail_ref ?? "";
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(response.body.explorer_url).toBe(`https://sepolia.basescan.org/tx/${hash}`);

      const result = (await eventsOf(db, scene.workspaceId)).find((e) => e.type === "rail_result");
      const payload = result?.payload as { reservation_id: string; rail_ref: string; settled_micros: string };
      expect(payload).toMatchObject({ rail_ref: hash, settled_micros: "1500" });

      // The reservation's created_at is the decision time; the clock is real here, so it's within the test.
      const [reservation] = await db.select().from(spendReservations).where(eq(spendReservations.id, payload.reservation_id));
      const found = await adapter.lookup(payload.reservation_id, { reservedAt: reservation!.createdAt });
      expect(found).toEqual({ status: "settled", ref: hash, explorerUrl: `https://sepolia.basescan.org/tx/${hash}`, settledMicros: 1500n });
    },
    LIVE_TIMEOUT,
  );
});
