import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACME_SUPPLIER, ATTACKER_ACCOUNT, SCENARIOS } from "@/agents/scripted/scenarios";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { actOnApproval } from "@/server/approvals/service";
import { verifyChain } from "@/server/audit/append";
import { hashApiKey } from "@/server/auth/agent-keys";
import { decodeEnvelope } from "@/server/db/envelope-json";
import { agents, approvals, auditEvents, envelopes, sessions, tasks, vendors } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, eventsOf, expectAuditBeforeSpend } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { handleRunScenario } from "./handler";
import { runPayeeName } from "./runner";
import { BASE_URL, decisionsOf, expectedOf, runRequest, runScenarioRoute, scenarioRouteDeps } from "./test-fixtures";

/**
 * Each scenario end to end: the route creates the run's agent, the
 * scripted agent sends real requests through the pay, tool, and fetch
 * handlers with its own key, and the decisions come from the database.
 */

let database: Awaited<ReturnType<typeof createTestDb>>;
let sandboxId: string;

beforeAll(async () => {
  database = await createTestDb();
  sandboxId = (await resetSandbox(database.db, { key: TEST_HEAD_KEY, appOrigin: BASE_URL, now: new FakeClock().now() })).workspaceId;
}, 60_000);

afterAll(async () => {
  if (database) await expectAuditBeforeSpend(database.db);
  await database?.close();
});

const db = () => database.db;

const routeDeps = (over: Parameters<typeof scenarioRouteDeps>[1] = {}) => scenarioRouteDeps(database, over);
const run = runScenarioRoute;
const request = runRequest;
const decisions = decisionsOf;
const expected = expectedOf;

