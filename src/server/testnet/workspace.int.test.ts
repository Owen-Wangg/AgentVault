import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import { decodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes, vendors, workspaces } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { eventsOf } from "@/server/payments/test-fixtures";
import { WEATHER_PATH, WEATHER_PRICE } from "@/server/vendor/weather";
import { TESTNET_ENVELOPE, TESTNET_PRICE, TESTNET_X402_PATH, createTestnetWorkspace, findTestnetWorkspace } from "./workspace";

let database: Awaited<ReturnType<typeof createTestDb>>;
const db = () => database.db;
beforeAll(async () => {
  database = await createTestDb();
}, 60_000);
afterAll(async () => {
  await database?.close();
});

const ORIGIN = "https://agentvault.example";

describe("the public testnet workspace", () => {
  it("TN-9: setup creates the workspace, vendor, task, demo agent, and envelope, and a second run changes nothing", async () => {
    expect(await findTestnetWorkspace(db())).toBeNull();
    const first = await createTestnetWorkspace(db(), { appOrigin: `${ORIGIN}/ignored/path`, key: TEST_HEAD_KEY });
    expect(first.created).toBe(true);
    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, first.workspaceId));
    expect(ws).toMatchObject({ isSandbox: false, publicTestnet: true, ownerUserId: null, retiredAt: null });
    const [vendor] = await db().select().from(vendors).where(eq(vendors.workspaceId, first.workspaceId));
    expect(vendor).toMatchObject({ name: "nimbus-weather", origin: ORIGIN, category: "weather", x402Url: `${ORIGIN}/vendor/api/weather`, mppUrl: null });
    const [agent] = await db().select().from(agents).where(eq(agents.id, first.agentId));
    expect(agent).toMatchObject({ workspaceId: first.workspaceId, name: "testnet-demo-agent", frozenAt: null, revokedAt: null });
    const [envelope] = await db().select().from(envelopes).where(eq(envelopes.agentId, first.agentId));
    if (!envelope) throw new Error("no envelope row");
    expect(decodeEnvelope(first.agentId, envelope)).toEqual({ agentId: first.agentId, ...TESTNET_ENVELOPE });
    const events = await eventsOf(db(), first.workspaceId);
    expect(events.map((e) => e.type)).toEqual(["testnet_workspace_created"]);
    expect(events[0]?.payload).toMatchObject({ vendor: "nimbus-weather", x402_url: `${ORIGIN}/vendor/api/weather`, amount_micros: "1500", day_cap_micros: "50000" });
    expect(await verifyChain(db(), first.workspaceId, { key: TEST_HEAD_KEY })).toMatchObject({ ok: true });

    const second = await createTestnetWorkspace(db(), { appOrigin: "https://other.example", key: TEST_HEAD_KEY });
    expect(second).toEqual({ ...first, created: false });
    expect(await db().select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.publicTestnet, true))).toHaveLength(1);
  });

  it("TN-9: the database refuses a second testnet workspace, and a sandbox can never be one", async () => {
    await expect(db().insert(workspaces).values({ name: "second", isSandbox: false, publicTestnet: true })).rejects.toThrow();
    await expect(db().insert(workspaces).values({ name: "both", isSandbox: true, publicTestnet: true })).rejects.toThrow();
  });

  it("TN-2: the payment matches what the hosted vendor charges, at its path", () => {
    expect(TESTNET_PRICE).toBe(WEATHER_PRICE);
    expect(TESTNET_X402_PATH).toBe(WEATHER_PATH);
  });
});
