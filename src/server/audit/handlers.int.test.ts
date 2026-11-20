import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { SessionUser } from "@/server/auth/session";
import { listAuditEvents } from "@/server/dashboard/audit";
import { auditHeads, users, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, createScene } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { appendEvent } from "./append";
import { type VerifyDeps, handleVerifyChain } from "./handlers";

let database: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const db = () => database.db;
const BASE = "https://agentvault.example";

function deps(user: SessionUser | null = null, over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    openDb: () => ({ db: db(), close: async () => {} }),
    key: () => TEST_HEAD_KEY,
    now: new FakeClock().now,
    getUser: async () => user,
    // Every FakeClock starts in the same minute, so tests would share one rate-limit window.
    rateLimit: { limit: 1_000_000, windowMs: 60_000 },
    ...over,
  };
}

const verify = async (body: unknown, d: VerifyDeps, headers: Record<string, string> = {}) => {
  const response = await handleVerifyChain(new Request(`${BASE}/api/v1/audit/verify`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), d);
  return [response.status, await response.json()] as const;
};

/** A workspace owned by `userId`, with `n` events. */
async function ownedWorkspace(userId: string, n: number) {
  await db().insert(users).values({ id: userId, name: userId }).onConflictDoNothing();
  const scene = await createScene(db());
  await db().update(workspaces).set({ ownerUserId: userId }).where(eq(workspaces.id, scene.workspaceId));
  await db().transaction(async (tx) => {
    for (let i = 0; i < n; i += 1) await appendEvent(tx, { workspaceId: scene.workspaceId, type: "envelope_updated", payload: { n: i } }, { key: TEST_HEAD_KEY });
  });
  return scene.workspaceId;
}

describe("POST /api/v1/audit/verify", () => {
  it("AUD-4, AUD-6: an anonymous visitor verifies the current sandbox's chain and gets the event count and the head seq", async () => {
    const { workspaceId } = await resetSandbox(db(), { key: TEST_HEAD_KEY, appOrigin: BASE });
    expect(await verify({}, deps())).toEqual([200, { workspace_id: workspaceId, ok: true, count: 1, head_seq: 1 }]);
    expect(await verify({ workspace_id: workspaceId }, deps())).toEqual([200, { workspace_id: workspaceId, ok: true, count: 1, head_seq: 1 }]);
  });

  it("AUD-8: a head that no longer matches the last event fails at that seq, with why: head", async () => {
    const workspaceId = await ownedWorkspace("verify-owner", 3);
    const owner = { id: "verify-owner" };
    expect(await verify({ workspace_id: workspaceId }, deps(owner))).toEqual([200, { workspace_id: workspaceId, ok: true, count: 3, head_seq: 3 }]);
    // Roll the head back one event without the key: its MAC no longer matches, which is
    // reported after the last event, and the response shows the head's seq.
    await db().update(auditHeads).set({ seq: 2 }).where(eq(auditHeads.workspaceId, workspaceId));
    expect(await verify({ workspace_id: workspaceId }, deps(owner))).toEqual([200, { workspace_id: workspaceId, ok: false, broken_at_seq: 4, why: "head", head_seq: 2 }]);
  });

  it("TEL-5: another workspace needs its owner: 401 signed out, 403 for someone else, 404 if unknown; retired sandboxes stay public", async () => {
    const workspaceId = await ownedWorkspace("verify-owner-2", 1);
    expect(await verify({ workspace_id: workspaceId }, deps())).toEqual([401, { error: "UNAUTHORIZED" }]);
    expect(await verify({ workspace_id: workspaceId }, deps({ id: "someone-else" }))).toEqual([403, { error: "FORBIDDEN" }]);
    expect((await verify({ workspace_id: crypto.randomUUID() }, deps()))[0]).toBe(404);
    expect((await verify({ workspace_id: "nope" }, deps()))[0]).toBe(400);

    const { workspaceId: old } = await resetSandbox(db(), { key: TEST_HEAD_KEY, appOrigin: BASE });
    await resetSandbox(db(), { key: TEST_HEAD_KEY, appOrigin: BASE });
    // The retired sandbox has sandbox_created and sandbox_retired.
    expect(await verify({ workspace_id: old }, deps())).toEqual([200, { workspace_id: old, ok: true, count: 2, head_seq: 2 }]);
  });

  it("UI-4: sandbox verifies are rate-limited per IP; an owner's own workspace isn't", async () => {
    const limited = deps(null, { rateLimit: { limit: 1, windowMs: 60_000 } });
    const ip = { "x-real-ip": "203.0.113.90" };
    expect((await verify({}, limited, ip))[0]).toBe(200);
    expect(await verify({}, limited, ip)).toEqual([429, { error: "RATE_LIMITED" }]);
    const workspaceId = await ownedWorkspace("verify-owner-3", 1);
    const ownerLimited = deps({ id: "verify-owner-3" }, { rateLimit: { limit: 1, windowMs: 60_000 } });
    for (let i = 0; i < 3; i += 1) expect((await verify({ workspace_id: workspaceId }, ownerLimited, ip))[0]).toBe(200);
  });

  it("UI-2, HITL-10: a bearer header or a cross-site POST is 403 before the database opens", async () => {
    const untouchable = deps(null, {
      openDb: () => {
        throw new Error("must not open the database");
      },
    });
    expect(await verify({}, untouchable, { authorization: "Bearer x" })).toEqual([403, { error: "AGENT_KEY_FORBIDDEN" }]);
    expect(await verify({}, untouchable, { origin: "https://evil.example" })).toEqual([403, { error: "CROSS_ORIGIN" }]);
  });
});

