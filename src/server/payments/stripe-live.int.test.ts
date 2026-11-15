import { randomUUID } from "node:crypto";
import { Challenge } from "mppx";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { loadStripeConfig } from "@/rails/config";
import { StripeMppRail } from "@/rails/stripe-mpp/adapter";
import { StripeApi } from "@/rails/stripe-mpp/stripe-api";
import { spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { REPORT_PATH, challengeSigningKey, createReportHandler, vendorStripeClient } from "@/server/vendor/report";
import { runGuardedRequest } from "./guarded";
import { createScene, eventsOf, testDeps } from "./test-fixtures";

/**
 * Stripe MPP in test mode for real (rail-adapters task 8, `@live`). The
 * vendor endpoint runs in this process with the real Stripe API, the
 * adapter gets real test SPTs from Stripe's test helper, and payments and
 * refunds are real test-mode objects in the sandbox. Test cards only: no
 * real money moves. Run with `pnpm test:live` after `pnpm env:check`
 * reports "Stripe ready".
 */

const URL_ = `http://localhost:3000${REPORT_PATH}`;
const LIVE_TIMEOUT = 60_000;

function live() {
  const config = loadStripeConfig();
  const handler = createReportHandler({ client: vendorStripeClient(config), profileId: config.profileId, challengeKey: challengeSigningKey(config.secretKey()) });
  const fetchFn = (async (url: string, init?: RequestInit) => handler(new Request(url, init))) as typeof fetch;
  const rail = new StripeMppRail({ api: new StripeApi({ secretKey: config.secretKey() }), profileId: config.profileId, fetch: fetchFn });
  return { config, handler, rail };
}

let database: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterAll(async () => {
  await database?.close();
});

describe("@live Stripe MPP in test mode", () => {
  it(
    "@live RAIL-14: the vendor endpoint answers 402 with a 50-cent MPP challenge to the sandbox's profile",
    async () => {
      const { handler, config } = live();
      const response = await handler(new Request(URL_));
      expect(response.status).toBe(402);
      const challenge = Challenge.fromResponse(response);
      expect(challenge).toMatchObject({ method: "stripe", intent: "charge" });
      expect(challenge.request).toMatchObject({ amount: "50", currency: "usd", methodDetails: { networkId: config.profileId } });
    },
    LIVE_TIMEOUT,
  );

  it(
    "@live RAIL-13: a vendor asking more than the approved amount is refused before any SPT is created",
    async () => {
      const { rail } = live();
      const result = await rail.execute({ vendorUrl: URL_, approvedMicros: fromDecimalString("0.60"), idempotencyKey: `live-${randomUUID()}` }, { reservedAt: new Date() });
      expect(result).toMatchObject({ ok: false, code: "CHALLENGE_MISMATCH" });
    },
    LIVE_TIMEOUT,
  );

  it(
    "@live RAIL-15, RAIL-16, RAIL-17, RAIL-21: a guarded $0.50 mpp.pay settles with a PaymentIntent, lookup() finds it, and a refund of it settles and is found",
    async () => {
      database = await createTestDb();
      const db = database.db;
      const { rail } = live();
      const scene = await createScene(db, { task: { allowedTools: ["mpp.pay", "stripe.refund"] } });
      const { deps } = testDeps(db, { now: () => new Date() });
      const flow = { ...deps, railFor: (r: Parameters<typeof deps.railFor>[0], w: { isSandbox: boolean }) => (r === "stripe" && !w.isSandbox ? rail : deps.railFor(r, w)) };

      const paid = await runGuardedRequest({ agent: scene.agent, idempotencyKey: `live-${randomUUID()}`, body: scene.body({ tool: "mpp.pay", amountMicros: fromDecimalString("0.50") }) }, flow);
      expect(paid).toMatchObject({ status: 200, body: { rail_status: "settled" } });
      const pi = paid.body.rail_ref ?? "";
      expect(pi).toMatch(/^pi_\w+$/);

      const payResult = (await eventsOf(db, scene.workspaceId)).find((e) => e.type === "rail_result")?.payload as { reservation_id: string; rail_ref: string; settled_micros: string };
      expect(payResult).toMatchObject({ rail_ref: pi, settled_micros: "500000" });
      const [payReservation] = await db.select().from(spendReservations).where(eq(spendReservations.id, payResult.reservation_id));
      expect(await rail.lookup(payResult.reservation_id, { reservedAt: payReservation!.createdAt })).toMatchObject({ status: "settled", ref: pi, settledMicros: 500_000n });

      const refunded = await runGuardedRequest(
        { agent: scene.agent, idempotencyKey: `live-${randomUUID()}`, body: scene.body({ tool: "stripe.refund", amountMicros: fromDecimalString("0.50"), args: { payment_ref: pi } }) },
        flow,
      );
      expect(refunded).toMatchObject({ status: 200, body: { rail_status: "settled" } });
      const re = refunded.body.rail_ref ?? "";
      expect(re).toMatch(/^re_\w+$/);
      const refundResult = (await eventsOf(db, scene.workspaceId)).filter((e) => e.type === "rail_result").at(-1)?.payload as { reservation_id: string; refund_of: string };
      expect(refundResult).toMatchObject({ refund_of: pi });
      const [refundReservation] = await db.select().from(spendReservations).where(eq(spendReservations.id, refundResult.reservation_id));
      expect(await rail.lookup(refundResult.reservation_id, { reservedAt: refundReservation!.createdAt })).toMatchObject({ status: "settled", ref: re, settledMicros: 500_000n });
    },
    LIVE_TIMEOUT,
  );
});
