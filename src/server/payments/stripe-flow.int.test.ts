import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { StripeMppRail } from "@/rails/stripe-mpp/adapter";
import { FakeStripeAccount, PROFILE, fakeMppVendor } from "@/rails/stripe-mpp/test-fixtures";
import type { RailAdapter } from "@/rails/types";
import { spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type GuardedDeps, runGuardedRequest } from "./guarded";
import { STALE_AFTER_MS, reconcile } from "./reconcile";
import { FakeClock, createScene, eventsOf, expectAuditBeforeSpend, testDeps } from "./test-fixtures";

/**
 * The Stripe MPP adapter inside the pay flow (rail-adapters task 8): the
 * Stripe account and the MPP vendor are fakes, everything else is the
 * real flow on Postgres.
 */

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
const nextKey = () => `stripe-${(n += 1)}`;
const REPORT = fromDecimalString("0.50");

/** Route Stripe to `adapter`, as railOptions() does in real mode, and the rest to the usual mocks. */
function withStripe(base: GuardedDeps, adapter: RailAdapter): GuardedDeps {
  return { ...base, railFor: (rail, workspace) => (rail === "stripe" && !workspace.isSandbox ? adapter : base.railFor(rail, workspace)) };
}

function stripeSetup(clock: FakeClock, vendorOptions: Parameters<typeof fakeMppVendor>[1] = {}) {
  const account = new FakeStripeAccount(() => Math.floor(clock.now().getTime() / 1000));
  const vendor = fakeMppVendor(account, vendorOptions);
  const rail = new StripeMppRail({ api: account.api(), profileId: PROFILE, fetch: vendor.fetchFn, now: clock.now });
  return { account, vendor, rail };
}

async function reservationsOf(agentId: string) {
  return db().select().from(spendReservations).where(eq(spendReservations.agentId, agentId));
}

describe("Stripe MPP in the pay flow", () => {
  it("RAIL-15, RAIL-16: a settled mpp.pay records the PaymentIntent ID in rail_result and the response", async () => {
    const scene = await createScene(db());
    const { deps, clock } = testDeps(db());
    const { account, rail } = stripeSetup(clock);
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ tool: "mpp.pay", amountMicros: REPORT }) }, withStripe(deps, rail));

    const pi = account.paymentIntents[0];
    expect(response).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled", rail_ref: pi?.id, explorer_url: `https://dashboard.stripe.com/test/payments/${pi?.id}` } });
    const result = (await eventsOf(db(), scene.workspaceId)).find((e) => e.type === "rail_result");
    expect(result?.payload).toMatchObject({ status: "settled", rail: "stripe", rail_ref: pi?.id, settled_micros: "500000" });
    const [reservation] = await reservationsOf(scene.agent.id);
    expect(reservation).toMatchObject({ status: "settled", amountMicros: REPORT });
    // The vendor's PaymentIntent carries the reservation ID, the rail idempotency key.
    expect(pi?.metadata.idempotency_key).toBe(reservation?.railIdempotencyKey);
  });

  it("RAIL-17: an allowed stripe.refund creates a refund and records the Refund ID", async () => {
    const scene = await createScene(db(), { task: { allowedTools: ["mpp.pay", "stripe.refund"] } });
    const { deps, clock } = testDeps(db());
    const { account, rail } = stripeSetup(clock);
    const flow = withStripe(deps, rail);
    const paid = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ tool: "mpp.pay", amountMicros: REPORT }) }, flow);
    const paymentRef = paid.body.rail_ref ?? "";

    const refunded = await runGuardedRequest(
      { agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ tool: "stripe.refund", amountMicros: fromDecimalString("0.20"), args: { payment_ref: paymentRef } }) },
      flow,
    );
    const refund = account.refunds[0];
    expect(refunded).toMatchObject({ status: 200, body: { rail_status: "settled", rail_ref: refund?.id } });
    expect(refund).toMatchObject({ payment_intent: paymentRef, amount: 20 });
    const results = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "rail_result");
    expect(results.at(-1)?.payload).toMatchObject({ status: "settled", rail: "stripe", refund_of: paymentRef, rail_ref: refund?.id, settled_micros: "200000" });
  });

  it("RAIL-2: a sandbox workspace never reaches the Stripe adapter", async () => {
    const scene = await createScene(db(), { isSandbox: true });
    const { deps, clock } = testDeps(db());
    const { account, vendor, rail } = stripeSetup(clock);
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ tool: "mpp.pay", amountMicros: REPORT }) }, withStripe(deps, rail));
    expect(response.body.rail_ref).toMatch(/^mock_tx_/);
    expect(vendor.requests).toEqual([]);
    expect(account.payerCalls).toEqual([]);
  });

  it("RAIL-21, RES-3: an unknown mpp.pay outcome that did charge is settled by the reconciler with the PaymentIntent ID", async () => {
    const scene = await createScene(db());
    const clock = new FakeClock();
    const { deps } = testDeps(db(), { clock });
    const { account, vendor } = stripeSetup(clock);
    // The vendor charges the SPT, but its answer is lost on the way back.
    const lossy = (async (url: string, init?: RequestInit) => {
      const response = await vendor.fetchFn(url, init);
      return new Headers(init?.headers).has("authorization") ? new Response("{}", { status: 504 }) : response;
    }) as typeof fetch;
    const flow = withStripe(deps, new StripeMppRail({ api: account.api(), profileId: PROFILE, fetch: lossy, now: clock.now }));
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ tool: "mpp.pay", amountMicros: REPORT }) }, flow);
    expect(response).toMatchObject({ status: 202, body: { rail_status: "unknown" } });
    expect(account.paymentIntents).toHaveLength(1);

    clock.advance(STALE_AFTER_MS + 60_000);
    expect(await reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: flow.railFor, log: () => {} }, { agentId: scene.agent.id })).toMatchObject({ settled: 1 });
    const [reservation] = await reservationsOf(scene.agent.id);
    expect(reservation?.status).toBe("settled");
    const reconciled = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "rail_result").at(-1);
    expect(reconciled?.payload).toMatchObject({ status: "settled", reconciled: true, rail_ref: account.paymentIntents[0]?.id, settled_micros: "500000" });
  });

  it("RAIL-21, RES-5: an unknown mpp.pay outcome with no payment found stays reserved: Stripe absence proves nothing", async () => {
    const scene = await createScene(db());
    const clock = new FakeClock();
    const { deps } = testDeps(db(), { clock });
    // The vendor never charges and answers 504: nothing was paid, but the adapter can't know.
    const { account, rail } = stripeSetup(clock, { paid: () => new Response("{}", { status: 504 }) });
    const flow = withStripe(deps, rail);
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ tool: "mpp.pay", amountMicros: REPORT }) }, flow);
    expect(account.paymentIntents).toHaveLength(0);

    for (const later of [STALE_AFTER_MS + 60_000, 24 * 60 * 60_000]) {
      clock.advance(later);
      expect(await reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: flow.railFor, log: () => {} }, { agentId: scene.agent.id })).toMatchObject({ checked: 1, unknown: 1 });
    }
    expect((await reservationsOf(scene.agent.id))[0]?.status).toBe("reserved");
  });
});
