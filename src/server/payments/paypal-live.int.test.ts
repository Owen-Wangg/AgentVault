import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { loadPayPalConfig } from "@/rails/config";
import { PayPalRail } from "@/rails/paypal/adapter";
import { spendReservations, vendors } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { runGuardedRequest } from "./guarded";
import { OPEN_ENVELOPE, createScene, eventsOf, testDeps } from "./test-fixtures";

/**
 * PayPal sandbox payouts for real (payout-rails task 6, `@live`). A
 * guarded paypal.payout of $1.00 sends a real sandbox payout from the
 * sandbox business account to PAYPAL_SUPPLIER_RECEIVER: fake money, plus
 * PayPal's $0.25 sandbox fee. Run `pnpm env:check` first: its PayPal
 * section must pass. PayPal took 15 to 30 seconds to settle in the probe,
 * so the payout may come back unknown with its batch ID; the test then
 * reads the batch through lookup(), as the reconciler would.
 */

const LIVE_TIMEOUT = 120_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let database: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterAll(async () => {
  await database?.close();
});

describe("@live PayPal sandbox payouts", () => {
  it(
    "@live PO-15, PO-16, PO-25: a guarded $1.00 paypal.payout reaches SUCCESS for the registered receiver, found by the stored batch ID if it was still pending",
    async () => {
      database = await createTestDb();
      const db = database.db;
      const config = loadPayPalConfig();
      const rail = new PayPalRail({ config });
      const scene = await createScene(db, {
        envelope: OPEN_ENVELOPE,
        isSandbox: false,
        task: { allowedVendorCategories: ["suppliers"], allowedTools: ["paypal.payout"], budgetMicros: fromDecimalString("10") },
      });
      await db.insert(vendors).values({
        workspaceId: scene.workspaceId,
        name: "acme-supplies",
        origin: "https://acme-supplies.example",
        category: "suppliers",
        trusted: false,
        paypalReceiver: config.supplierReceiver,
      });
      const { deps } = testDeps(db, { now: () => new Date() });
      const flow = { ...deps, railFor: (r: Parameters<typeof deps.railFor>[0], w: { isSandbox: boolean }) => (r === "paypal" && !w.isSandbox ? rail : deps.railFor(r, w)) };

      const paid = await runGuardedRequest(
        { agent: scene.agent, idempotencyKey: `live-${randomUUID()}`, body: { vendor: "acme-supplies", tool: "paypal.payout", amountMicros: fromDecimalString("1.00"), sessionId: scene.sessionId } },
        flow,
      );
      expect(paid.body.decision).toBe("allow");
      expect(["settled", "unknown"]).toContain(paid.body.rail_status);
      const result = (await eventsOf(db, scene.workspaceId)).find((e) => e.type === "rail_result")?.payload as { reservation_id: string; rail_ref?: string };
      expect(result).toMatchObject({ payout_to: config.supplierReceiver });
      const [reservation] = await db.select().from(spendReservations).where(eq(spendReservations.id, result.reservation_id));

      if (paid.body.rail_status === "unknown") {
        // PO-25: still pending after the adapter's wait, so the batch ID was stored for the reconciler.
        expect(reservation).toMatchObject({ status: "reserved" });
        expect(reservation?.railRef).toMatch(/^[A-Za-z0-9]+$/);
        let found = await rail.lookup(result.reservation_id, { railRef: reservation?.railRef ?? "" });
        for (let i = 0; i < 8 && found.status === "unknown"; i += 1) {
          await sleep(5_000);
          found = await rail.lookup(result.reservation_id, { railRef: reservation?.railRef ?? "" });
        }
        expect(found).toMatchObject({ status: "settled", settledMicros: 1_000_000n });
      } else {
        expect(reservation).toMatchObject({ status: "settled", railRef: null });
        expect(paid.body.rail_ref).toMatch(/^[A-Za-z0-9]+$/);
      }
    },
    LIVE_TIMEOUT,
  );
});
