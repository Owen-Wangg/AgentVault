import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { createScene, taintSession } from "@/server/payments/test-fixtures";
import type { EventType } from "@/core/audit/chain";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { appendEvent } from "@/server/audit/append";
import { copy } from "@/ui/copy";
import { AGENT_LIST_LIMIT, lastDecisions, listAgents } from "./agents";

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const db = () => database.db;

describe("listAgents", () => {
  it("UI-7: lists the workspace's agents with frozen and tainted status, and nothing from other workspaces", async () => {
    const scene = await createScene(db());
    const second = await createScene(db(), { workspaceId: scene.workspaceId });
    const elsewhere = await createScene(db());
    await db().update(agents).set({ frozenAt: new Date("2026-11-24T10:00:00.000Z") }).where(eq(agents.id, scene.agent.id));
    await taintSession(db(), second.sessionId, "https://agentvault.example/vendor/docs/integration");

    const { agents: list, truncated } = await listAgents(db(), scene.workspaceId);
    expect(truncated).toBe(false);
    expect(list.map((a) => a.id)).toEqual([scene.agent.id, second.agent.id]);
    expect(list.map((a) => a.id)).not.toContain(elsewhere.agent.id);
    expect(list[0]).toMatchObject({ frozenAt: "2026-11-24T10:00:00.000Z", tainted: false, taintSourceUrl: null, revokedAt: null });
    expect(list[1]).toMatchObject({ frozenAt: null, tainted: true, taintSourceUrl: "https://agentvault.example/vendor/docs/integration" });
  });

  it("UI-7: keeps only the newest agents, oldest of them first, and says when it left some out", async () => {
    const first = await createScene(db());
    const ws = first.workspaceId;
    const ids = [first.agent.id];
    for (let i = 0; i < 3; i += 1) ids.push((await createScene(db(), { workspaceId: ws })).agent.id);
    // Distinct creation times, so "newest" is unambiguous.
    for (const [i, id] of ids.entries()) await db().update(agents).set({ createdAt: new Date(Date.UTC(2026, 10, 24, 10, i)) }).where(eq(agents.id, id));
    expect(await listAgents(db(), ws, 2)).toEqual({ agents: [expect.objectContaining({ id: ids[2] }), expect.objectContaining({ id: ids[3] })], truncated: true });
    expect((await listAgents(db(), ws, 4)).truncated).toBe(false);
  });

  it("UI-7: the list's limit is the one the truncation note names, in both themes", () => {
    expect(AGENT_LIST_LIMIT).toBe(200);
    for (const theme of ["default", "kiroween"] as const) expect(copy[theme]["agents.truncated"]).toContain(`newest ${AGENT_LIST_LIMIT} agents`);
  });
});

describe("lastDecisions", () => {
  const decision = (agentId: string, outcome: string, tool: string, amount: string) => ({
    agent_id: agentId,
    request: { vendor: "nimbus-weather", tool, amount_micros: amount },
    decision: outcome,
    reasons: [],
  });

  it("UI-7: gives each agent's newest decision in this workspace, and skips one it can't read", async () => {
    const a = await createScene(db());
    const b = await createScene(db(), { workspaceId: a.workspaceId });
    const c = await createScene(db(), { workspaceId: a.workspaceId });
    const other = await createScene(db());
    const append = (workspaceId: string, type: EventType, payload: unknown, at: string) =>
      db().transaction((tx) => appendEvent(tx, { workspaceId, type, payload }, { key: TEST_HEAD_KEY, now: new Date(at) }));
    await append(a.workspaceId, "decision", decision(a.agent.id, "allow", "x402.pay", "1500"), "2026-11-28T10:00:00.000Z");
    await append(a.workspaceId, "decision", decision(b.agent.id, "deny", "x402.pay", "1500"), "2026-11-28T10:00:01.000Z");
    await append(a.workspaceId, "decision", decision(a.agent.id, "hold", "payout.create", "900000000"), "2026-11-28T10:00:02.000Z");
    // Not a decision, so not the newest decision.
    await append(a.workspaceId, "agent_frozen", { agent_id: a.agent.id, decision_seq: 3 }, "2026-11-28T10:00:03.000Z");
    await append(a.workspaceId, "decision", { agent_id: c.agent.id, decision: "maybe" }, "2026-11-28T10:00:04.000Z");
    await append(other.workspaceId, "decision", decision(other.agent.id, "allow", "x402.pay", "1500"), "2026-11-28T10:00:05.000Z");

    const last = await lastDecisions(db(), a.workspaceId, [a.agent.id, b.agent.id, c.agent.id, other.agent.id]);
    expect(last).toEqual({
      [a.agent.id]: { decision: "hold", tool: "payout.create", amountMicros: "900000000", at: "2026-11-28T10:00:02.000Z" },
      [b.agent.id]: { decision: "deny", tool: "x402.pay", amountMicros: "1500", at: "2026-11-28T10:00:01.000Z" },
    });
    // Only the agents asked for are read.
    expect(Object.keys(await lastDecisions(db(), a.workspaceId, [b.agent.id]))).toEqual([b.agent.id]);
    expect(await lastDecisions(db(), a.workspaceId, [])).toEqual({});
  });
});
