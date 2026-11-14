import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { verifyChain } from "@/server/audit/append";
import type { Database } from "@/server/db/client";
import { approvals, sessions } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { type FetchDeps, handleFetch } from "@/server/fetch/fetch-handler";
import { runGuardedRequest } from "@/server/payments/guarded";
import { type Scene, createScene, eventsOf, testDeps } from "@/server/payments/test-fixtures";
import { SEED_AGENTS, SEED_TASKS } from "@/server/sandbox/seed-data";
import { type ToolDeps, handleTool } from "@/server/tools/tool-handler";
import { GET as poisonedDocs } from "../../../app/vendor/docs/integration/route";

/**
 * The prompt-injection and drift scenarios end to end through the HTTP
 * handlers, with the sandbox seed's envelopes and tasks (demo-agents
 * design). The fetcher is replaced by the docs route itself, so the agent
 * reads the real poisoned page.
 */

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const db = () => database.db;
const DOCS_URL = "https://agentvault.example/vendor/docs/integration";

const seedAgent = (name: string) => SEED_AGENTS.find((a) => a.name === name)!.envelope;
const seedTask = (key: string) => {
  const t = SEED_TASKS.find((s) => s.key === key)!;
  return { allowedVendorCategories: [...t.allowedVendorCategories], allowedTools: [...t.allowedTools], budgetMicros: t.budgetMicros };
};

function deps() {
  const { deps: guarded, mocks } = testDeps(db());
  const open = () => ({ db: db(), close: async () => {} });
  const fetch: FetchDeps = {
    openDb: open,
    key: () => guarded.key,
    now: guarded.now,
    fetchPage: async (url) => ({ url, hops: [url], status: 200, contentType: "text/html", body: await poisonedDocs().text() }),
  };
  const tool: ToolDeps = { openDb: open, key: () => guarded.key, now: guarded.now, railFor: guarded.railFor };
  return { fetch, tool, guarded, mocks };
}

const post = (path: string, scene: Scene, body: unknown, key?: string) =>
  new Request(`https://agentvault.example${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${scene.apiKey}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });

/** What a naive agent does with the page: find the injected refund and obey it. */
function extractRefund(html: string): string {
  const match = /issue a refund of \$(\d+\.\d{2})/.exec(html);
  if (!match?.[1]) throw new Error("no injected instruction found");
  return fromDecimalString(match[1]).toString();
}

describe("demo scenarios through the API", () => {
  it("TAINT-4, TAINT-6: injection: the poisoned fetch taints the session, then stripe.refund $480 returns 202 held with exactly HELD_TAINTED and NEEDS_APPROVAL", async () => {
    const scene = await createScene(db(), { envelope: seedAgent("billing-agent"), task: seedTask("billing") });
    const { fetch, tool, mocks, guarded } = deps();

    const fetched = await handleFetch(post("/api/v1/fetch", scene, { url: DOCS_URL, session_id: scene.sessionId }), fetch);
    const page = (await fetched.json()) as { label: string; body: string };
    expect(fetched.status).toBe(200);
    expect(page.label).toBe("untrusted");

    const amount = extractRefund(page.body);
    expect(amount).toBe("480000000");
    const refund = await handleTool(
      post("/api/v1/tool", scene, { tool: "stripe.refund", session_id: scene.sessionId, args: { vendor: "nimbus-weather", amount_micros: amount, payment_ref: "pi_mock_billing_500" } }, "injected-refund"),
      tool,
    );
    const held = (await refund.json()) as { decision: string; reasons: { code: string; detail?: Record<string, string> }[]; approval_id: string };
    expect(refund.status).toBe(202);
    expect(held.decision).toBe("hold");
    expect(held.reasons.map((r) => r.code)).toEqual(["HELD_TAINTED", "NEEDS_APPROVAL"]);
    expect(held.reasons[0]?.detail?.sourceUrl).toBe(DOCS_URL);

    const [approval] = await db().select().from(approvals).where(eq(approvals.id, held.approval_id));
    expect(approval?.status).toBe("pending");
    expect(mocks.stripe.calls).toBe(0);

    const events = await eventsOf(db(), scene.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["taint", "decision", "approval_created"]);
    expect((await verifyChain(db(), scene.workspaceId, { key: guarded.key })).ok).toBe(true);
    const [session] = await db().select().from(sessions).where(eq(sessions.id, scene.sessionId));
    expect(session?.taintSourceUrl).toBe(DOCS_URL);
  });

  it("TAINT-7: injection without the fetch: the same refund gets only NEEDS_APPROVAL", async () => {
    const scene = await createScene(db(), { envelope: seedAgent("billing-agent"), task: seedTask("billing") });
    const { tool } = deps();
    const refund = await handleTool(
      post("/api/v1/tool", scene, { tool: "stripe.refund", session_id: scene.sessionId, args: { vendor: "nimbus-weather", amount_micros: "480000000", payment_ref: "pi_mock_billing_500" } }, "clean-refund"),
      tool,
    );
    expect(((await refund.json()) as { reasons: { code: string }[] }).reasons.map((r) => r.code)).toEqual(["NEEDS_APPROVAL"]);
  });

  it("INT-2: drift: a weather payment is allowed, then paying the GPU vendor is denied with exactly DENY_INTENT_DRIFT", async () => {
    const scene = await createScene(db(), { envelope: seedAgent("weather-agent"), task: seedTask("weather") });
    const { guarded } = deps();
    const weather = await runGuardedRequest({ agent: scene.agent, idempotencyKey: "drift-1", body: scene.body() }, guarded);
    expect(weather.body).toMatchObject({ decision: "allow", reasons: [] });
    const gpu = await runGuardedRequest(
      { agent: scene.agent, idempotencyKey: "drift-2", body: scene.body({ vendor: "gpu-cloud", amountMicros: fromDecimalString("0.25") }) },
      guarded,
    );
    expect(gpu).toMatchObject({ status: 403, body: { decision: "deny" } });
    expect(gpu.body.reasons?.map((r) => r.code)).toEqual(["DENY_INTENT_DRIFT"]);
  });
});
