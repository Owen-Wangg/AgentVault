import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { loadX402PayerConfig, loadX402VendorConfig } from "@/rails/config";
import { X402Rail } from "@/rails/x402/adapter";
import { BaseSepoliaReader } from "@/rails/x402/chain";
import { spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { cdpFacilitator } from "@/server/vendor/cdp-facilitator";
import { createWeatherHandler } from "@/server/vendor/weather";
import { handleTestnetPay } from "./handler";
import { press } from "./test-fixtures";
import { createTestnetWorkspace } from "./workspace";

/**
 * The testnet button for real (testnet-demo TN-2, TN-3, `@live`): one press
 * runs through the handler and the guarded flow to the real x402 adapter,
 * which pays the weather vendor (in this process, with the real CDP
 * facilitator) on Base Sepolia. Spends $0.0015 of test USDC. Run with
 * `pnpm test:live` after `pnpm env:check` reports "x402 ready".
 */
const ORIGIN = "http://localhost:3000";
let database: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterAll(async () => {
  await database?.close();
});

describe("@live testnet button on Base Sepolia", () => {
  it("TN-2, TN-3: @live one press settles a $0.0015 x402 payment on Base Sepolia, and lookup() finds it again", async () => {
    const vendor = loadX402VendorConfig();
    const payer = loadX402PayerConfig();
    const handler = createWeatherHandler({ payTo: vendor.payTo, facilitator: cdpFacilitator({ apiKeyId: vendor.cdpApiKeyId, apiKeySecret: vendor.cdpApiKeySecret }) });
    const urls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      return handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]));
    }) as typeof fetch;
    const rail = new X402Rail({ account: payer.account, minUnits: payer.minUnits, fetch: fetchFn, chain: new BaseSepoliaReader() });

    database = await createTestDb();
    const testnet = await createTestnetWorkspace(database.db, { appOrigin: ORIGIN, key: TEST_HEAD_KEY });
    const db = database.db;
    const response = await handleTestnetPay(press(), {
      openDb: () => ({ db, close: async () => {} }),
      key: () => TEST_HEAD_KEY,
      now: () => new Date(),
      railFor: () => rail,
      railReady: () => true,
    });
    const body = (await response.json()) as { decision: string; rail_status: string; rail_ref: string; explorer_url: string };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ decision: "allow", rail_status: "settled" });
    expect(body.rail_ref).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(body.explorer_url).toBe(`https://sepolia.basescan.org/tx/${body.rail_ref}`);
    expect(urls.every((u) => u === `${ORIGIN}/vendor/api/weather`)).toBe(true);
    expect(testnet.created).toBe(true);
    // The reconciler's read-only lookup finds the same transaction by the reservation ID alone (RAIL-21).
    const [reservation] = await db.select().from(spendReservations).where(eq(spendReservations.agentId, testnet.agentId));
    if (!reservation) throw new Error("no reservation");
    expect(reservation.status).toBe("settled");
    const found = await rail.lookup(reservation.id, { reservedAt: reservation.createdAt });
    expect(found).toMatchObject({ status: "settled", ref: body.rail_ref });
  }, 120_000);
});
