import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headMacIsValid } from "@/core/audit";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { type Database, type Tx, queryRows } from "@/server/db/client";
import { auditEvents, auditHeads, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { AuditHeadError, appendEvent, createHead, loadChain, verifyChain } from "./append";

const key = TEST_HEAD_KEY;
const opts = { key };
let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

async function newWorkspace(): Promise<string> {
  return database.db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({ name: "append test" }).returning({ id: workspaces.id });
    await createHead(tx, ws!.id, opts);
    return ws!.id;
  });
}

const append = (workspaceId: string, payload: unknown, tx?: Tx) =>
  tx
    ? appendEvent(tx, { workspaceId, type: "decision", payload }, opts)
    : database.db.transaction((t) => appendEvent(t, { workspaceId, type: "decision", payload }, opts));

async function head(workspaceId: string) {
  const [row] = await database.db.select().from(auditHeads).where(eq(auditHeads.workspaceId, workspaceId));
  return row!;
}

describe("AUD-2, AUD-7: appendEvent", () => {
  it("AUD-2: assigns consecutive seqs and links each event to the previous hash", async () => {
    const ws = await newWorkspace();
    const a = await append(ws, { n: 1 });
    const b = await append(ws, { n: 2 });
    const c = await append(ws, { n: 3 });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.prev_hash).toBe("0".repeat(64));
    expect(b.prev_hash).toBe(a.hash);
    expect(c.prev_hash).toBe(b.hash);
    expect(await verifyChain(database.db, ws, opts)).toEqual({ ok: true, count: 3, headSeq: 3 });
  });

  it("AUD-7: moves the head to the new event and re-signs it", async () => {
    const ws = await newWorkspace();
    const e = await append(ws, { n: 1 });
    const h = await head(ws);
    expect({ seq: h.seq, hash: h.hash }).toEqual({ seq: 1, hash: e.hash });
    expect(headMacIsValid(key, ws, h)).toBe(true);
  });

  it("CJ-6: created_at is stored at millisecond precision and hashes the same after a round trip", async () => {
    const ws = await newWorkspace();
    await database.db.transaction((tx) =>
      appendEvent(tx, { workspaceId: ws, type: "taint", payload: {} }, { key, now: new Date("2026-11-18T09:30:00.123Z") }),
    );
    const { events } = await loadChain(database.db, ws);
    expect(events[0]?.created_at).toBe("2026-11-18T09:30:00.123Z");
    expect((await verifyChain(database.db, ws, opts)).ok).toBe(true);
  });

  it("CJ-3: bigint amounts are stored as digit strings and still verify", async () => {
    const ws = await newWorkspace();
    await append(ws, { amount_micros: 1500n, nested: [{ big: 10n ** 15n }] });
    const { events } = await loadChain(database.db, ws);
    expect(events[0]?.payload).toEqual({ amount_micros: "1500", nested: [{ big: "1000000000000000" }] });
    expect((await verifyChain(database.db, ws, opts)).ok).toBe(true);
  });

  it("CJ-8: a float payload is rejected and the whole transaction rolls back", async () => {
    const ws = await newWorkspace();
    await append(ws, { n: 1 });
    const before = await head(ws);
    await expect(
      database.db.transaction(async (tx) => {
        await append(ws, { n: 2 }, tx); // would succeed on its own
        await append(ws, { amount: 0.15 }, tx);
      }),
    ).rejects.toThrow("not a safe integer");
    const after = await head(ws);
    expect({ seq: after.seq, hash: after.hash }).toEqual({ seq: before.seq, hash: before.hash });
    const rows = await database.db.select().from(auditEvents).where(eq(auditEvents.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  it("AUD-8: refuses to extend a chain whose head was rewritten without the key", async () => {
    const ws = await newWorkspace();
    await append(ws, { n: 1 });
    await append(ws, { n: 2 });
    const first = (await loadChain(database.db, ws)).events[0]!;
    // Roll the head back to seq 1 without a valid MAC. Appending must not re-sign it.
    await database.db.update(auditHeads).set({ seq: 1, hash: first.hash }).where(eq(auditHeads.workspaceId, ws));
    await expect(append(ws, { n: 3 })).rejects.toThrow(AuditHeadError);
  });

  it("AUD-8: refuses to append to a workspace with no head", async () => {
    const [ws] = await database.db.insert(workspaces).values({ name: "no head" }).returning({ id: workspaces.id });
    await expect(append(ws!.id, { n: 1 })).rejects.toThrow("is missing");
  });

  it("AUD-2: chains are per workspace", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await append(a, { n: 1 });
    await append(b, { n: 1 });
    await append(a, { n: 2 });
    expect((await verifyChain(database.db, a, opts)).ok).toBe(true);
    expect(await verifyChain(database.db, b, opts)).toEqual({ ok: true, count: 1, headSeq: 1 });
  });
});

/**
 * Tamper tests (task 3): drop the append-only triggers on this throwaway
 * database to act as an attacker with database access, then check that
 * verifyChain points at the exact row. Runs last in this file.
 */
describe("AUD-4, AUD-8: tampering with the triggers dropped", () => {
  beforeAll(async () => {
    await queryRows(database.db, sql`DROP TRIGGER audit_events_no_update ON audit_events`);
    await queryRows(database.db, sql`DROP TRIGGER audit_events_no_truncate ON audit_events`);
  });

  async function chainOf(n: number): Promise<string> {
    const ws = await newWorkspace();
    for (let i = 1; i <= n; i += 1) await append(ws, { n: i, amount_micros: BigInt(i) * 1500n });
    return ws;
  }

  it("AUD-4: an edited payload is reported at its exact seq", async () => {
    const ws = await chainOf(6);
    await database.db
      .update(auditEvents)
      .set({ payload: { n: 4, amount_micros: "1" } })
      .where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} = 4`);
    expect(await verifyChain(database.db, ws, opts)).toEqual({ ok: false, brokenAtSeq: 4, why: "hash", headSeq: 6 });
  });

  it("AUD-4: a deleted middle row is reported as a gap at its seq", async () => {
    const ws = await chainOf(5);
    await database.db.delete(auditEvents).where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} = 2`);
    expect(await verifyChain(database.db, ws, opts)).toEqual({ ok: false, brokenAtSeq: 2, why: "gap", headSeq: 5 });
  });

  it.each([1, 2, 5])("AUD-8: deleting the last %s rows reports why: head at the first missing seq", async (n) => {
    const ws = await chainOf(5);
    await database.db.delete(auditEvents).where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} > ${5 - n}`);
    expect(await verifyChain(database.db, ws, opts)).toEqual({ ok: false, brokenAtSeq: 5 - n + 1, why: "head", headSeq: 5 });
  });

  it("AUD-8: deleting the tail and rolling back the head without the key is caught", async () => {
    const ws = await chainOf(4);
    const third = (await loadChain(database.db, ws)).events[2]!;
    await database.db.delete(auditEvents).where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} = 4`);
    await database.db.update(auditHeads).set({ seq: 3, hash: third.hash }).where(eq(auditHeads.workspaceId, ws));
    expect(await verifyChain(database.db, ws, opts)).toEqual({ ok: false, brokenAtSeq: 4, why: "head", headSeq: 3 });
  });

  it("AUD-8: a deleted head row is caught", async () => {
    const ws = await chainOf(2);
    await database.db.delete(auditHeads).where(eq(auditHeads.workspaceId, ws));
    expect(await verifyChain(database.db, ws, opts)).toEqual({ ok: false, brokenAtSeq: 3, why: "head", headSeq: null });
  });

  it("AUD-4: verifying in pages gives the same results as one page, at and across page boundaries", async () => {
    const ws = await chainOf(7);
    for (const pageSize of [1, 2, 3, 7, 8]) {
      expect(await verifyChain(database.db, ws, { ...opts, pageSize })).toEqual({ ok: true, count: 7, headSeq: 7 });
    }
    // seq 4 is the first row of the second page of 3, and the last of the second page of 2.
    await database.db.update(auditEvents).set({ payload: { n: 0 } }).where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} = 4`);
    for (const pageSize of [1, 2, 3, 7, 8]) {
      expect(await verifyChain(database.db, ws, { ...opts, pageSize })).toEqual({ ok: false, brokenAtSeq: 4, why: "hash", headSeq: 7 });
    }
    await database.db.delete(auditEvents).where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} >= 6`);
    expect(await verifyChain(database.db, ws, { ...opts, pageSize: 3 })).toEqual({ ok: false, brokenAtSeq: 4, why: "hash", headSeq: 7 });
  });

  it("AUD-8: a tail deleted at a page boundary is caught", async () => {
    const ws = await chainOf(6);
    await database.db.delete(auditEvents).where(sql`${auditEvents.workspaceId} = ${ws} AND ${auditEvents.seq} > 3`);
    expect(await verifyChain(database.db, ws, { ...opts, pageSize: 3 })).toEqual({ ok: false, brokenAtSeq: 4, why: "head", headSeq: 6 });
  });
});
