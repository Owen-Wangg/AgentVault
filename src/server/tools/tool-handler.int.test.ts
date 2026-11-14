import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Envelope } from "@/core/policy";
import { fromDecimalString, micros } from "@/core/money";
import type { MockRails } from "@/rails/select";
import { type Database, queryRows } from "@/server/db/client";
import { approvals, spendReservations } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import {
  FakeClock,
  OPEN_ENVELOPE,
  type Scene,
  createScene,
  eventsOf,
  expectAuditBeforeSpend,
  taintSession,
  testDeps,
} from "@/server/payments/test-fixtures";
import { findTool } from "./registry";
import { type ToolDeps, handleTool } from "./tool-handler";

let database: Database;

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
const ALL_TOOLS = ["x402.pay", "stripe.refund", "wire_transfer", "payout.create", "payee.update"];
const SOURCE = "https://agentvault.example/vendor/docs/integration";

function toolDeps(options: { mocks?: MockRails; clock?: FakeClock } = {}) {
  const { deps, mocks, clock } = testDeps(db(), options);
  const tool: ToolDeps = { openDb: () => ({ db: db(), close: async () => {} }), key: () => deps.key, now: deps.now, railFor: deps.railFor };
  return { tool, mocks, clock };
}

/** A billing scene: a task that allows every tool, with the given envelope. */
const billingScene = (envelope: Omit<Envelope, "agentId"> = OPEN_ENVELOPE) =>
  createScene(db(), { envelope, task: { allowedTools: ALL_TOOLS, budgetMicros: fromDecimalString("1000") } });

let n = 0;
const nextKey = () => `tool-${(n += 1)}`;

const REFUND_ARGS = { vendor: "nimbus-weather", amount_micros: "5000000", payment_ref: "pi_seed_500" };

function request(scene: Scene, body: Record<string, unknown> = {}, headers: Record<string, string | null> = {}) {
  const h = new Headers({ "content-type": "application/json" });
  const auth = "authorization" in headers ? headers.authorization : `Bearer ${scene.apiKey}`;
  if (auth) h.set("authorization", auth);
  const key = "idempotency-key" in headers ? headers["idempotency-key"] : nextKey();
  if (key) h.set("idempotency-key", key);
  const payload = { tool: "stripe.refund", session_id: scene.sessionId, args: REFUND_ARGS, ...body };
  return new Request("https://agentvault.example/api/v1/tool", { method: "POST", headers: h, body: JSON.stringify(payload) });
}

const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });

async function reservationsOf(agentId: string) {
  return db().select().from(spendReservations).where(eq(spendReservations.agentId, agentId));
}

describe("TAINT-7: privileged tools in an untainted session", () => {
  it("TAINT-7: stripe.refund runs refund() on the rail with the payment reference and settles", async () => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    const r = await read(await handleTool(request(scene), tool));
    expect(r).toMatchObject({ status: 200, body: { decision: "allow", reasons: [], rail_status: "settled", event_seq: 1 } });

    const [record] = mocks.stripe.recorded();
    expect(record).toMatchObject({ kind: "refund", units: 500n, settledMicros: micros(5_000_000n) });
    const [reservation] = await reservationsOf(scene.agent.id);
    expect(reservation).toMatchObject({ tool: "stripe.refund", rail: "stripe", status: "settled", amountMicros: micros(5_000_000n) });
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["decision", "rail_result"]);
    expect(events[0]?.payload).toMatchObject({ request: { tool: "stripe.refund", args: { payment_ref: "pi_seed_500" } } });
    expect(events[1]?.payload).toMatchObject({ status: "settled", rail: "stripe", refund_of: "pi_seed_500", settled_micros: "5000000" });
  });

  it("MON-8, MON-11: a refund counts the full amount but the rail refunds whole cents, rounded down", async () => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    await handleTool(request(scene, { args: { ...REFUND_ARGS, amount_micros: "15000" } }), tool);
    const [reservation] = await reservationsOf(scene.agent.id);
    expect(reservation?.amountMicros).toBe(micros(15_000n));
    expect(mocks.stripe.recorded()[0]).toMatchObject({ kind: "refund", units: 1n, settledMicros: micros(10_000n) });
  });

  it("TAINT-7: the approval threshold still applies", async () => {
    const scene = await billingScene({ ...OPEN_ENVELOPE, limits: { approvalThresholdMicros: fromDecimalString("1") } });
    const { tool, mocks } = toolDeps();
    const r = await read(await handleTool(request(scene), tool));
    expect(r.status).toBe(202);
    expect((r.body.reasons as { code: string }[]).map((x) => x.code)).toEqual(["NEEDS_APPROVAL"]);
    expect(mocks.stripe.calls).toBe(0);
  });

  it("TAINT-7: wire_transfer and payout.create pay on their rail", async () => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    for (const name of ["wire_transfer", "payout.create"]) {
      const r = await read(await handleTool(request(scene, { tool: name, args: { vendor: "nimbus-weather", amount_micros: "2500000" } }), tool));
      expect(r).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled" } });
    }
    expect(mocks.mock.recorded().map((x) => x.kind)).toEqual(["payment", "payment"]);
  });

  it("TAINT-7: payee.update moves no money: no reservation and no rail call", async () => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    const r = await read(await handleTool(request(scene, { tool: "payee.update", args: { vendor: "nimbus-weather", payee_ref: "acct_9X" } }), tool));
    expect(r).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled" } });
    expect(await reservationsOf(scene.agent.id)).toEqual([]);
    expect(mocks.mock.calls + mocks.stripe.calls).toBe(0);
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events[1]?.payload).toMatchObject({ status: "settled", rail: null });
  });
});

