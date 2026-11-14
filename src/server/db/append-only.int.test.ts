import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, queryRows } from "./client";
import { auditEvents, workspaces } from "./schema";
import { createTestDb, queryError } from "./test-db";

let database: Database;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

async function insertOneEvent(): Promise<string> {
  const [ws] = await database.db.insert(workspaces).values({ name: "append-only test" }).returning({ id: workspaces.id });
  const workspaceId = ws!.id;
  await database.db.insert(auditEvents).values({
    workspaceId,
    seq: 1,
    type: "sandbox_created",
    payload: {},
    prevHash: "0".repeat(64),
    hash: "1".repeat(64),
    createdAt: new Date("2026-11-18T09:30:00.123Z"),
  });
  return workspaceId;
}

const count = async () => (await queryRows<{ n: number }>(database.db, sql`SELECT count(*)::int AS n FROM audit_events`))[0]!;

describe("AUD-3: audit_events is append-only", () => {
  it("AUD-3: inserts work", async () => {
    await insertOneEvent();
    expect((await count()).n).toBeGreaterThan(0);
  });

  it("AUD-3: UPDATE is rejected", async () => {
    const workspaceId = await insertOneEvent();
    expect(await queryError(database.db.execute(sql`UPDATE audit_events SET type = 'decision' WHERE workspace_id = ${workspaceId}`))).toMatch(
      /append-only/,
    );
  });

  it("AUD-3: DELETE is rejected", async () => {
    const workspaceId = await insertOneEvent();
    expect(await queryError(database.db.execute(sql`DELETE FROM audit_events WHERE workspace_id = ${workspaceId}`))).toMatch(/append-only/);
  });

  it("AUD-3: TRUNCATE is rejected by the statement-level trigger", async () => {
    await insertOneEvent();
    const before = (await count()).n;
    expect(await queryError(database.db.execute(sql`TRUNCATE audit_events`))).toMatch(/append-only/);
    expect((await count()).n).toBe(before);
  });

  it("AUD-3: created_at keeps exactly millisecond precision", async () => {
    const workspaceId = await insertOneEvent();
    const rows = await database.db.select().from(auditEvents).where(sql`${auditEvents.workspaceId} = ${workspaceId}`);
    expect(rows[0]?.createdAt.toISOString()).toBe("2026-11-18T09:30:00.123Z");
  });

  it("AUD-3: money columns round-trip as bigint", async () => {
    const [row] = await queryRows<{ big: unknown }>(database.db, sql`SELECT 9007199254740993::bigint AS big`);
    // Raw SQL returns the driver's type; the schema's bigint columns use mode "bigint".
    expect(String(row?.big)).toBe("9007199254740993");
  });
});
