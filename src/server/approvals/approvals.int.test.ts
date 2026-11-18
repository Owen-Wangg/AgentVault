import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Envelope } from "@/core/policy";
import { fromDecimalString, micros } from "@/core/money";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { type MockRails, railFor } from "@/rails/select";
import { verifyChain } from "@/server/audit/append";
import type { SessionUser } from "@/server/auth/session";
import { type Database, queryRows } from "@/server/db/client";
import { encodeEnvelope } from "@/server/db/envelope-json";
import { agents, approvals, envelopes, idempotency, spendReservations, users, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { handlePay } from "@/server/payments/pay-handler";
import { runGuardedRequest } from "@/server/payments/guarded";
import {
  FakeClock,
  MOCK_CONFIG,
  OPEN_ENVELOPE,
  type Scene,
  createScene,
  eventsOf,
  expectAuditBeforeSpend,
  taintSession,
  testDeps,
} from "@/server/payments/test-fixtures";
import { retireSandboxWorkspace } from "@/server/sandbox/sandbox";
import { handleTool } from "@/server/tools/tool-handler";
import { type HumanRouteDeps, handleApprovalAction, handleListApprovals, handleUnfreeze } from "./handlers";

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
const SOURCE = "https://agentvault.example/vendor/docs/integration";
const ALL_TOOLS = ["x402.pay", "stripe.refund", "wire_transfer", "payout.create", "payee.update"];
/** Holds anything over $100, like the sandbox's billing envelope. */
const THRESHOLD_ENVELOPE: Omit<Envelope, "agentId"> = { ...OPEN_ENVELOPE, limits: { approvalThresholdMicros: fromDecimalString("100") } };

let n = 0;
const nextKey = () => `appr-${(n += 1)}`;

interface Harness {
  clock: FakeClock;
  mocks: MockRails;
  human: (over?: Partial<HumanRouteDeps>) => HumanRouteDeps;
  agentRoute: { openDb: HumanRouteDeps["openDb"]; key: () => Uint8Array; now: () => Date; railFor: HumanRouteDeps["railFor"] };
}

function harness(options: { user?: SessionUser | null } = {}): Harness {
  const { deps, mocks, clock } = testDeps(db());
  const openDb = () => ({ db: db(), close: async () => {} });
  const human = (over: Partial<HumanRouteDeps> = {}): HumanRouteDeps => ({
    openDb,
    key: () => TEST_HEAD_KEY,
    now: clock.now,
    railFor: deps.railFor,
    getUser: async () => options.user ?? null,
    // Every harness clock starts at the same minute, so they'd share one rate-limit window.
    // Only the rate-limit test sets a real limit.
    rateLimit: { limit: 1_000_000, windowMs: 60_000 },
    ...over,
  });
  return { clock, mocks, human, agentRoute: { openDb, key: () => TEST_HEAD_KEY, now: clock.now, railFor: deps.railFor } };
}

/** A billing scene whose task allows every tool. */
const billingScene = (options: { envelope?: Omit<Envelope, "agentId">; isSandbox?: boolean } = {}) =>
  createScene(db(), {
    envelope: options.envelope ?? THRESHOLD_ENVELOPE,
    isSandbox: options.isSandbox ?? false,
    task: { allowedTools: ALL_TOOLS, budgetMicros: fromDecimalString("1000") },
  });

async function ownWorkspace(scene: Scene, userId: string): Promise<SessionUser> {
  await db().insert(users).values({ id: userId, name: userId }).onConflictDoNothing();
  await db().update(workspaces).set({ ownerUserId: userId }).where(eq(workspaces.id, scene.workspaceId));
  return { id: userId };
}

const REFUND_ARGS = { vendor: "nimbus-weather", amount_micros: "480000000", payment_ref: "pi_seed_500" };

/** POST /api/v1/tool for the injection scenario's $480 refund. Returns the response and its key. */
async function requestRefund(scene: Scene, h: Harness, key = nextKey()) {
  const response = await handleTool(
    new Request("https://agentvault.example/api/v1/tool", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${scene.apiKey}`, "idempotency-key": key },
      body: JSON.stringify({ tool: "stripe.refund", session_id: scene.sessionId, args: REFUND_ARGS }),
    }),
    h.agentRoute,
  );
  return { key, status: response.status, body: (await response.json()) as { decision: string; reasons: { code: string }[]; approval_id: string } };
}

/** A $480 x402 payment held with NEEDS_APPROVAL. Returns the approval ID. */
async function holdPayment(scene: Scene, h: Harness): Promise<string> {
  const { deps } = testDeps(db(), { mocks: h.mocks, clock: h.clock });
  const r = await runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body({ amountMicros: fromDecimalString("480") }) }, deps);
  expect(r.body.decision).toBe("hold");
  return r.body.approval_id!;
}

function act(id: string, action: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://agentvault.example/api/v1/approvals/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action }),
  });
}

const unfreezeRequest = (agentId: string, headers: Record<string, string> = {}) =>
  new Request(`https://agentvault.example/api/v1/agents/${agentId}/unfreeze`, { method: "POST", headers });

const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });

async function approvalRow(id: string) {
  const [row] = await db().select().from(approvals).where(eq(approvals.id, id));
  return row!;
}

const typesOf = async (workspaceId: string) => (await eventsOf(db(), workspaceId)).map((e) => e.type);

async function freeze(agentId: string, at = new Date()) {
  await db().update(agents).set({ frozenAt: at }).where(eq(agents.id, agentId));
}

describe("HITL-10: approval and unfreeze routes reject agent keys", () => {
  it.each([false, true])("HITL-10: an agent key gets 403 and changes nothing (sandbox: %s)", async (isSandbox) => {
    const scene = await billingScene({ isSandbox });
    const h = harness();
    const id = await holdPayment(scene, h);
    await freeze(scene.agent.id);
    const before = await typesOf(scene.workspaceId);
    const auth = { authorization: `Bearer ${scene.apiKey}` };

    const responses = [
      await handleApprovalAction(act(id, "approve", auth), id, h.human()),
      await handleApprovalAction(act(id, "deny", auth), id, h.human()),
      await handleUnfreeze(unfreezeRequest(scene.agent.id, auth), scene.agent.id, h.human()),
      await handleListApprovals(new Request("https://agentvault.example/api/v1/approvals", { headers: auth }), h.human()),
    ];
    for (const response of responses) expect(await read(response)).toEqual({ status: 403, body: { error: "AGENT_KEY_FORBIDDEN" } });
    expect((await approvalRow(id)).status).toBe("pending");
    expect(await typesOf(scene.workspaceId)).toEqual(before);
    const [agent] = await db().select().from(agents).where(eq(agents.id, scene.agent.id));
    expect(agent?.frozenAt).not.toBeNull();
    expect(h.mocks.x402.calls).toBe(0);

    // Control: the same approve without the key works in the sandbox and is 401 elsewhere.
    expect((await handleApprovalAction(act(id, "approve"), id, h.human())).status).toBe(isSandbox ? 200 : 401);
  });

  it.each(["Bearer not-a-key", "Basic dXNlcjpwYXNz", "bearer av_test_x", ""])(
    "HITL-10: any Authorization header (%j) is 403, even in the sandbox",
    async (authorization) => {
      const scene = await billingScene({ isSandbox: true });
      const h = harness();
      const id = await holdPayment(scene, h);
      const r = await read(await handleApprovalAction(act(id, "approve", { authorization }), id, h.human()));
      expect(r).toEqual({ status: 403, body: { error: "AGENT_KEY_FORBIDDEN" } });
      expect((await approvalRow(id)).status).toBe("pending");
      expect(h.mocks.x402.calls).toBe(0);
    },
  );
});

describe("HITL-11: who may approve", () => {
  it("HITL-11: anyone may approve in the current sandbox, as sandbox_visitor, on mock rails only", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    // A real-mode config with no real adapters: a non-sandbox payment would fail to find a rail.
    const realMode = (rail: Parameters<HumanRouteDeps["railFor"]>[0], ws: { isSandbox: boolean }) =>
      railFor(rail, ws, { config: { ...MOCK_CONFIG, mode: "real" }, mocks: h.mocks });
    const r = await read(await handleApprovalAction(act(id, "approve"), id, h.human({ railFor: realMode })));
    expect(r).toMatchObject({ status: 200, body: { approval_id: id, status: "executed", decided_by: "sandbox_visitor", result: { http_status: 200, rail_status: "settled" } } });
    expect(h.mocks.x402.calls).toBe(1);
    expect((await approvalRow(id)).decidedBy).toBe("sandbox_visitor");
  });

  it("HITL-11: outside the sandbox, no session is 401 and the approval stays pending", async () => {
    const scene = await billingScene();
    const h = harness();
    const id = await holdPayment(scene, h);
    expect(await read(await handleApprovalAction(act(id, "approve"), id, h.human()))).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
    expect(await read(await handleUnfreeze(unfreezeRequest(scene.agent.id), scene.agent.id, h.human()))).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
    expect((await approvalRow(id)).status).toBe("pending");
  });

  it("HITL-11: a signed-in user of another workspace is 403; the owner may act and is the recorded actor", async () => {
    const scene = await billingScene();
    await ownWorkspace(scene, "user-owner");
    const id = await holdPayment(scene, harness());
    const stranger = harness({ user: { id: "user-stranger" } });
    expect(await read(await handleApprovalAction(act(id, "approve"), id, stranger.human()))).toEqual({ status: 403, body: { error: "FORBIDDEN" } });

    const owner = harness({ user: { id: "user-owner" } });
    const r = await read(await handleApprovalAction(act(id, "deny"), id, owner.human()));
    expect(r).toEqual({ status: 200, body: { approval_id: id, status: "denied", decided_by: "user-owner" } });
  });

  it("HITL-11: a retired sandbox is read-only", async () => {
    const old = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(old, h);
    await freeze(old.agent.id);
    const successor = await billingScene({ isSandbox: true });
    await db().transaction((tx) => retireSandboxWorkspace(tx, old.workspaceId, { successorWorkspaceId: successor.workspaceId }, { key: TEST_HEAD_KEY }));

    expect(await read(await handleApprovalAction(act(id, "approve"), id, h.human()))).toEqual({ status: 403, body: { error: "SANDBOX_RETIRED" } });
    expect(await read(await handleUnfreeze(unfreezeRequest(old.agent.id), old.agent.id, h.human()))).toEqual({ status: 403, body: { error: "SANDBOX_RETIRED" } });
    expect((await approvalRow(id)).status).toBe("pending");
  });

  it("security §8: sandbox actions are rate-limited per IP", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const deps = h.human({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const ids = [await holdPayment(scene, h), await holdPayment(scene, h), await holdPayment(scene, h)];
    const ip = { "x-real-ip": "203.0.113.7" };
    const statuses = [];
    for (const id of ids) statuses.push((await handleApprovalAction(act(id, "deny", ip), id, deps)).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect((await approvalRow(ids[2]!)).status).toBe("pending");
    // Another IP has its own bucket, and the raw IP is never stored.
    expect((await handleApprovalAction(act(ids[2]!, "deny", { "x-real-ip": "198.51.100.1" }), ids[2]!, deps)).status).toBe(200);
    const stored = await queryRows<{ key: string }>(db(), sql`SELECT key FROM rate_limits`);
    expect(JSON.stringify(stored)).not.toContain("203.0.113.7");
  });

  it("security §8: listing the sandbox's approvals is rate-limited per IP; a private workspace's owner is not", async () => {
    await billingScene({ isSandbox: true });
    const h = harness();
    const deps = h.human({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const list = (ip: string, d = deps) => handleListApprovals(new Request("https://agentvault.example/api/v1/approvals", { headers: { "x-real-ip": ip } }), d);
    expect([(await list("203.0.113.31")).status, (await list("203.0.113.31")).status]).toEqual([200, 200]);
    expect(await read(await list("203.0.113.31"))).toEqual({ status: 429, body: { error: "RATE_LIMITED" } });
    // Another IP has its own bucket.
    expect((await list("203.0.113.32")).status).toBe(200);

    const own = await billingScene();
    const user = await ownWorkspace(own, "list-limit-owner");
    const ownDeps = harness({ user }).human({ rateLimit: { limit: 0, windowMs: 60_000 } });
    expect((await list("203.0.113.31", ownDeps)).status).toBe(200);
  });

  it("returns 404 for an unknown or malformed approval ID and 400 for a bad action", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    for (const bad of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await handleApprovalAction(act(bad, "approve"), bad, h.human())).status).toBe(404);
    }
    for (const action of ["APPROVE", "execute", 1, null]) {
      expect((await handleApprovalAction(act(id, action), id, h.human())).status).toBe(400);
    }
    expect((await approvalRow(id)).status).toBe("pending");
  });
});

describe("HITL-2, TAINT-9: approving re-runs the full pay flow", () => {
  it("TAINT-9: a held tainted refund, once approved, executes on the rail with its payment reference", async () => {
    const scene = await billingScene({ isSandbox: true });
    await taintSession(db(), scene.sessionId, SOURCE);
    const h = harness();
    const held = await requestRefund(scene, h);
    expect(held.status).toBe(202);
    expect(held.body.reasons.map((r) => r.code)).toEqual(["HELD_TAINTED", "NEEDS_APPROVAL"]);
    const id = held.body.approval_id;

    const r = await read(await handleApprovalAction(act(id, "approve"), id, h.human()));
    expect(r).toMatchObject({ status: 200, body: { status: "executed", result: { http_status: 200, decision: "allow", reasons: [], rail_status: "settled" } } });
    expect(h.mocks.stripe.recorded()).toMatchObject([{ kind: "refund", units: 48_000n }]);

    const row = await approvalRow(id);
    expect(row).toMatchObject({ status: "executed", decidedBy: "sandbox_visitor", recheckReasons: null });
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["decision", "approval_created", "approval_decided", "decision", "approval_executed", "rail_result"]);
    const rerun = events[3]!;
    expect(row.rerunDecisionSeq).toBe(rerun.seq);
    expect(rerun.payload).toMatchObject({
      decision: "allow",
      approval_id: id,
      approved_hold_reasons: ["HELD_TAINTED", "NEEDS_APPROVAL"],
      request: { tool: "stripe.refund", idempotency_key: `approval:${id}`, args: { payment_ref: "pi_seed_500" } },
    });
    expect(events[4]?.payload).toEqual({ approval_id: id, status: "executed", actor: "sandbox_visitor", decision_seq: rerun.seq });
    expect(events[5]?.payload).toMatchObject({ status: "settled", decision_seq: rerun.seq, refund_of: "pi_seed_500" });
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation).toMatchObject({ status: "settled", decisionSeq: rerun.seq, amountMicros: micros(480_000_000n) });

    // The original key still replays the hold, with the approval to follow.
    const replay = await requestRefund(scene, h, held.key);
    expect(replay).toEqual(held);
    expect(h.mocks.stripe.calls).toBe(1);
    expect((await verifyChain(db(), scene.workspaceId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  });

  it("TAINT-9, HITL-3: an approved tainted refund fails its recheck when the envelope no longer allows the tool", async () => {
    const scene = await billingScene({ isSandbox: true });
    await taintSession(db(), scene.sessionId, SOURCE);
    const h = harness();
    const { body } = await requestRefund(scene, h);
    await db()
      .update(envelopes)
      .set(encodeEnvelope({ ...THRESHOLD_ENVELOPE, allowedTools: ["x402.pay"] }))
      .where(eq(envelopes.agentId, scene.agent.id));

    const r = await read(await handleApprovalAction(act(body.approval_id, "approve"), body.approval_id, h.human()));
    const reasons = [{ code: "TOOL_NOT_ALLOWED", detail: { level: "agent", tool: "stripe.refund" } }];
    expect(r).toMatchObject({ status: 200, body: { status: "failed_recheck", reasons: [{ code: "TOOL_NOT_ALLOWED" }], result: { http_status: 403, decision: "deny" } } });
    expect((r.body.reasons as unknown[]).length).toBe(1);
    expect(h.mocks.stripe.calls).toBe(0);
    const row = await approvalRow(body.approval_id);
    expect(row.status).toBe("failed_recheck");
    expect(row.recheckReasons).toMatchObject(reasons.map(({ code }) => ({ code })));
    expect(await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id))).toEqual([]);
  });

  it("HITL-3, PXY-11: approving for an agent frozen in the meantime ends in failed_recheck with AGENT_FROZEN", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    await freeze(scene.agent.id);
    const r = await read(await handleApprovalAction(act(id, "approve"), id, h.human()));
    expect(r).toMatchObject({ status: 200, body: { status: "failed_recheck", reasons: [{ code: "AGENT_FROZEN" }] } });
    expect(h.mocks.x402.calls).toBe(0);
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.at(-1)).toMatchObject({ type: "approval_decided", payload: { approval_id: id, status: "failed_recheck", actor: "sandbox_visitor" } });
  });

  it("HITL-3: a new hold reason nobody approved fails the recheck, and no second approval is created", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    // Held for NEEDS_APPROVAL only; then the session reads a poisoned page.
    const held = await requestRefund(scene, h);
    expect(held.body.reasons.map((r) => r.code)).toEqual(["NEEDS_APPROVAL"]);
    await taintSession(db(), scene.sessionId, SOURCE);

    const r = await read(await handleApprovalAction(act(held.body.approval_id, "approve"), held.body.approval_id, h.human()));
    expect(r).toMatchObject({ status: 200, body: { status: "failed_recheck", reasons: [{ code: "HELD_TAINTED" }], result: { http_status: 202, decision: "hold" } } });
    expect((r.body.result as Record<string, unknown>).approval_id).toBeUndefined();
    expect(h.mocks.stripe.calls).toBe(0);
    const all = await db().select().from(approvals).where(eq(approvals.workspaceId, scene.workspaceId));
    expect(all).toHaveLength(1);
    expect((await typesOf(scene.workspaceId)).filter((t) => t === "approval_created")).toHaveLength(1);
  });

  it("HITL-2: an unknown rail outcome on the re-run still marks the approval executed and keeps the reservation", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    h.mocks.x402.setFailureMode("RAIL_TIMEOUT");
    const r = await read(await handleApprovalAction(act(id, "approve"), id, h.human()));
    expect(r).toMatchObject({ status: 200, body: { status: "executed", result: { http_status: 202, rail_status: "unknown" } } });
    const [reservation] = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservation?.status).toBe("reserved");
  });

  it("HITL-2: the re-run claims the key approval:<id> under the agent", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    await handleApprovalAction(act(id, "approve"), id, h.human());
    const [row] = await db()
      .select()
      .from(idempotency)
      .where(and(eq(idempotency.agentId, scene.agent.id), eq(idempotency.key, `approval:${id}`)));
    expect(row?.response).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled" } });
  });

  it("HITL-7: agents can't claim approval: keys, so a re-run's key is never taken", async () => {
    const scene = await billingScene();
    const h = harness();
    for (const key of ["approval:00000000-0000-4000-8000-000000000000", "Approval:x"]) {
      const response = await handlePay(
        new Request("https://agentvault.example/api/v1/pay", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${scene.apiKey}`, "idempotency-key": key },
          body: JSON.stringify({ vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", session_id: scene.sessionId }),
        }),
        h.agentRoute,
      );
      expect(await read(response)).toMatchObject({ status: 400, body: { error: "INVALID_IDEMPOTENCY_KEY" } });
    }
  });
});

describe("HITL-4 to HITL-7: deny, expiry, and at most once", () => {
  it("HITL-4, HITL-8: deny marks the approval denied, executes nothing, and records the actor", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    expect(await read(await handleApprovalAction(act(id, "deny"), id, h.human()))).toEqual({
      status: 200,
      body: { approval_id: id, status: "denied", decided_by: "sandbox_visitor" },
    });
    expect(h.mocks.x402.calls).toBe(0);
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["decision", "approval_created", "approval_decided"]);
    expect(events[2]?.payload).toEqual({ approval_id: id, action: "deny", status: "denied", actor: "sandbox_visitor" });
  });

  it("HITL-5, HITL-12: acting after expiry is 409 APPROVAL_EXPIRED, with one approval_expired event", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    const expiresAt = (await approvalRow(id)).expiresAt;
    h.clock.advance(15 * 60_000);

    for (const action of ["approve", "deny", "approve"]) {
      expect(await read(await handleApprovalAction(act(id, action), id, h.human()))).toEqual({
        status: 409,
        body: { error: "APPROVAL_EXPIRED", approval_id: id, status: "expired" },
      });
    }
    expect(h.mocks.x402.calls).toBe(0);
    expect(await approvalRow(id)).toMatchObject({ status: "expired", decidedBy: "system" });
    const expired = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "approval_expired");
    expect(expired.map((e) => e.payload)).toEqual([{ approval_id: id, expires_at: expiresAt.toISOString(), actor: "system" }]);
  });

  it("HITL-5: an approval is still actionable one millisecond before it expires", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    h.clock.advance(15 * 60_000 - 1);
    expect((await read(await handleApprovalAction(act(id, "approve"), id, h.human()))).body.status).toBe("executed");
  });

  it("HITL-12: reading the list expires overdue approvals exactly once, however often it runs", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const ids = [await holdPayment(scene, h), await holdPayment(scene, h)];
    h.clock.advance(10 * 60_000);
    const fresh = await holdPayment(scene, h);
    h.clock.advance(6 * 60_000);

    const list = () => handleListApprovals(new Request("https://agentvault.example/api/v1/approvals"), h.human());
    for (let i = 0; i < 3; i += 1) {
      const r = await read(await list());
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ workspace_id: scene.workspaceId, sandbox: true });
      const statuses = Object.fromEntries((r.body.approvals as { id: string; status: string }[]).map((a) => [a.id, a.status]));
      expect(statuses).toEqual({ [ids[0]!]: "expired", [ids[1]!]: "expired", [fresh]: "pending" });
    }
    const expired = (await eventsOf(db(), scene.workspaceId)).filter((e) => e.type === "approval_expired");
    expect(expired.map((e) => (e.payload as { approval_id: string }).approval_id).sort()).toEqual([...ids].sort());

    const pending = await read(await handleListApprovals(new Request("https://agentvault.example/api/v1/approvals?status=pending"), h.human()));
    expect((pending.body.approvals as { id: string }[]).map((a) => a.id)).toEqual([fresh]);
    expect((await handleListApprovals(new Request("https://agentvault.example/api/v1/approvals?status=nope"), h.human())).status).toBe(400);
  });

  it("HITL-12: a signed-in user lists their own workspace, not the sandbox", async () => {
    const scene = await billingScene();
    const user = await ownWorkspace(scene, "user-lister");
    const h = harness({ user });
    const id = await holdPayment(scene, h);
    const r = await read(await handleListApprovals(new Request("https://agentvault.example/api/v1/approvals"), h.human()));
    expect(r.body).toMatchObject({ workspace_id: scene.workspaceId, sandbox: false });
    expect((r.body.approvals as { id: string }[]).map((a) => a.id)).toEqual([id]);
  });

  it("HITL-6, HITL-7: a second approve or deny is 409 APPROVAL_NOT_PENDING and nothing runs twice", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    expect((await read(await handleApprovalAction(act(id, "approve"), id, h.human()))).body.status).toBe("executed");
    for (const action of ["approve", "deny"]) {
      expect(await read(await handleApprovalAction(act(id, action), id, h.human()))).toEqual({
        status: 409,
        body: { error: "APPROVAL_NOT_PENDING", approval_id: id, status: "executed" },
      });
    }
    const denied = await holdPayment(scene, h);
    await handleApprovalAction(act(denied, "deny"), denied, h.human());
    expect((await read(await handleApprovalAction(act(denied, "approve"), denied, h.human()))).body).toMatchObject({ error: "APPROVAL_NOT_PENDING", status: "denied" });
    expect(h.mocks.x402.calls).toBe(1);
  });

  it.skipIf(!process.env.DATABASE_URL_TEST)("HITL-7: parallel approvals of one request execute it exactly once", async () => {
    const scene = await billingScene({ isSandbox: true });
    const h = harness();
    const id = await holdPayment(scene, h);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => handleApprovalAction(act(id, i % 3 === 2 ? "deny" : "approve"), id, h.human()).then(read)),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const executed = ok[0]!.body.status === "executed";
    expect(h.mocks.x402.calls).toBe(executed ? 1 : 0);
    const reservations = await db().select().from(spendReservations).where(eq(spendReservations.agentId, scene.agent.id));
    expect(reservations).toHaveLength(executed ? 1 : 0);
    expect((await typesOf(scene.workspaceId)).filter((t) => t === "approval_decided")).toHaveLength(1);
  });
});

describe("HITL-9: unfreeze", () => {
  it("HITL-9: unfreeze clears the flag, is audited with the actor, and lets the agent pay again", async () => {
    const scene = await billingScene({ isSandbox: true, envelope: OPEN_ENVELOPE });
    const h = harness();
    const frozenAt = new Date(Date.UTC(2026, 10, 18, 9, 0));
    await freeze(scene.agent.id, frozenAt);
    const { deps } = testDeps(db(), { mocks: h.mocks, clock: h.clock });
    const pay = () => runGuardedRequest({ agent: scene.agent, idempotencyKey: nextKey(), body: scene.body() }, deps);
    expect((await pay()).body.reasons).toEqual([{ code: "AGENT_FROZEN" }]);

    expect(await read(await handleUnfreeze(unfreezeRequest(scene.agent.id), scene.agent.id, h.human()))).toEqual({
      status: 200,
      body: { agent_id: scene.agent.id, frozen: false, unfrozen_by: "sandbox_visitor" },
    });
    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.at(-1)).toMatchObject({ type: "agent_unfrozen", payload: { agent_id: scene.agent.id, actor: "sandbox_visitor", frozen_at: frozenAt.toISOString() } });
    expect((await pay()).body.decision).toBe("allow");

    expect(await read(await handleUnfreeze(unfreezeRequest(scene.agent.id), scene.agent.id, h.human()))).toEqual({
      status: 409,
      body: { error: "AGENT_NOT_FROZEN", agent_id: scene.agent.id },
    });
    expect((await handleUnfreeze(unfreezeRequest("not-a-uuid"), "not-a-uuid", h.human())).status).toBe(404);
  });

  it("HITL-9, HITL-11: the owner may unfreeze in their workspace", async () => {
    const scene = await billingScene();
    const user = await ownWorkspace(scene, "user-unfreezer");
    await freeze(scene.agent.id);
    const r = await read(await handleUnfreeze(unfreezeRequest(scene.agent.id), scene.agent.id, harness({ user }).human()));
    expect(r.body).toMatchObject({ frozen: false, unfrozen_by: "user-unfreezer" });
  });
});
