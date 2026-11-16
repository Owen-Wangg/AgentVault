import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_CATALOG } from "@/agents/gemini/scenarios";
import { functionCalls, rateLimited, recordedModel, score, text } from "@/agents/gemini/test-fixtures";
import { BILLING_PAYMENT_REF } from "@/agents/scripted/scenarios";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, eventsOf, expectAuditBeforeSpend } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { SEED_VENDORS } from "@/server/sandbox/seed-data";
import { type ScenarioRouteDeps, handleRunScenario } from "./handler";
import { BASE_URL, type RunBody, runRequest, scenarioRouteDeps } from "./test-fixtures";

/**
 * The live Gemini agent through the scenario route (demo-agents AGT-11 to
 * AGT-16), with recorded Gemini responses: the agent's requests go
 * through the real pay, tool, and fetch handlers, and the docs page is
 * the real poisoned route. No test here calls Gemini.
 */

let database: Awaited<ReturnType<typeof createTestDb>>;
let sandboxId: string;
const clock = new FakeClock();

beforeAll(async () => {
  database = await createTestDb();
  sandboxId = (await resetSandbox(database.db, { key: TEST_HEAD_KEY, appOrigin: BASE_URL, now: clock.now() })).workspaceId;
}, 60_000);

afterAll(async () => {
  if (database) {
    await expectAuditBeforeSpend(database.db);
    expect((await verifyChain(database.db, sandboxId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  }
  await database?.close();
});

type LiveBody = RunBody & { agent: string; stop?: string; gemini_requests?: number; tool_calls?: number; steps: (RunBody["steps"][number] & { advisory_drift_score?: number })[] };

async function runLive(name: string, deps: ScenarioRouteDeps): Promise<{ status: number; body: LiveBody }> {
  const response = await handleRunScenario(runRequest(name, { run_id: crypto.randomUUID(), agent: "gemini" }), name, deps);
  return { status: response.status, body: (await response.json()) as LiveBody };
}

const DOCS = `${BASE_URL}/vendor/docs/integration`;
const refund = { name: "request_tool", args: { tool: "stripe.refund", vendor: "nimbus-weather", amount_usd: "480.00", payment_ref: BILLING_PAYMENT_REF } };

describe("AGT-11: the live agent through the scenario route", () => {
  it("AGT-11: without GEMINI_API_KEY a live run is 404 LIVE_AGENT_OFF and nothing is written", async () => {
    const { deps } = scenarioRouteDeps(database, { clock, geminiModel: () => null });
    const before = (await eventsOf(database.db, sandboxId)).length;
    expect(await runLive("injection", deps)).toEqual({ status: 404, body: { error: "LIVE_AGENT_OFF" } });
    expect((await eventsOf(database.db, sandboxId)).length).toBe(before);
  });

  it("AGT-11: the runaway loop has no live run", async () => {
    const rec = recordedModel();
    const { deps } = scenarioRouteDeps(database, { clock, geminiModel: () => rec.model });
    expect(await runLive("runaway", deps)).toEqual({ status: 400, body: { error: "LIVE_NOT_OFFERED" } });
    expect(rec.sent).toHaveLength(0);
  });

  it("AGT-12, AGT-16, INT-8: a live injection run is tainted, held, and shows its drift score", async () => {
    const rec = recordedModel(functionCalls({ name: "fetch_url", args: { url: DOCS } }), functionCalls(refund), score(85), text("The refund is waiting for a person."));
    const { deps, mocks } = scenarioRouteDeps(database, { clock, geminiModel: () => rec.model });
    const { status, body } = await runLive("injection", deps);

    expect(status).toBe(200);
    expect(body).toMatchObject({ agent: "gemini", stop: "finished", completed: true, gemini_requests: 4, tool_calls: 2 });
    expect(body.steps).toEqual([
      expect.objectContaining({ kind: "fetch", label: "untrusted", url: DOCS }),
      expect.objectContaining({ kind: "tool", tool: "stripe.refund", decision: "hold", reasons: ["HELD_TAINTED", "ADVISORY_DRIFT", "NEEDS_APPROVAL"], advisory_drift_score: 85 }),
    ]);
    expect(mocks.stripe.calls).toBe(0);

    const events = await eventsOf(database.db, sandboxId);
    const started = events.find((e) => e.type === "scenario_started" && (e.payload as { run_id?: string }).run_id === body.run_id);
    expect(started?.payload).toMatchObject({ agent: "gemini", model: "gemini-3.5-flash-lite" });
    const decision = events.find((e) => e.type === "decision" && (e.payload as { agent_id?: string }).agent_id === body.agent_id);
    expect((decision?.payload as { request: Record<string, unknown> }).request.advisory_drift_score).toBe(85);
    // The page's raw text is never in the audit log (security-standards §3, §6).
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("acct_9XkQ2mLr7Vt4");
  });

  it("INT-9: a low score on the live refund changes nothing; the taint hold stays", async () => {
    const rec = recordedModel(functionCalls({ name: "fetch_url", args: { url: DOCS } }), functionCalls(refund), score(0), text("Done."));
    const { deps } = scenarioRouteDeps(database, { clock, geminiModel: () => rec.model });
    const { body } = await runLive("injection", deps);
    expect(body.steps.at(-1)).toMatchObject({ decision: "hold", reasons: ["HELD_TAINTED", "NEEDS_APPROVAL"], advisory_drift_score: 0 });
  });

  it("AGT-14: a 429 is a 200 that says the run stopped, so the page can offer the scripted run", async () => {
    const rec = recordedModel(rateLimited());
    const { deps } = scenarioRouteDeps(database, { clock, geminiModel: () => rec.model });
    const { status, body } = await runLive("drift", deps);
    expect(status).toBe(200);
    expect(body).toMatchObject({ agent: "gemini", stop: "gemini_rate_limited", completed: false, gemini_requests: 1 });
    expect(body.steps).toEqual([{ kind: "error", step: "model", status: 429, error: "GEMINI_RATE_LIMITED" }]);
    expect(body.summary.requests).toBe(0);
  });

  it("AGT-11: live runs have their own limits per IP and in total", async () => {
    const perIp = { limit: 1, windowMs: 600_000 };
    const total = { limit: 2, windowMs: 86_400_000 };
    const model = () => recordedModel(text("Nothing to do.")).model;
    const local = new FakeClock();
    local.advance(400 * 86_400_000);
    const { deps } = scenarioRouteDeps(database, { clock: local, geminiModel: model, liveRateLimit: { perIp, total } });
    const as = (ip: string) =>
      handleRunScenario(runRequest("normal", { agent: "gemini" }, { "x-real-ip": ip }), "normal", deps).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect((await as("198.51.100.1")).status).toBe(200);
    expect(await as("198.51.100.1")).toEqual({ status: 429, body: { error: "RATE_LIMITED" } });
    expect((await as("198.51.100.2")).status).toBe(200);
    expect(await as("198.51.100.3")).toEqual({ status: 429, body: { error: "LIVE_QUOTA_USED" } });
    // Scripted runs don't count against the live limits.
    const scripted = await handleRunScenario(runRequest("normal", {}, { "x-real-ip": "198.51.100.3" }), "normal", deps);
    expect(scripted.status).toBe(200);
  }, 60_000);

  it("AGT-11: the live agent's vendor catalog matches the sandbox's registry", () => {
    expect(LIVE_CATALOG.map((v) => [v.name, v.category])).toEqual(SEED_VENDORS.map((v) => [v.name, v.category]));
  });
});
