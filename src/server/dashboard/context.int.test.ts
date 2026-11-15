import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import type { SessionUser } from "@/server/auth/session";
import { ensurePersonalWorkspace } from "@/server/auth/workspace-access";
import { type Database, queryRows } from "@/server/db/client";
import { users, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { createScene } from "@/server/payments/test-fixtures";
import { DashboardDataError, type DashboardDeps, loadDashboardContext } from "./context";

let database: Database & { driver: "postgres" | "pglite" };

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const db = () => database.db;

async function user(id: string, name: string | null = id): Promise<SessionUser> {
  await db().insert(users).values({ id, name }).onConflictDoNothing();
  return { id, name };
}

const personal = (userId: string) =>
  db().select().from(workspaces).where(and(eq(workspaces.ownerUserId, userId), eq(workspaces.isSandbox, false)));

const deps = (over: Partial<DashboardDeps> = {}): DashboardDeps => ({
  openDb: () => ({ db: db(), close: async () => {} }),
  getUser: async () => null,
  signInAvailable: () => false,
  key: () => TEST_HEAD_KEY,
  ...over,
});

describe("personal workspaces", () => {
  it("UI-2: the first visit creates the user's workspace with a valid empty chain; later visits open it", async () => {
    const u = await user("ui2-first", "Owen");
    const first = await ensurePersonalWorkspace(db(), u, { key: TEST_HEAD_KEY });
    expect(first).toMatchObject({ isSandbox: false, retired: false });
    const again = await ensurePersonalWorkspace(db(), u, { key: TEST_HEAD_KEY });
    expect(again.id).toBe(first.id);
    const rows = await personal(u.id);
    expect(rows.map((r) => [r.id, r.name])).toEqual([[first.id, "Owen's workspace"]]);
    expect(await verifyChain(db(), first.id, { key: TEST_HEAD_KEY })).toMatchObject({ ok: true, headSeq: 0 });
  });

  it("UI-2: concurrent first visits create one workspace", async () => {
    // PGlite has one connection, so the calls would run one after another anyway.
    const u = await user("ui2-race", null);
    // Open several pool connections first. Otherwise the pool connects one at a
    // time and the first call can finish before the others start.
    await Promise.all(Array.from({ length: 6 }, () => queryRows(db(), sql`SELECT pg_sleep(0.2)`)));
    const results = await Promise.all(Array.from({ length: 6 }, () => ensurePersonalWorkspace(db(), u, { key: TEST_HEAD_KEY })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await personal(u.id)).map((r) => r.name)).toEqual(["My workspace"]);
  });

  it("UI-2: a sandbox is never anyone's personal workspace", async () => {
    const u = await user("ui2-sandbox");
    const sandbox = await createScene(db(), { isSandbox: true });
    const own = await ensurePersonalWorkspace(db(), u, { key: TEST_HEAD_KEY });
    expect(own.id).not.toBe(sandbox.workspaceId);
  });
});

describe("dashboard context", () => {
  it("UI-1: a visitor who isn't signed in sees the current sandbox", async () => {
    const sandbox = await createScene(db(), { isSandbox: true });
    const context = await loadDashboardContext(deps());
    expect(context).toEqual({ user: null, signInAvailable: false, workspace: { id: sandbox.workspaceId, name: "pay test", isSandbox: true, retired: false } });
  });

  it("UI-2: a signed-in user sees their own workspace, created on the first visit", async () => {
    const u = await user("ui2-context", "Ada");
    const context = await loadDashboardContext(deps({ getUser: async () => u, signInAvailable: () => true }));
    expect(context.user).toEqual(u);
    expect(context.signInAvailable).toBe(true);
    expect(context.workspace).toMatchObject({ name: "Ada's workspace", isSandbox: false });
    expect((await personal(u.id)).map((r) => r.id)).toEqual([context.workspace!.id]);
  });

  it("UI-15: a database failure becomes a generic error with a correlation ID", async () => {
    const failing = deps({ openDb: () => ({ db: new Proxy(db(), { get: () => { throw new Error("password=hunter2 connection refused"); } }), close: async () => {} }) });
    const error = await loadDashboardContext(failing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DashboardDataError);
    expect(String((error as Error).message)).not.toContain("hunter2");
  });
});
