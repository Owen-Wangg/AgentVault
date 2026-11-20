import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import { authenticateAgent } from "@/server/auth/agent-keys";
import type { SessionUser } from "@/server/auth/session";
import type { Database } from "@/server/db/client";
import { decodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes, users, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { runGuardedRequest } from "@/server/payments/guarded";
import { FakeClock, type Scene, createScene, eventsOf, testDeps } from "@/server/payments/test-fixtures";
import { type AgentAdminDeps, handleCreateAgent, handleUpdateEnvelope } from "./handlers";
import { MAX_AGENTS_PER_WORKSPACE, NEW_AGENT_ENVELOPE, getAgentEnvelope } from "./manage";

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const db = () => database.db;
const BASE = "https://agentvault.example";

function deps(user: SessionUser | null): AgentAdminDeps {
  const clock = new FakeClock();
  return { openDb: () => ({ db: db(), close: async () => {} }), key: () => TEST_HEAD_KEY, now: clock.now, getUser: async () => user };
}

async function user(id: string): Promise<SessionUser> {
  await db().insert(users).values({ id, name: id }).onConflictDoNothing();
  return { id, name: id };
}

async function owned(scene: Scene, id: string): Promise<SessionUser> {
  const u = await user(id);
  await db().update(workspaces).set({ ownerUserId: id }).where(eq(workspaces.id, scene.workspaceId));
  return u;
}

const create = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/api/v1/agents`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const put = (agentId: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/api/v1/agents/${agentId}/envelope`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const read = async (r: Response) => [r.status, await r.json()] as const;

const WIRE = {
  limits: { txMaxMicros: "1000", callsPerMinute: 10 },
  vendorLimits: { "nimbus-weather": { windowCapsMicros: { day: "5000000" } } },
  toolLimits: {},
  allowedVendors: ["nimbus-weather"],
  allowedTools: ["x402.pay"],
  expectedVersion: 1,
};

describe("POST /api/v1/agents", () => {
  it("UI-7, PXY-1: creates an agent in the user's workspace and returns its key once; only the hash is stored", async () => {
    const u = await user("create-owner");
    const response = await handleCreateAgent(create({ name: "  billing-bot " }), deps(u));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { agent_id: string; name: string; workspace_id: string; api_key: string };
    expect(body.name).toBe("billing-bot");

    const [row] = await db().select().from(agents).where(eq(agents.id, body.agent_id));
    expect(row!.workspaceId).toBe(body.workspace_id);
    expect(row!.apiKeyHash).toBe(createHash("sha256").update(body.api_key).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(body.api_key);
    expect(await authenticateAgent(db(), `Bearer ${body.api_key}`)).toMatchObject({ id: body.agent_id });

    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, body.workspace_id));
    expect(ws).toMatchObject({ ownerUserId: u.id, isSandbox: false });
    const [env] = await db().select().from(envelopes).where(eq(envelopes.agentId, body.agent_id));
    expect(decodeEnvelope(body.agent_id, env!)).toEqual({ agentId: body.agent_id, ...NEW_AGENT_ENVELOPE });
  });

  it("UI-7: a workspace holds at most MAX_AGENTS_PER_WORKSPACE agents; the next create is 409 and adds nothing", async () => {
    const u = await user("create-many");
    let workspaceId = "";
    for (let i = 0; i < MAX_AGENTS_PER_WORKSPACE; i += 1) {
      const response = await handleCreateAgent(create({ name: `bot-${i}` }), deps(u));
      expect(response.status).toBe(201);
      workspaceId = ((await response.json()) as { workspace_id: string }).workspace_id;
    }
    expect(await read(await handleCreateAgent(create({ name: "one-too-many" }), deps(u)))).toEqual([409, { error: "AGENT_LIMIT_REACHED" }]);
    expect(await db().select().from(agents).where(eq(agents.workspaceId, workspaceId))).toHaveLength(MAX_AGENTS_PER_WORKSPACE);
  }, 60_000);

  it("UI-7: signed out is 401, and a bad name is 400", async () => {
    expect(await read(await handleCreateAgent(create({ name: "bot" }), deps(null)))).toEqual([401, { error: "UNAUTHORIZED" }]);
    const u = await user("create-bad");
    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(61) }, { name: "a\u0000b" }, { name: "bot", extra: 1 }, {}]) {
      expect((await handleCreateAgent(create(body), deps(u))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("HITL-10, UI-2: bearer headers and cross-site requests are 403 before the database opens", async () => {
    const untouchable: AgentAdminDeps = { ...deps(null), openDb: () => { throw new Error("must not open the database"); } };
    expect(await read(await handleCreateAgent(create({ name: "bot" }, { authorization: "Bearer av_test_x" }), untouchable))).toEqual([403, { error: "AGENT_KEY_FORBIDDEN" }]);
    expect(await read(await handleCreateAgent(create({ name: "bot" }, { origin: "https://evil.example" }), untouchable))).toEqual([403, { error: "CROSS_ORIGIN" }]);
    expect(await read(await handleUpdateEnvelope(put("x", WIRE, { origin: "https://evil.example" }), "x", untouchable))).toEqual([403, { error: "CROSS_ORIGIN" }]);
  });
});

describe("PUT /api/v1/agents/:id/envelope", () => {
  it("UI-8: the owner saves an envelope; it's stored exactly, versioned, and audited as envelope_updated", async () => {
    const scene = await createScene(db());
    const u = await owned(scene, "env-owner");
    const [status, body] = await read(await handleUpdateEnvelope(put(scene.agent.id, WIRE), scene.agent.id, deps(u)));
    expect([status, body]).toEqual([200, { agent_id: scene.agent.id, version: 2 }]);

    const stored = await getAgentEnvelope(db(), scene.workspaceId, scene.agent.id);
    expect(stored!.version).toBe(2);
    expect(stored!.envelope).toEqual({ ...WIRE, expectedVersion: 2 });

    const events = await eventsOf(db(), scene.workspaceId);
    const updated = events.filter((e) => e.type === "envelope_updated");
    expect(updated.map((e) => e.payload)).toEqual([
      { agent_id: scene.agent.id, version: 2, actor: u.id, envelope: { limits: WIRE.limits, vendorLimits: WIRE.vendorLimits, toolLimits: {}, allowedVendors: WIRE.allowedVendors, allowedTools: WIRE.allowedTools } },
    ]);
    expect((await verifyChain(db(), scene.workspaceId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  });

  it("UI-8: the pay flow enforces the saved limits on the next request", async () => {
    const scene = await createScene(db());
    const u = await owned(scene, "env-enforce");
    const { deps: payDeps } = testDeps(db());
    const pay = (key: string) => runGuardedRequest({ agent: scene.agent, idempotencyKey: key, body: scene.body({ amountMicros: fromDecimalString("0.0015") }) }, payDeps);
    expect((await pay("before")).body.decision).toBe("allow");
    expect((await handleUpdateEnvelope(put(scene.agent.id, WIRE), scene.agent.id, deps(u))).status).toBe(200);
    // $0.0015 is over the new $0.001 per-transaction maximum.
    const after = await pay("after");
    expect(after.body.decision).toBe("deny");
    expect((after.body.reasons ?? []).map((r) => r.code)).toContain("OVER_TX_MAX");
  });

  it("UI-8: a save against an older version is 409 and changes nothing", async () => {
    const scene = await createScene(db());
    const u = await owned(scene, "env-stale");
    expect((await handleUpdateEnvelope(put(scene.agent.id, WIRE), scene.agent.id, deps(u))).status).toBe(200);
    const stale = { ...WIRE, limits: { callsPerMinute: 5 }, expectedVersion: 1 };
    expect(await read(await handleUpdateEnvelope(put(scene.agent.id, stale), scene.agent.id, deps(u)))).toEqual([409, { error: "ENVELOPE_CHANGED", version: 2 }]);
    expect((await getAgentEnvelope(db(), scene.workspaceId, scene.agent.id))!.envelope.limits).toEqual(WIRE.limits);
  });

  it("UI-8: rejects an invalid envelope with 400 and keeps the old one", async () => {
    const scene = await createScene(db());
    const u = await owned(scene, "env-invalid");
    for (const body of [
      { ...WIRE, limits: { txMaxMicros: 1000 } },
      // The agent's own calls-per-minute limit is required, and at most 1,000.
      { ...WIRE, limits: { txMaxMicros: "1000" } },
      { ...WIRE, limits: { txMaxMicros: "1000", callsPerMinute: 1001 } },
      { ...WIRE, vendorLimits: JSON.parse('{"__proto__": {"txMaxMicros": "0"}}') },
      { ...WIRE, allowedTools: ["x402.pay", "x402.pay"] },
      { ...WIRE, surprise: true },
    ]) {
      expect((await handleUpdateEnvelope(put(scene.agent.id, body), scene.agent.id, deps(u))).status).toBe(400);
    }
    expect((await getAgentEnvelope(db(), scene.workspaceId, scene.agent.id))!.version).toBe(1);
  });

  it("UI-21: sandbox envelopes are read-only, even for a signed-in user", async () => {
    const sandbox = await createScene(db(), { isSandbox: true });
    const u = await user("env-sandbox");
    for (const who of [null, u]) {
      expect(await read(await handleUpdateEnvelope(put(sandbox.agent.id, WIRE), sandbox.agent.id, deps(who)))).toEqual([403, { error: "SANDBOX_READ_ONLY" }]);
    }
  });

  it("HITL-11: someone else's workspace is 403, signed out is 401, and an unknown agent is 404", async () => {
    const scene = await createScene(db());
    await owned(scene, "env-real-owner");
    const other = await user("env-other");
    expect(await read(await handleUpdateEnvelope(put(scene.agent.id, WIRE), scene.agent.id, deps(other)))).toEqual([403, { error: "FORBIDDEN" }]);
    expect(await read(await handleUpdateEnvelope(put(scene.agent.id, WIRE), scene.agent.id, deps(null)))).toEqual([401, { error: "UNAUTHORIZED" }]);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await handleUpdateEnvelope(put(missing, WIRE), missing, deps(other))).status).toBe(404);
    expect((await handleUpdateEnvelope(put("nope", WIRE), "nope", deps(other))).status).toBe(404);
  });
});
