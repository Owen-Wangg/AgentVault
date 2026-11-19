import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import type { Envelope } from "@/core/policy";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { MockRails } from "@/rails/select";
import type { RailAdapter } from "@/rails/types";
import { actOnApproval } from "@/server/approvals/service";
import { verifyChain } from "@/server/audit/append";
import type { Database } from "@/server/db/client";
import { spendReservations, vendors } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type GuardedBody, type GuardedDeps, runGuardedRequest } from "./guarded";
import { STALE_AFTER_MS, reconcile } from "./reconcile";
import { OPEN_ENVELOPE, type Scene, createScene, eventsOf, expectAuditBeforeSpend, taintSession, testDeps } from "./test-fixtures";

/**
 * payout-rails task 4: payouts read their destination from the registry
 * when they run, and payee.update changes it only after the decision
 * commits and the new destination passes the rail's check (PO-4, PO-11
 * to PO-13, PO-20, PO-24).
 */

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

const SUPPLIER_ACCT = "acct_1AcmeSupplies";
const ATTACKER_ACCT = "acct_1AttackerSandbox";
const SUPPLIER_PAYPAL = "supplier@personal.example.com";
const ATTACKER_PAYPAL = "attacker@personal.example.com";
const PAYOUT_TOOLS = ["payout.create", "paypal.payout", "payee.update"];

let n = 0;
const nextKey = () => `payout-${(n += 1)}`;

/** A scene with the supplier acme-supplies, whose task is paying it. */
async function supplierScene(options: { envelope?: Omit<Envelope, "agentId">; isSandbox?: boolean; categories?: string[] } = {}) {
  const scene = await createScene(db(), {
    envelope: options.envelope ?? OPEN_ENVELOPE,
    isSandbox: options.isSandbox ?? true,
    task: { allowedVendorCategories: options.categories ?? ["suppliers"], allowedTools: PAYOUT_TOOLS, budgetMicros: fromDecimalString("2000") },
  });
  await db().insert(vendors).values({
    workspaceId: scene.workspaceId,
    name: "acme-supplies",
    origin: "https://acme-supplies.example",
    category: "suppliers",
    trusted: false,
    stripeAccount: SUPPLIER_ACCT,
    paypalReceiver: SUPPLIER_PAYPAL,
  });
  return scene;
}

const payoutBody = (scene: Scene, tool: string, amount: string, over: Partial<GuardedBody> = {}): GuardedBody => ({
  vendor: "acme-supplies",
  tool,
  amountMicros: fromDecimalString(amount),
  sessionId: scene.sessionId,
  ...over,
});
const payeeBody = (scene: Scene, ref: string, rail = "stripe"): GuardedBody => ({
  vendor: "acme-supplies",
  tool: "payee.update",
  amountMicros: micros(0n),
  sessionId: scene.sessionId,
  args: { payee_ref: ref, rail },
});

async function destinationsOf(workspaceId: string) {
  const [row] = await db()
    .select({ stripe: vendors.stripeAccount, paypal: vendors.paypalReceiver })
    .from(vendors)
    .where(and(eq(vendors.workspaceId, workspaceId), eq(vendors.name, "acme-supplies")));
  return row;
}

const run = (scene: Scene, deps: GuardedDeps, body: GuardedBody) => runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body }, deps);

const approve = (deps: GuardedDeps, scene: Scene, approvalId: string, action: "approve" | "deny" = "approve") =>
  actOnApproval({ db: deps.db, key: deps.key, now: deps.now, railFor: deps.railFor }, { approvalId, workspaceId: scene.workspaceId, action, actor: "tester" });