describe("listAuditEvents", () => {
  it("UI-10: pages go from the newest event back, with seq, hash, and prev_hash", async () => {
    const workspaceId = await ownedWorkspace("pages-owner", 7);
    const first = await listAuditEvents(db(), workspaceId, { limit: 3 });
    expect(first.events.map((e) => e.seq)).toEqual([7, 6, 5]);
    expect(first.older).toBe(5);
    expect(first.events[0]!.prev_hash).toBe(first.events[1]!.hash);
    const second = await listAuditEvents(db(), workspaceId, { before: 5, limit: 3 });
    expect(second.events.map((e) => e.seq)).toEqual([4, 3, 2]);
    const last = await listAuditEvents(db(), workspaceId, { before: 2, limit: 3 });
    expect(last).toMatchObject({ events: [{ seq: 1 }], older: null });
    expect((await listAuditEvents(db(), workspaceId, { limit: 7 })).older).toBeNull();
  });

  it("UI-31: lists only one event type when asked, and pages within that type", async () => {
    const workspaceId = await ownedWorkspace("filter-owner", 0);
    // seq 1 to 7: envelope_updated at 1, 3, 5, 7 and agent_frozen at 2, 4, 6.
    await db().transaction(async (tx) => {
      for (let i = 1; i <= 7; i += 1) {
        await appendEvent(tx, { workspaceId, type: i % 2 === 1 ? "envelope_updated" : "agent_frozen", payload: { n: i } }, { key: TEST_HEAD_KEY });
      }
    });
    const first = await listAuditEvents(db(), workspaceId, { type: "agent_frozen", limit: 2 });
    expect(first.events.map((e) => [e.seq, e.type])).toEqual([
      [6, "agent_frozen"],
      [4, "agent_frozen"],
    ]);
    expect(first.older).toBe(4);
    const second = await listAuditEvents(db(), workspaceId, { type: "agent_frozen", before: 4, limit: 2 });
    expect(second).toMatchObject({ events: [{ seq: 2, type: "agent_frozen" }], older: null });
    expect((await listAuditEvents(db(), workspaceId, { type: "sandbox_created" })).events).toEqual([]);
    expect((await listAuditEvents(db(), workspaceId)).events).toHaveLength(7);
  });
});
