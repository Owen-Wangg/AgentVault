import { decodePaymentSignatureHeader } from "@x402/core/http";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { MockRail } from "@/rails/mock";
import type { RailAdapter, RailContext } from "@/rails/types";
import { X402Rail, authorizationDeadline } from "@/rails/x402/adapter";
import { type FakeChainState, TX, fakeChain, fakeVendor } from "@/rails/x402/test-fixtures";
import { spendReservations, vendors } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type GuardedDeps, runGuardedRequest } from "./guarded";
import { STALE_AFTER_MS, reconcile } from "./reconcile";
import { FakeClock, SCENE_X402_URL, createScene, eventsOf, expectAuditBeforeSpend, testDeps } from "./test-fixtures";

/**
 * The x402 adapter inside the pay flow (rail-adapters task 5): the vendor
 * and the chain are fakes, everything else is the real flow on Postgres.
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
const nextKey = () => `x402-${(n += 1)}`;
const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
const seconds = (d: Date) => BigInt(d.getTime()) / 1000n;

/** Route x402 to `adapter`, as railOptions() does in real mode, and the rest to the usual mocks. */
function withX402(base: GuardedDeps, adapter: RailAdapter): GuardedDeps {
  return { ...base, railFor: (rail, workspace) => (rail === "x402" && !workspace.isSandbox ? adapter : base.railFor(rail, workspace)) };
}

async function reservationOf(agentId: string) {
  const [row] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, agentId));
  return row!;
}