describe("PO-2, PO-4: payouts go to the registered destination", () => {
  it("PO-2, PO-4: an allowed payout.create pays the vendor's Stripe account through payout()", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const r = await run(scene, deps, payoutBody(scene, "payout.create", "900"));
    expect(r).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled" } });
    expect(mocks.stripe.recorded()).toMatchObject([{ kind: "payout", destination: SUPPLIER_ACCT, units: 90_000n }]);
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.at(-1)?.payload).toMatchObject({ status: "settled", rail: "stripe", payout_to: SUPPLIER_ACCT, settled_micros: "900000000" });
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation).toMatchObject({ tool: "payout.create", rail: "stripe", status: "settled", amountMicros: micros(900_000_000n) });
  });

  it("PO-14, PO-4: an allowed paypal.payout pays the vendor's PayPal receiver", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const r = await run(scene, deps, payoutBody(scene, "paypal.payout", "1"));
    expect(r.body.rail_status).toBe("settled");
    expect(mocks.paypal.recorded()).toMatchObject([{ kind: "payout", destination: SUPPLIER_PAYPAL, units: 100n }]);
    expect(mocks.stripe.calls).toBe(0);
  });

  it("PO-4: a destination in the request's arguments is ignored", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    await run(scene, deps, payoutBody(scene, "payout.create", "5", { args: { destination: ATTACKER_ACCT, payee_ref: ATTACKER_ACCT } }));
    expect(mocks.stripe.recorded()).toMatchObject([{ destination: SUPPLIER_ACCT }]);
  });

  it("PO-4: a payee with no destination on the rail fails closed without a rail call and releases the reservation", async () => {
    const scene = await supplierScene();
    await db().update(vendors).set({ paypalReceiver: null }).where(eq(vendors.workspaceId, scene.workspaceId));
    const { deps, mocks } = testDeps(db());
    const r = await run(scene, deps, payoutBody(scene, "paypal.payout", "1"));
    expect(r).toMatchObject({ status: 502, body: { rail_status: "failed", error: "RAIL_REJECTED" } });
    expect(mocks.paypal.calls).toBe(0);
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation?.status).toBe("released");
  });

  it("PO-3: a sub-cent payout pays the payee less and counts the full amount", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    await run(scene, deps, payoutBody(scene, "payout.create", "1.019999"));
    expect(mocks.stripe.recorded()).toMatchObject([{ units: 101n, settledMicros: micros(1_010_000n) }]);
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation?.amountMicros).toBe(micros(1_019_999n));
  });
});