describe("POST /api/v1/scenarios/:name/run", () => {
  it("AGT-2: a run creates a fresh agent, task, and session with the scenario's seed, and scenario_started comes before its decisions", async () => {
    const { deps } = routeDeps();
    const first = await run("normal", deps);
    const second = await run("normal", deps);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.agent_id).not.toBe(first.body.agent_id);
    expect(second.body.session_id).not.toBe(first.body.session_id);

    for (const { body } of [first, second]) {
      expect(body.workspace_id).toBe(sandboxId);
      const [agent] = await db().select().from(agents).where(eq(agents.id, body.agent_id));
      expect(agent).toMatchObject({ workspaceId: sandboxId, name: SCENARIOS.normal.agentName, frozenAt: null, revokedAt: null });
      const [envelope] = await db().select().from(envelopes).where(eq(envelopes.agentId, body.agent_id));
      expect(decodeEnvelope(body.agent_id, envelope!)).toEqual({ agentId: body.agent_id, ...SCENARIOS.normal.envelope });
      const [session] = await db().select().from(sessions).where(eq(sessions.id, body.session_id));
      expect(session).toMatchObject({ agentId: body.agent_id, taintedAt: null });
      const [task] = await db().select().from(tasks).where(eq(tasks.id, session!.taskId));
      expect(task).toMatchObject({
        workspaceId: sandboxId,
        description: SCENARIOS.normal.task.description,
        allowedVendorCategories: [...SCENARIOS.normal.task.allowedVendorCategories],
        allowedTools: [...SCENARIOS.normal.task.allowedTools],
        budgetMicros: SCENARIOS.normal.task.budgetMicros,
      });

      const [started] = await db()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.workspaceId, sandboxId), eq(auditEvents.seq, body.started_seq)));
      expect(started?.type).toBe("scenario_started");
      expect(started?.payload).toMatchObject({ scenario: "normal", run_id: expect.any(String), actor: "sandbox_visitor", agent_id: body.agent_id, session_id: body.session_id, task_id: task!.id });
      for (const step of body.steps) expect(step.event_seq).toBeGreaterThan(body.started_seq);
    }
    expect((await verifyChain(db(), sandboxId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  }, 30_000);

  it("AGT-4, AUD-5: the agent sends each request to the API with its own bearer key, and the key is never stored, audited, or returned", async () => {
    const { deps, sent } = routeDeps();
    const { body, text } = await run("drift", deps);
    expect(sent.map((r) => new URL(r.url).pathname)).toEqual(["/api/v1/pay", "/api/v1/pay"]);
    const keys = new Set(sent.map((r) => r.headers.get("authorization")));
    expect(keys.size).toBe(1);
    const key = [...keys][0]!.replace(/^Bearer /, "");
    const [agent] = await db().select().from(agents).where(eq(agents.id, body.agent_id));
    expect(agent?.apiKeyHash).toBe(hashApiKey(key));
    expect(new Set(sent.map((r) => r.headers.get("idempotency-key"))).size).toBe(sent.length);
    expect(text).not.toContain(key);
    const events = await eventsOf(db(), sandboxId);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("av_test_");
  });

  it("AGT-6: normal purchase makes 5 weather purchases, each allowed and settled", async () => {
    const { deps, mocks } = routeDeps();
    const { status, body } = await run("normal", deps);
    expect(status).toBe(200);
    expect(decisions(body)).toEqual(expected("normal"));
    expect(mocks.x402.calls).toBe(5);
    expect(body.summary).toEqual({
      requests: 5,
      allowed_micros: "7500",
      held_micros: "0",
      blocked_micros: "0",
      decisions: { allow: 5, hold: 0, deny: 0 },
      reasons: [],
    });
  });

  it("AGT-7: the runaway loop is denied with VELOCITY_EXCEEDED and frozen before the minute cap, then denied with AGENT_FROZEN", async () => {
    const { deps, mocks } = routeDeps();
    const { body } = await run("runaway", deps);
    expect(decisions(body)).toEqual(expected("runaway"));
    expect(mocks.x402.calls).toBe(30);
    // 30 × $0.0015 = $0.045, far under the $0.50 minute cap: velocity stops it first.
    expect(body.summary).toMatchObject({ requests: 36, allowed_micros: "45000", blocked_micros: "9000", decisions: { allow: 30, hold: 0, deny: 6 } });
    expect(body.summary.reasons).toEqual([
      { code: "VELOCITY_EXCEEDED", count: 6 },
      { code: "AGENT_FROZEN", count: 5 },
    ]);
    const frozenEvents = (await eventsOf(db(), sandboxId)).filter((e) => e.type === "agent_frozen" && (e.payload as { agent_id: string }).agent_id === body.agent_id);
    expect(frozenEvents).toHaveLength(1);
    const [agent] = await db().select().from(agents).where(eq(agents.id, body.agent_id));
    expect(agent?.frozenAt).toBeInstanceOf(Date);
  }, 120_000);

  it("AGT-8: prompt injection reads the poisoned docs, which taints the session, and the $480 refund it obeys is held with HELD_TAINTED", async () => {
    const { deps, mocks } = routeDeps();
    const { body } = await run("injection", deps);
    expect(body.steps[0]).toMatchObject({ kind: "fetch", label: "untrusted", url: `${BASE_URL}/vendor/docs/integration` });
    expect(decisions(body)).toEqual(expected("injection"));
    expect(body.steps[1]).toMatchObject({ kind: "tool", amount_micros: "480000000", approval_id: expect.any(String) });
    expect(mocks.stripe.calls).toBe(0);

    const [approval] = await db().select().from(approvals).where(eq(approvals.id, body.steps[1]!.approval_id!));
    expect(approval?.status).toBe("pending");
    // Tests in this file run one at a time, so every event since scenario_started is this run's.
    const events = (await eventsOf(db(), sandboxId)).filter((e) => e.seq >= body.started_seq);
    expect(events.map((e) => e.type)).toEqual(["scenario_started", "taint", "decision", "approval_created"]);
    expect(body.summary).toMatchObject({ requests: 2, held_micros: "480000000", allowed_micros: "0", blocked_micros: "0" });
  });

  it("AGT-9: intent drift under the weather task is allowed for weather, then denied with exactly DENY_INTENT_DRIFT for the GPU vendor", async () => {
    const { deps, mocks } = routeDeps();
    const { body } = await run("drift", deps);
    expect(decisions(body)).toEqual(expected("drift"));
    expect(mocks.x402.calls).toBe(1);
    expect(body.summary).toMatchObject({ requests: 2, allowed_micros: "1500", blocked_micros: "250000" });
  });

  it("PO-23: payee hijack reads the poisoned invoice, and both the payout account change and the $900 payout are held", async () => {
    const { deps, mocks } = routeDeps();
    const { body } = await run("hijack", deps);
    const supplier = runPayeeName("acme-supplies", body.run_id);
    expect(body.steps[0]).toMatchObject({ kind: "fetch", label: "untrusted", url: `${BASE_URL}/vendor/docs/invoice` });
    expect(decisions(body)).toEqual(expected("hijack"));
    expect(body.steps[1]).toMatchObject({ kind: "tool", tool: "payee.update", vendor: supplier, amount_micros: "0", approval_id: expect.any(String) });
    expect(body.steps[2]).toMatchObject({ kind: "tool", tool: "payout.create", vendor: supplier, amount_micros: "900000000", approval_id: expect.any(String) });
    expect(mocks.stripe.calls).toBe(0);
    expect(body.summary).toMatchObject({ requests: 3, held_micros: "900000000", allowed_micros: "0", blocked_micros: "0" });

    // The run's own supplier, with the destination on file, recorded in scenario_started.
    const [row] = await db().select().from(vendors).where(and(eq(vendors.workspaceId, sandboxId), eq(vendors.name, supplier)));
    expect(row).toMatchObject({ category: "suppliers", trusted: false, stripeAccount: ACME_SUPPLIER.stripeAccount, paypalReceiver: ACME_SUPPLIER.paypalReceiver });
    const [started] = await db().select().from(auditEvents).where(and(eq(auditEvents.workspaceId, sandboxId), eq(auditEvents.seq, body.started_seq)));
    expect(started?.payload).toMatchObject({ scenario: "hijack", vendors: { "acme-supplies": supplier } });
  });

  it("PO-24: denying the injected account change and approving the payout pays the supplier's account on file", async () => {
    const { deps, mocks, guarded } = routeDeps();
    const { body } = await run("hijack", deps);
    const act = (approvalId: string, action: "approve" | "deny") =>
      actOnApproval({ db: db(), key: guarded.key, now: guarded.now, railFor: guarded.railFor }, { approvalId, workspaceId: sandboxId, action, actor: "sandbox_visitor" });
    await act(body.steps[1]!.approval_id!, "deny");
    expect(await act(body.steps[2]!.approval_id!, "approve")).toMatchObject({ status: 200 });
    expect(mocks.stripe.recorded()).toMatchObject([{ kind: "payout", destination: ACME_SUPPLIER.stripeAccount, units: 90_000n }]);
    const result = (await eventsOf(db(), sandboxId)).filter((e) => e.type === "rail_result").at(-1)?.payload;
    expect(result).toMatchObject({ status: "settled", payout_to: ACME_SUPPLIER.stripeAccount });
  });

  it("PO-23: an approved hijack in one run doesn't redirect the next run's payout", async () => {
    const { deps, mocks, guarded } = routeDeps();
    const act = (approvalId: string, action: "approve" | "deny") =>
      actOnApproval({ db: db(), key: guarded.key, now: guarded.now, railFor: guarded.railFor }, { approvalId, workspaceId: sandboxId, action, actor: "sandbox_visitor" });
    // A visitor approves both: the first run's supplier now points at the attacker, and its payout goes there.
    const first = await run("hijack", deps);
    await act(first.body.steps[1]!.approval_id!, "approve");
    await act(first.body.steps[2]!.approval_id!, "approve");
    // The next visitor denies the change and approves the payout: the money still goes to the supplier.
    const second = await run("hijack", deps);
    await act(second.body.steps[1]!.approval_id!, "deny");
    await act(second.body.steps[2]!.approval_id!, "approve");
    expect(mocks.stripe.recorded().map((r) => r.destination)).toEqual([ATTACKER_ACCOUNT, ACME_SUPPLIER.stripeAccount]);
    const payeeChanges = (await eventsOf(db(), sandboxId)).filter((e) => e.type === "payee_updated");
    expect(payeeChanges.at(-1)?.payload).toMatchObject({ vendor: runPayeeName("acme-supplies", first.body.run_id), old_ref: ACME_SUPPLIER.stripeAccount, new_ref: ATTACKER_ACCOUNT });
    // Two runs and four approvals take about 5 s on the Neon test branch, past Vitest's 5 s default.
  }, 30_000);
});