describe("TAINT-6: privileged tools in a tainted session", () => {
  it("TAINT-6: stripe.refund is held with HELD_TAINTED and the approval shows the taint source", async () => {
    const scene = await billingScene();
    const at = new Date(Date.UTC(2026, 10, 18, 9, 0));
    await taintSession(db(), scene.sessionId, SOURCE, at);
    const { tool, mocks } = toolDeps();
    const r = await read(await handleTool(request(scene), tool));

    expect(r.status).toBe(202);
    expect(r.body.reasons).toEqual([{ code: "HELD_TAINTED", detail: { tool: "stripe.refund", sourceUrl: SOURCE, taintedAt: at.toISOString() } }]);
    const [approval] = await db().select().from(approvals).where(eq(approvals.id, String(r.body.approval_id)));
    expect(approval?.reasons).toEqual(r.body.reasons);
    // TAINT-9: the approval keeps the full request, including the payment reference, for the re-run (HITL-2, Phase 8).
    expect(approval?.request).toMatchObject({ tool: "stripe.refund", amount_micros: "5000000", args: { payment_ref: "pi_seed_500" } });
    expect(mocks.stripe.calls).toBe(0);
    expect(await reservationsOf(scene.agent.id)).toEqual([]);
  });

  it.each([
    ["wire_transfer", { vendor: "nimbus-weather", amount_micros: "1000000" }],
    ["payout.create", { vendor: "nimbus-weather", amount_micros: "1000000" }],
    ["payee.update", { vendor: "nimbus-weather", payee_ref: "acct_9X" }],
  ])("TAINT-6: %s is held in a tainted session", async (name, args) => {
    const scene = await billingScene();
    await taintSession(db(), scene.sessionId);
    const { tool, mocks } = toolDeps();
    const r = await read(await handleTool(request(scene, { tool: name, args }), tool));
    expect(r).toMatchObject({ status: 202, body: { decision: "hold", reasons: [{ code: "HELD_TAINTED" }] } });
    expect(mocks.mock.calls).toBe(0);
  });

  it("TAINT-6: a deny reason still wins over HELD_TAINTED", async () => {
    const scene = await createScene(db(), { task: { allowedTools: ["x402.pay"] } });
    await taintSession(db(), scene.sessionId);
    const { tool } = toolDeps();
    const r = await read(await handleTool(request(scene), tool));
    expect(r.status).toBe(403);
    expect((r.body.reasons as { code: string }[]).map((x) => x.code)).toEqual(["DENY_INTENT_DRIFT", "HELD_TAINTED"]);
  });
});

describe("TAINT-8, INT-3, INT-6: denials", () => {
  it("TAINT-8: a tool that isn't in the registry is denied and audited", async () => {
    const scene = await billingScene();
    const { tool } = toolDeps();
    const r = await read(await handleTool(request(scene, { tool: "drain_wallet", args: { vendor: "nimbus-weather", amount_micros: "1", to: "acct_9X" } }), tool));
    expect(r).toEqual({
      status: 403,
      body: { decision: "deny", reasons: [{ code: "TOOL_NOT_ALLOWED", detail: { tool: "drain_wallet", reason: "not in the tool registry" } }], event_seq: 1 },
    });
    expect((await eventsOf(db(), scene.workspaceId)).map((e) => e.type)).toEqual(["decision"]);
  });

  it("INT-3: a tool outside the task's tools is denied with DENY_INTENT_DRIFT", async () => {
    const scene = await createScene(db(), { task: { allowedTools: ["x402.pay", "stripe.refund"] } });
    const { tool } = toolDeps();
    const r = await read(await handleTool(request(scene, { tool: "payout.create", args: { vendor: "nimbus-weather", amount_micros: "1" } }), tool));
    expect(r.body.reasons).toEqual([{ code: "DENY_INTENT_DRIFT", detail: { check: "tool", expected: "x402.pay,stripe.refund", actual: "payout.create" } }]);
  });

  it("INT-5, INT-6: a refund to a vendor that isn't registered is denied as the unknown category", async () => {
    const scene = await billingScene();
    const { tool } = toolDeps();
    const r = await read(await handleTool(request(scene, { args: { ...REFUND_ARGS, vendor: "acct-9x-payouts" } }), tool));
    expect(r.body.reasons).toEqual([{ code: "DENY_INTENT_DRIFT", detail: { check: "vendor_category", expected: "weather", actual: "unknown" } }]);
  });
});