describe("PO-11 to PO-13: payee.update", () => {
  it("PO-11, PO-12: an allowed change stores the new destination with rail_result and payee_updated, and moves no money", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const r = await run(scene, deps, payeeBody(scene, "acct_1NewSupplierBank"));
    expect(r).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled", rail_ref: "acct_1NewSupplierBank" } });
    expect(await destinationsOf(scene.workspaceId)).toEqual({ stripe: "acct_1NewSupplierBank", paypal: SUPPLIER_PAYPAL });
    const events = await eventsOf(db(), scene.workspaceId);
    const decisionSeq = events.find((e) => e.type === "decision")?.seq;
    expect(events.slice(-2).map((e) => [e.type, e.payload])).toEqual([
      ["rail_result", { status: "settled", rail: "stripe", decision_seq: decisionSeq, rail_ref: "acct_1NewSupplierBank" }],
      ["payee_updated", { vendor: "acme-supplies", rail: "stripe", old_ref: SUPPLIER_ACCT, new_ref: "acct_1NewSupplierBank", decision_seq: decisionSeq }],
    ]);
    expect(mocks.stripe.recorded()).toEqual([]);
    expect(await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id))).toEqual([]);
  });

  it("PO-10, PO-12: a PayPal change updates only the PayPal receiver", async () => {
    const scene = await supplierScene();
    const { deps } = testDeps(db());
    await run(scene, deps, payeeBody(scene, "new-supplier@business.example.com", "paypal"));
    expect(await destinationsOf(scene.workspaceId)).toEqual({ stripe: SUPPLIER_ACCT, paypal: "new-supplier@business.example.com" });
  });

  it("PO-11: the destination is checked after the decision committed, while the row still holds the old value", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const seen: { decisionCommitted: boolean; destination: string | null | undefined }[] = [];
    const spy: RailAdapter = Object.assign(Object.create(mocks.stripe) as RailAdapter, {
      checkDestination: async (d: string) => {
        const events = await eventsOf(db(), scene.workspaceId);
        seen.push({ decisionCommitted: events.some((e) => e.type === "decision"), destination: (await destinationsOf(scene.workspaceId))?.stripe });
        return mocks.stripe.checkDestination(d);
      },
    });
    await run(scene, { ...deps, railFor: () => spy }, payeeBody(scene, "acct_1NewSupplierBank"));
    expect(seen).toEqual([{ decisionCommitted: true, destination: SUPPLIER_ACCT }]);
  });

  it("PO-13: a destination that fails the check changes nothing and records RAIL_REJECTED", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const refusing: RailAdapter = Object.assign(Object.create(mocks.stripe) as RailAdapter, {
      checkDestination: async () => ({ ok: false as const, code: "RAIL_REJECTED" as const, detail: "transfers capability not active" }),
    });
    const r = await run(scene, { ...deps, railFor: () => refusing }, payeeBody(scene, ATTACKER_ACCT));
    expect(r).toMatchObject({ status: 502, body: { decision: "allow", rail_status: "failed", error: "RAIL_REJECTED" } });
    expect(await destinationsOf(scene.workspaceId)).toEqual({ stripe: SUPPLIER_ACCT, paypal: SUPPLIER_PAYPAL });
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).not.toContain("payee_updated");
    expect(events.at(-1)?.payload).toMatchObject({ status: "failed", code: "RAIL_REJECTED" });
  });

  it("PO-13: a check that throws changes nothing", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const throwing: RailAdapter = Object.assign(Object.create(mocks.stripe) as RailAdapter, {
      checkDestination: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const r = await run(scene, { ...deps, railFor: () => throwing }, payeeBody(scene, ATTACKER_ACCT));
    expect(r.body).toMatchObject({ rail_status: "failed", error: "RAIL_EXCEPTION" });
    expect((await destinationsOf(scene.workspaceId))?.stripe).toBe(SUPPLIER_ACCT);
  });

  it("PO-11, INT-6: a payee that isn't in the registry is denied and never created", async () => {
    const scene = await supplierScene({ categories: ["suppliers", "unknown"] });
    const { deps } = testDeps(db());
    const r = await run(scene, deps, { ...payeeBody(scene, ATTACKER_ACCT), vendor: "no-such-supplier" });
    expect(r.body).toMatchObject({ decision: "deny" });
    expect(await db().select().from(vendors).where(and(eq(vendors.workspaceId, scene.workspaceId), eq(vendors.name, "no-such-supplier")))).toEqual([]);
  });

  it("PO-10: a stored request whose payee_ref doesn't fit its rail is denied as INVALID_REQUEST", async () => {
    const scene = await supplierScene();
    const { deps } = testDeps(db());
    const r = await run(scene, deps, payeeBody(scene, ATTACKER_PAYPAL, "stripe"));
    expect(r).toMatchObject({ status: 403, body: { decision: "deny", reasons: [{ code: "INVALID_REQUEST", detail: { field: "args.payee_ref" } }] } });
    expect((await destinationsOf(scene.workspaceId))?.stripe).toBe(SUPPLIER_ACCT);
  });
});

describe("PO-20: payouts are scoped by the task", () => {
  it.each(["payout.create", "paypal.payout", "payee.update"])("PO-20: %s to a vendor outside the task's categories is denied as intent drift", async (tool) => {
    const scene = await supplierScene({ categories: ["weather"] });
    const { deps, mocks } = testDeps(db());
    const body = tool === "payee.update" ? payeeBody(scene, ATTACKER_ACCT) : payoutBody(scene, tool, "1");
    const r = await run(scene, deps, body);
    expect(r.body).toMatchObject({ decision: "deny", reasons: [{ code: "DENY_INTENT_DRIFT" }] });
    expect(mocks.stripe.calls + mocks.paypal.calls).toBe(0);
  });
});

