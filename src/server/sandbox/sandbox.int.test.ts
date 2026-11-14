import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { loadChain, verifyChain } from "@/server/audit/append";
import { type Database, queryRows } from "@/server/db/client";
import { decodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes, tasks, vendors, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { currentSandbox, ensureSandbox, resetSandbox } from "./sandbox";
import { SEED_AGENTS, SEED_TASKS, SEED_VENDORS } from "./seed-data";

const options = { key: TEST_HEAD_KEY, appOrigin: "https://agentvault.example" };
let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const auditRowCount = async () =>
  (await queryRows<{ n: number }>(database.db, sql`SELECT count(*)::int AS n FROM audit_events`))[0]!.n;

describe("AUD-9: sandbox workspaces", () => {
  it("AUD-9: the first reset creates a seeded sandbox whose first event is sandbox_created", async () => {
    const { workspaceId, retired } = await resetSandbox(database.db, options);
    expect(retired).toEqual([]);
    expect((await currentSandbox(database.db))?.id).toBe(workspaceId);

    const { events } = await loadChain(database.db, workspaceId);
    expect(events.map((e) => e.type)).toEqual(["sandbox_created"]);
    expect(events[0]?.payload).toMatchObject({ previous_workspace_id: null, agents: SEED_AGENTS.length });
    expect(await verifyChain(database.db, workspaceId, options)).toEqual({ ok: true, count: 1, headSeq: 1 });

    const seededVendors = await database.db.select().from(vendors).where(eq(vendors.workspaceId, workspaceId));
    expect(seededVendors.map((v) => [v.name, v.origin, v.category, v.trusted]).sort()).toEqual(
      SEED_VENDORS.map((v) => [v.name, "https://agentvault.example", v.category, v.trusted]).sort(),
    );
    const seededTasks = await database.db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId));
    expect(seededTasks.map((t) => t.budgetMicros).sort()).toEqual(SEED_TASKS.map((t) => t.budgetMicros).sort());
  });

  it("AUD-9: seeded envelopes decode back to the seed data", async () => {
    const ws = (await currentSandbox(database.db))!.id;
    const rows = await database.db
      .select({ name: agents.name, agentId: agents.id, envelope: envelopes })
      .from(agents)
      .innerJoin(envelopes, eq(envelopes.agentId, agents.id))
      .where(eq(agents.workspaceId, ws));
    for (const seedAgent of SEED_AGENTS) {
      const row = rows.find((r) => r.name === seedAgent.name)!;
      expect(decodeEnvelope(row.agentId, row.envelope)).toEqual({ agentId: row.agentId, ...seedAgent.envelope });
    }
  });

  it("AUD-9: a reset retires the old sandbox, revokes its agents, and leaves its chain verifiable", async () => {
    const old = (await currentSandbox(database.db))!.id;
    const oldEventsBefore = (await loadChain(database.db, old)).events;
    const rowsBefore = await auditRowCount();

    const { workspaceId, retired } = await resetSandbox(database.db, options);

    expect(retired).toEqual([old]);
    expect(workspaceId).not.toBe(old);
    expect((await currentSandbox(database.db))?.id).toBe(workspaceId);

    const [oldWs] = await database.db.select().from(workspaces).where(eq(workspaces.id, old));
    expect(oldWs?.retiredAt).toBeInstanceOf(Date);
    const activeOldAgents = await database.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, old), isNull(agents.revokedAt)));
    expect(activeOldAgents).toEqual([]);

    // The old chain keeps every earlier row unchanged and gains sandbox_retired.
    const oldEventsAfter = (await loadChain(database.db, old)).events;
    expect(oldEventsAfter.slice(0, oldEventsBefore.length)).toEqual(oldEventsBefore);
    expect(oldEventsAfter.at(-1)).toMatchObject({ type: "sandbox_retired", payload: { successor_workspace_id: workspaceId } });
    expect((await verifyChain(database.db, old, options)).ok).toBe(true);
    expect((await verifyChain(database.db, workspaceId, options)).ok).toBe(true);
    expect((await loadChain(database.db, workspaceId)).events[0]?.payload).toMatchObject({ previous_workspace_id: old });

    // Never fewer audit rows: one sandbox_created plus one sandbox_retired.
    expect(await auditRowCount()).toBe(rowsBefore + 2);
  });

  it("AUD-9: repeated resets never lower the audit row count and keep every chain verifiable", async () => {
    let count = await auditRowCount();
    for (let i = 0; i < 3; i += 1) {
      await resetSandbox(database.db, options);
      const next = await auditRowCount();
      expect(next).toBeGreaterThan(count);
      count = next;
    }
    const sandboxes = await database.db.select({ id: workspaces.id, retiredAt: workspaces.retiredAt }).from(workspaces);
    expect(sandboxes.filter((w) => w.retiredAt === null)).toHaveLength(1);
    for (const { id } of sandboxes) expect((await verifyChain(database.db, id, options)).ok).toBe(true);
  });

  it("AUD-9: ensureSandbox keeps the current sandbox", async () => {
    const current = (await currentSandbox(database.db))!.id;
    expect(await ensureSandbox(database.db, options)).toEqual({ workspaceId: current, created: false });
  });
});
