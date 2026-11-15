import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { createScene, taintSession } from "@/server/payments/test-fixtures";
import { listAgents } from "./agents";

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

    const list = await listAgents(db(), scene.workspaceId);
    expect(list.map((a) => a.id)).toEqual([scene.agent.id, second.agent.id]);
    expect(list.map((a) => a.id)).not.toContain(elsewhere.agent.id);
    expect(list[0]).toMatchObject({ frozenAt: "2026-11-24T10:00:00.000Z", tainted: false, taintSourceUrl: null, revokedAt: null });
    expect(list[1]).toMatchObject({ frozenAt: null, tainted: true, taintSourceUrl: "https://agentvault.example/vendor/docs/integration" });
  });
});