describe("POST /api/v1/tool: authentication, validation, idempotency", () => {
  it("PXY-3: a missing key returns 401", async () => {
    const scene = await billingScene();
    const { tool } = toolDeps();
    expect((await read(await handleTool(request(scene, {}, { authorization: null }), tool))).status).toBe(401);
  });

  it("rejects a missing Idempotency-Key with 400", async () => {
    const scene = await billingScene();
    const { tool } = toolDeps();
    expect((await read(await handleTool(request(scene, {}, { "idempotency-key": null }), tool))).body.error).toBe("INVALID_IDEMPOTENCY_KEY");
  });

  it.each<[string, Record<string, unknown>]>([
    ["a plain payment tool", { tool: "x402.pay", args: { vendor: "nimbus-weather", amount_micros: "1500" } }],
    ["a refund without a payment reference", { args: { vendor: "nimbus-weather", amount_micros: "1" } }],
    ["a payment reference with spaces", { args: { ...REFUND_ARGS, payment_ref: "pi 1" } }],
    ["an unknown argument", { args: { ...REFUND_ARGS, destination: "acct_9X" } }],
    ["an argument named __proto__", { args: JSON.parse(`{"vendor":"nimbus-weather","amount_micros":"1","payment_ref":"pi_1","__proto__":{"x":1}}`) }],
    ["a number amount (MON-4)", { args: { ...REFUND_ARGS, amount_micros: 5000000 } }],
    ["a negative amount", { args: { ...REFUND_ARGS, amount_micros: "-1" } }],
    ["args that aren't an object", { args: "refund everything" }],
    ["an unknown tool without a vendor", { tool: "drain_wallet", args: { amount_micros: "1" } }],
    ["a tool name with spaces", { tool: "stripe refund" }],
    ["an unknown body field", { vendor: "nimbus-weather" }],
  ])("security §8: rejects %s with 400 before evaluating", async (_name, body) => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    const r = await read(await handleTool(request(scene, body), tool));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVALID_REQUEST");
    expect(mocks.stripe.calls).toBe(0);
    const claims = await queryRows<{ n: number }>(db(), sql`SELECT count(*)::int AS n FROM idempotency WHERE agent_id = ${scene.agent.id}`);
    expect(claims[0]?.n).toBe(0);
  });

  it("PXY-8: a replay returns the original response and refunds once", async () => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    const first = await read(await handleTool(request(scene, {}, { "idempotency-key": "same-refund" }), tool));
    const second = await read(await handleTool(request(scene, {}, { "idempotency-key": "same-refund" }), tool));
    expect(second).toEqual(first);
    expect(mocks.stripe.calls).toBe(1);
  });

  it("PXY-12: the same key with a different payment reference returns 422", async () => {
    const scene = await billingScene();
    const { tool, mocks } = toolDeps();
    await handleTool(request(scene, {}, { "idempotency-key": "ref-reuse" }), tool);
    const r = await read(await handleTool(request(scene, { args: { ...REFUND_ARGS, payment_ref: "pi_other" } }, { "idempotency-key": "ref-reuse" }), tool));
    expect(r).toEqual({ status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } });
    expect(mocks.stripe.calls).toBe(1);
  });

  it("every registered tool except the plain payments has an argument schema on this route", async () => {
    const scene = await billingScene();
    const { tool } = toolDeps();
    for (const name of ["stripe.refund", "wire_transfer", "payout.create", "payee.update"]) {
      expect(findTool(name)).toBeDefined();
      const r = await handleTool(request(scene, { tool: name, args: {} }), tool);
      // A schema exists, so empty args are a 400, not a 503 from the missing-schema guard.
      expect(r.status).toBe(400);
    }
  });
});