describe("PO-24: a payout reads its destination when it runs", () => {
  async function hijackAttempt(mocks?: MockRails) {
    const scene = await supplierScene();
    const { deps, mocks: m } = testDeps(db(), mocks ? { mocks } : {});
    await taintSession(db(), scene.sessionId, "https://acme-supplies.example/invoice");
    const change = await run(scene, deps, payeeBody(scene, ATTACKER_ACCT));
    const payout = await run(scene, deps, payoutBody(scene, "payout.create", "900"));
    expect(change.body).toMatchObject({ decision: "hold", reasons: [{ code: "HELD_TAINTED" }] });
    expect(payout.body).toMatchObject({ decision: "hold", reasons: [{ code: "HELD_TAINTED" }] });
    return { scene, deps, mocks: m, changeApproval: change.body.approval_id!, payoutApproval: payout.body.approval_id! };
  }

  it("PO-24: denying the injected payee change and approving the payout pays the original supplier", async () => {
    const { scene, deps, mocks, changeApproval, payoutApproval } = await hijackAttempt();
    expect((await approve(deps, scene, changeApproval, "deny")).body).toMatchObject({ status: "denied" });
    const approved = await approve(deps, scene, payoutApproval);
    expect(approved.body).toMatchObject({ status: "executed", result: { rail_status: "settled" } });
    expect(mocks.stripe.recorded()).toMatchObject([{ kind: "payout", destination: SUPPLIER_ACCT, units: 90_000n }]);
    expect((await destinationsOf(scene.workspaceId))?.stripe).toBe(SUPPLIER_ACCT);
    expect(await verifyChain(db(), scene.workspaceId, { key: TEST_HEAD_KEY })).toMatchObject({ ok: true });
  });

  it("PO-24, PO-11: approving the payee change first sends the payout to the new account, which is why it needs a person", async () => {
    const { scene, deps, mocks, changeApproval, payoutApproval } = await hijackAttempt();
    expect((await approve(deps, scene, changeApproval)).body).toMatchObject({ status: "executed", result: { rail_status: "settled" } });
    expect((await destinationsOf(scene.workspaceId))?.stripe).toBe(ATTACKER_ACCT);
    await approve(deps, scene, payoutApproval);
    expect(mocks.stripe.recorded()).toMatchObject([{ destination: ATTACKER_ACCT }]);
  });

  it("PO-24: the destination is read when the payout runs, not when it was requested or held", async () => {
    const { scene, deps, mocks, payoutApproval } = await hijackAttempt();
    // Someone with database access corrects the supplier's account while the payout waits.
    await db().update(vendors).set({ stripeAccount: "acct_1SupplierNewBank" }).where(eq(vendors.workspaceId, scene.workspaceId));
    await approve(deps, scene, payoutApproval);
    expect(mocks.stripe.recorded()).toMatchObject([{ destination: "acct_1SupplierNewBank" }]);
  });
});

describe("payout-rails design, Vendor registry: destination constraints", () => {
  it("PO-4: the database refuses malformed payout destinations", async () => {
    const scene = await createScene(db());
    const row = { workspaceId: scene.workspaceId, origin: "https://pay.example", category: "suppliers", trusted: false };
    await expect(db().insert(vendors).values({ ...row, name: "bad-acct", stripeAccount: "acct_1-2" })).rejects.toThrow();
    await expect(db().insert(vendors).values({ ...row, name: "not-acct", stripeAccount: "pi_123" })).rejects.toThrow();
    await expect(db().insert(vendors).values({ ...row, name: "bad-email", paypalReceiver: "not-an-email" })).rejects.toThrow();
    await expect(db().insert(vendors).values({ ...row, name: "long-email", paypalReceiver: `${"a".repeat(60)}@${"b".repeat(200)}.com` })).rejects.toThrow();
    // security-standards §7: a PayPal receiver outside the sandbox domains could be a real person.
    await expect(db().insert(vendors).values({ ...row, name: "real-email", paypalReceiver: "someone@gmail.com" })).rejects.toThrow();
    await db().insert(vendors).values({ ...row, name: "good", stripeAccount: SUPPLIER_ACCT, paypalReceiver: SUPPLIER_PAYPAL });
  });
});