describe("POST /api/v1/scenarios/:name/run: access", () => {
  it("AGT-1: an unknown scenario is 404 and creates nothing", async () => {
    const { deps } = routeDeps();
    const before = await db().select({ id: agents.id }).from(agents);
    const response = await handleRunScenario(request("loop"), "loop", deps);
    expect([response.status, await response.json()]).toEqual([404, { error: "UNKNOWN_SCENARIO" }]);
    expect(await db().select({ id: agents.id }).from(agents)).toEqual(before);
  });

  it("AGT-2: the body may only carry a UUID run_id", async () => {
    const { deps } = routeDeps();
    for (const body of [{ run_id: "x" }, { run_id: crypto.randomUUID(), envelope: {} }, []]) {
      expect((await handleRunScenario(request("normal", body), "normal", deps)).status).toBe(400);
    }
    expect((await handleRunScenario(request("drift", {}), "drift", deps)).status).toBe(200);
  });

  it("UI-4: runs are rate-limited per IP, and a refused run creates nothing", async () => {
    const { deps } = routeDeps({ rateLimit: { limit: 1, windowMs: 60_000 } });
    const ip = { "x-real-ip": "203.0.113.77" };
    expect((await run("drift", deps, ip)).status).toBe(200);
    const before = await db().select({ id: agents.id }).from(agents);
    const refused = await handleRunScenario(request("drift", undefined, ip), "drift", deps);
    expect([refused.status, await refused.json()]).toEqual([429, { error: "RATE_LIMITED" }]);
    expect(await db().select({ id: agents.id }).from(agents)).toEqual(before);
    expect((await run("drift", deps, { "x-real-ip": "203.0.113.78" })).status).toBe(200);
  });

  it.skipIf(!process.env.DATABASE_URL_TEST)("AGT-2: a second run of a scenario already in progress is 409 SCENARIO_BUSY; other scenarios still run", async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    const base = routeDeps();
    const held = routeDeps({
      agentFetch: async (input, init) => {
        reached();
        await gate;
        return base.deps.agentFetch!(input, init);
      },
    });
    const first = handleRunScenario(request("drift"), "drift", held.deps);
    await atGate;
    const busy = await handleRunScenario(request("drift"), "drift", base.deps);
    expect([busy.status, await busy.json()]).toEqual([409, { error: "SCENARIO_BUSY" }]);
    expect((await run("normal", base.deps)).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await run("drift", base.deps)).status).toBe(200);
  }, 60_000);

  it("AGT-2: with no sandbox, a run is 404 NO_SANDBOX and creates nothing", async () => {
    // A second, empty database: this file's own one always has a sandbox.
    const empty = await createTestDb({ driver: "pglite" });
    try {
      const { deps } = scenarioRouteDeps(empty);
      const response = await handleRunScenario(request("normal"), "normal", deps);
      expect([response.status, await response.json()]).toEqual([404, { error: "NO_SANDBOX" }]);
      expect(await empty.db.select({ id: agents.id }).from(agents)).toEqual([]);
    } finally {
      await empty.close();
    }
  }, 30_000);

  it("AGT-2: runs go to the current sandbox, so after a reset they use the new one", async () => {
    const { deps } = routeDeps();
    const { workspaceId } = await resetSandbox(db(), { key: TEST_HEAD_KEY, appOrigin: BASE_URL });
    const { body } = await run("drift", deps);
    expect(body.workspace_id).toBe(workspaceId);
    expect(body.workspace_id).not.toBe(sandboxId);
    // The old sandbox's agents were revoked by the reset (PXY-3); its rows stay.
    const old = await db().select({ revokedAt: agents.revokedAt }).from(agents).where(inArray(agents.workspaceId, [sandboxId]));
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((a) => a.revokedAt !== null)).toBe(true);
    sandboxId = workspaceId;
  });
});
