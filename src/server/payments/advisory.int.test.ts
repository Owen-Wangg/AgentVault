import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { type HumanRouteDeps, handleApprovalAction } from "@/server/approvals/handlers";
import { type Database } from "@/server/db/client";
import { approvals } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { handleTool } from "@/server/tools/tool-handler";
import { handlePay } from "./pay-handler";
import { OPEN_ENVELOPE, type Scene, createScene, eventsOf, expectAuditBeforeSpend, taintSession, testDeps } from "./test-fixtures";

/**
 * The advisory drift score on the agent API (taint-and-intent INT-7 to
 * INT-9, demo-agents AGT-16): accepted on pay and tool requests, stored
 * with the decision and the approval, and reused by an approved re-run.
 */

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
let n = 0;
const nextKey = () => `adv-${(n += 1)}`;

function harness() {
  const { deps, mocks, clock } = testDeps(db());
  const openDb = () => ({ db: db(), close: async () => {} });
  const agentRoute = { openDb, key: () => TEST_HEAD_KEY, now: clock.now, railFor: deps.railFor };
  const human: HumanRouteDeps = {
    openDb,
    key: () => TEST_HEAD_KEY,
    now: clock.now,
    railFor: deps.railFor,
    getUser: async () => null,
    rateLimit: { limit: 1_000_000, windowMs: 60_000 },
  };
  return { mocks, agentRoute, human };
}

type Body = { decision?: string; reasons?: { code: string; detail?: Record<string, string> }[]; approval_id?: string; error?: string };

async function pay(scene: Scene, h: ReturnType<typeof harness>, extra: Record<string, unknown>, key = nextKey()) {
  const response = await handlePay(
    new Request("https://agentvault.example/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${scene.apiKey}`, "idempotency-key": key },
      body: JSON.stringify({ vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", session_id: scene.sessionId, ...extra }),
    }),
    h.agentRoute,
  );
  return { status: response.status, body: (await response.json()) as Body };
}

async function refund(scene: Scene, h: ReturnType<typeof harness>, extra: Record<string, unknown>) {
  const response = await handleTool(
    new Request("https://agentvault.example/api/v1/tool", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${scene.apiKey}`, "idempotency-key": nextKey() },
      body: JSON.stringify({
        tool: "stripe.refund",
        session_id: scene.sessionId,
        args: { vendor: "nimbus-weather", amount_micros: "480000000", payment_ref: "pi_seed_500" },
        ...extra,
      }),
    }),
    h.agentRoute,
  );
  return { status: response.status, body: (await response.json()) as Body };
}

const approve = (id: string, h: ReturnType<typeof harness>) =>
  handleApprovalAction(
    new Request(`https://agentvault.example/api/v1/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    }),
    id,
    h.human,
  );

const codes = (b: Body) => (b.reasons ?? []).map((r) => r.code);

describe("INT-7: the agent API accepts an advisory drift score", () => {
  it("INT-8: a pay request with a score at the threshold is held with ADVISORY_DRIFT and the score is audited", async () => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true });
    const h = harness();
    const r = await pay(scene, h, { advisory_drift_score: 70 });
    expect(r.status).toBe(202);
    expect(r.body.decision).toBe("hold");
    expect(r.body.reasons).toEqual([{ code: "ADVISORY_DRIFT", detail: { score: "70", threshold: "70" } }]);
    expect(h.mocks.x402.calls).toBe(0);

    const decision = (await eventsOf(db(), scene.workspaceId)).find((e) => e.type === "decision");
    expect((decision?.payload as { request: Record<string, unknown> }).request.advisory_drift_score).toBe(70);
    const [approval] = await db().select().from(approvals).where(eq(approvals.id, r.body.approval_id!));
    expect((approval?.request as Record<string, unknown>).advisory_drift_score).toBe(70);
  });

  it("INT-8: a score below the threshold changes nothing", async () => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true });
    const h = harness();
    const r = await pay(scene, h, { advisory_drift_score: 69 });
    expect(r).toMatchObject({ status: 200, body: { decision: "allow", reasons: [] } });
    expect(h.mocks.x402.calls).toBe(1);
  });

  it.each([101, -1, 7.5, "80", null])("INT-7: a score of %j is rejected with 400 before anything is decided", async (score) => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true });
    const h = harness();
    const before = (await eventsOf(db(), scene.workspaceId)).length;
    const r = await pay(scene, h, { advisory_drift_score: score });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVALID_REQUEST");
    expect((await eventsOf(db(), scene.workspaceId)).length).toBe(before);
  });

  it("PXY-12: the score is part of the request, so reusing a key with another score is 422", async () => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true });
    const h = harness();
    const key = nextKey();
    expect((await pay(scene, h, { advisory_drift_score: 10 }, key)).status).toBe(200);
    expect(await pay(scene, h, { advisory_drift_score: 90 }, key)).toEqual({ status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await pay(scene, h, {}, key)).toEqual({ status: 422, body: { error: "IDEMPOTENCY_KEY_REUSED" } });
    expect(h.mocks.x402.calls).toBe(1);
  });

  it("INT-9: a low score on a tainted refund leaves the HELD_TAINTED hold in place", async () => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true, task: { allowedTools: ["stripe.refund"] } });
    await taintSession(db(), scene.sessionId);
    const h = harness();
    const r = await refund(scene, h, { advisory_drift_score: 0 });
    expect(r.status).toBe(202);
    expect(codes(r.body)).toEqual(["HELD_TAINTED"]);
    expect(h.mocks.stripe.calls).toBe(0);
  });

  it("INT-8: a high score on a tool request adds ADVISORY_DRIFT next to HELD_TAINTED", async () => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true, task: { allowedTools: ["stripe.refund"] } });
    await taintSession(db(), scene.sessionId);
    const h = harness();
    const r = await refund(scene, h, { advisory_drift_score: 85 });
    expect(codes(r.body)).toEqual(["HELD_TAINTED", "ADVISORY_DRIFT"]);
  });

  it("HITL-2: approving an ADVISORY_DRIFT hold re-runs with the stored score and executes once", async () => {
    const scene = await createScene(db(), { envelope: OPEN_ENVELOPE, isSandbox: true });
    const h = harness();
    const held = await pay(scene, h, { advisory_drift_score: 95 });
    const id = held.body.approval_id!;
    const r = await approve(id, h);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ approval_id: id, status: "executed" });
    expect(h.mocks.x402.calls).toBe(1);

    const rerun = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "decision").at(-1);
    const payload = rerun?.payload as { request: Record<string, unknown>; decision: string; approved_hold_reasons: string[] };
    expect(payload.decision).toBe("allow");
    expect(payload.request.advisory_drift_score).toBe(95);
    expect(payload.approved_hold_reasons).toEqual(["ADVISORY_DRIFT"]);
  });
});