describe("PO-25: a payout whose outcome isn't known yet keeps the rail's reference", () => {
  /** The paypal mock, made to answer like a PayPal batch still PENDING after the adapter's wait. */
  function pendingPayPal(mocks: MockRails, lookups: { key: string; railRef: string | undefined }[]) {
    return Object.assign(Object.create(mocks.paypal) as RailAdapter, {
      payout: async () => ({ ok: false as const, code: "RAIL_TIMEOUT" as const, detail: "PayPal still reports the payout PENDING", pendingRef: "BATCH7NTGZG9" }),
      lookup: async (key: string, ctx: { railRef?: string } = {}) => {
        lookups.push({ key, railRef: ctx.railRef });
        return ctx.railRef === "BATCH7NTGZG9" ? { status: "settled" as const, ref: "ITEM6FAKU6", settledMicros: micros(1_000_000n) } : { status: "unknown" as const };
      },
    });
  }

  it("PO-25: the batch ID is stored on the reservation and in rail_result, and the reservation stays reserved", async () => {
    const scene = await supplierScene();
    const { deps, mocks } = testDeps(db());
    const paypal = pendingPayPal(mocks, []);
    const flow = { ...deps, railFor: (r: Parameters<typeof deps.railFor>[0], w: { isSandbox: boolean }) => (r === "paypal" ? paypal : deps.railFor(r, w)) };
    const r = await run(scene, flow, payoutBody(scene, "paypal.payout", "1"));
    expect(r).toMatchObject({ status: 202, body: { decision: "allow", rail_status: "unknown" } });
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation).toMatchObject({ status: "reserved", railRef: "BATCH7NTGZG9", amountMicros: micros(1_000_000n) });
    expect((await eventsOf(db(), scene.workspaceId)).at(-1)?.payload).toMatchObject({ status: "unknown", code: "RAIL_TIMEOUT", rail_ref: "BATCH7NTGZG9", payout_to: SUPPLIER_PAYPAL });
  });

  it("PO-25: the reconciler passes the stored batch ID to lookup() and settles the reservation", async () => {
    const scene = await supplierScene();
    const { deps, mocks, clock } = testDeps(db());
    const lookups: { key: string; railRef: string | undefined }[] = [];
    const paypal = pendingPayPal(mocks, lookups);
    const flow = { ...deps, railFor: (r: Parameters<typeof deps.railFor>[0], w: { isSandbox: boolean }) => (r === "paypal" ? paypal : deps.railFor(r, w)) };
    await run(scene, flow, payoutBody(scene, "paypal.payout", "1"));
    clock.advance(STALE_AFTER_MS);
    const summary = await reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: flow.railFor, log: () => {} }, { agentId: scene.agent.id });
    expect(summary).toMatchObject({ checked: 1, settled: 1 });
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(lookups).toEqual([{ key: reservation?.id, railRef: "BATCH7NTGZG9" }]);
    expect(reservation).toMatchObject({ status: "settled" });
    expect((await eventsOf(db(), scene.workspaceId)).at(-1)?.payload).toMatchObject({ status: "settled", reconciled: true, rail_ref: "ITEM6FAKU6" });
  });

  it("PO-25: a settled or failed outcome stores no pending reference", async () => {
    const scene = await supplierScene();
    const { deps } = testDeps(db());
    await run(scene, deps, payoutBody(scene, "paypal.payout", "1"));
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation).toMatchObject({ status: "settled", railRef: null });
  });
});