describe("x402 in the pay flow", () => {
  it("RAIL-12: a settled x402 payment records the transaction hash and the explorer link in rail_result and the response", async () => {
    const scene = await createScene(db());
    const { deps, clock } = testDeps(db());
    const vendor = fakeVendor(1500n);
    const rail = new X402Rail({ account, minUnits: 1000n, fetch: vendor.fetchFn, now: clock.now });
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, withX402(deps, rail));

    expect(response).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled", rail_ref: TX, explorer_url: `https://sepolia.basescan.org/tx/${TX}` } });
    const result = (await eventsOf(db(), scene.workspaceId)).find((e) => e.type === "rail_result");
    expect(result?.payload).toMatchObject({ status: "settled", rail: "x402", rail_ref: TX, explorer_url: `https://sepolia.basescan.org/tx/${TX}`, settled_micros: "1500" });
    expect((await reservationOf(scene.agent.id)).status).toBe("settled");
  });

  it("RAIL-23: an allowed x402.pay goes to the vendor's registered x402_url", async () => {
    const scene = await createScene(db());
    const { deps, clock } = testDeps(db());
    const vendor = fakeVendor(1500n);
    const urls: string[] = [];
    const fetchFn = ((url: string, init?: RequestInit) => (urls.push(url), vendor.fetchFn(url, init))) as typeof fetch;
    const rail = new X402Rail({ account, minUnits: 1000n, fetch: fetchFn, now: clock.now });
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, withX402(deps, rail));
    expect(response).toMatchObject({ status: 200, body: { rail_status: "settled" } });
    expect(urls).toEqual([SCENE_X402_URL, SCENE_X402_URL]);
  });

  it("RAIL-24: a vendor with no x402_url fails closed with RAIL_REJECTED, contacts no one, and releases the reservation", async () => {
    const scene = await createScene(db());
    await db().insert(vendors).values({ workspaceId: scene.workspaceId, name: "plain-weather", origin: "https://plain.example", category: "weather", trusted: false });
    const { deps, clock } = testDeps(db());
    const vendor = fakeVendor(1500n);
    const rail = new X402Rail({ account, minUnits: 1000n, fetch: vendor.fetchFn, now: clock.now });
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ vendor: "plain-weather" }) }, withX402(deps, rail));
    expect(vendor.requests).toEqual([]);
    const result = (await eventsOf(db(), scene.workspaceId)).find((e) => e.type === "rail_result");
    expect(result?.payload).toMatchObject({ status: "failed", rail: "x402", code: "RAIL_REJECTED" });
    expect((await reservationOf(scene.agent.id)).status).toBe("released");
  });

  it("RAIL-25: the database refuses a payment URL outside the vendor's origin", async () => {
    const scene = await createScene(db());
    const row = { workspaceId: scene.workspaceId, origin: "https://pay.example", category: "weather", trusted: false };
    await expect(db().insert(vendors).values({ ...row, name: "lookalike-host", x402Url: "https://pay.example.evil.test/pay" })).rejects.toThrow();
    await expect(db().insert(vendors).values({ ...row, name: "other-origin", mppUrl: "https://elsewhere.example/pay" })).rejects.toThrow();
    await expect(db().insert(vendors).values({ ...row, name: "bare-origin", x402Url: "https://pay.example" })).rejects.toThrow();
    await db().insert(vendors).values({ ...row, name: "on-origin", x402Url: "https://pay.example/x402", mppUrl: "https://pay.example/mpp" });
  });

  it("RAIL-2: a sandbox workspace never reaches the x402 adapter", async () => {
    const scene = await createScene(db(), { isSandbox: true });
    const { deps } = testDeps(db());
    const vendor = fakeVendor(1500n);
    const rail = new X402Rail({ account, minUnits: 1000n, fetch: vendor.fetchFn });
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, withX402(deps, rail));
    expect(response.body.rail_ref).toMatch(/^mock_tx_/);
    expect(vendor.requests).toEqual([]);
  });

  it("RAIL-21: execute() and the reconciler's lookup() both get the reservation's created_at as reservedAt", async () => {
    const scene = await createScene(db());
    const clock = new FakeClock();
    const { deps } = testDeps(db(), { clock });
    const seen: { method: string; ctx: RailContext }[] = [];
    const inner = new MockRail("x402", 1n);
    inner.setFailureMode("RAIL_TIMEOUT");
    const spy: RailAdapter = {
      rail: "x402",
      minimumUnits: 1n,
      quote: (r) => inner.quote(r),
      execute: (r, ctx = {}) => (seen.push({ method: "execute", ctx }), inner.execute(r, ctx)),
      refund: (r, ctx = {}) => inner.refund(r, ctx),
      payout: (r, ctx = {}) => inner.payout(r, ctx),
      checkDestination: (d) => inner.checkDestination(d),
      lookup: (k, ctx = {}) => (seen.push({ method: "lookup", ctx }), inner.lookup(k)),
    };
    const flow = withX402(deps, spy);
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, flow);
    const reservedAt = (await reservationOf(scene.agent.id)).createdAt;

    clock.advance(STALE_AFTER_MS + 1000);
    await reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: flow.railFor, log: () => {} }, { agentId: scene.agent.id });
    expect(seen.map((s) => s.method)).toEqual(["execute", "lookup"]);
    for (const s of seen) expect(s.ctx.reservedAt?.getTime()).toBe(reservedAt.getTime());
  });

  it("RAIL-21, RES-4, RES-5: an unknown x402 outcome stays reserved until the chain proves the authorization expired unused", async () => {
    const scene = await createScene(db());
    const clock = new FakeClock();
    const { deps } = testDeps(db(), { clock });
    // The vendor answers 402 to the paid retry, so the payment's fate is unknown.
    const vendor = fakeVendor(1500n, { paid: () => new Response("{}", { status: 402 }) });
    const start = seconds(clock.now());
    const state = { payer: account.address, latestTs: start + 5n, finalizedTs: start - 1200n };
    const { chain } = fakeChain(state);
    const rail = new X402Rail({ account, minUnits: 1000n, fetch: vendor.fetchFn, chain, now: clock.now });
    const flow = withX402(deps, rail);
    const response = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, flow);
    expect(response).toMatchObject({ status: 202, body: { rail_status: "unknown" } });

    const rec = () => reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: flow.railFor, log: () => {} }, { agentId: scene.agent.id });
    const deadline = authorizationDeadline((await reservationOf(scene.agent.id)).createdAt);

    // 11 minutes later the deadline has passed on the chain, but not in the finalized state yet.
    clock.advance(STALE_AFTER_MS + 60_000);
    Object.assign(state, { latestTs: seconds(clock.now()), finalizedTs: deadline - 1n });
    expect(await rec()).toMatchObject({ checked: 1, unknown: 1, released: 0 });
    expect((await reservationOf(scene.agent.id)).status).toBe("reserved");

    // Once the finalized block reaches the deadline with the nonce unused, it's proven: release.
    clock.advance(20 * 60_000);
    Object.assign(state, { latestTs: seconds(clock.now()), finalizedTs: deadline });
    expect(await rec()).toMatchObject({ checked: 1, released: 1 });
    expect((await reservationOf(scene.agent.id)).status).toBe("released");
  });

  it("RAIL-21, RES-3: an unknown x402 outcome that did settle on-chain is settled with the hash the chain shows", async () => {
    const scene = await createScene(db());
    const clock = new FakeClock();
    const { deps } = testDeps(db(), { clock });
    const vendor = fakeVendor(1500n, { paid: () => new Response("{}", { status: 504 }) });
    const start = seconds(clock.now());
    const state: FakeChainState = { payer: account.address, latestTs: start + 5n, finalizedTs: start - 1200n, usedAt: start + 2n };
    const { chain } = fakeChain(state);
    const flow = withX402(deps, new X402Rail({ account, minUnits: 1000n, fetch: vendor.fetchFn, chain, now: clock.now }));
    await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, flow);

    clock.advance(STALE_AFTER_MS + 60_000);
    // The facilitator submitted exactly what was signed, so the chain used the nonce in the vendor's PAYMENT-SIGNATURE.
    const signed = decodePaymentSignatureHeader(vendor.requests[1]?.signature ?? "").payload as { authorization: { nonce: string } };
    Object.assign(state, { latestTs: seconds(clock.now()), nonce: signed.authorization.nonce });
    expect(await reconcile({ db: db(), key: TEST_HEAD_KEY, now: clock.now, railFor: flow.railFor, log: () => {} }, { agentId: scene.agent.id })).toMatchObject({ settled: 1 });
    const reconciled = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "rail_result").at(-1);
    expect(reconciled?.payload).toMatchObject({ status: "settled", reconciled: true, rail_ref: TX, explorer_url: `https://sepolia.basescan.org/tx/${TX}`, settled_micros: "1500" });
  });
});
