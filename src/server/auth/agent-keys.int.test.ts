import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { createAgent } from "@/server/agents/agents";
import type { Database } from "@/server/db/client";
import { agents } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { createWorkspace } from "@/server/sandbox/sandbox";
import { KEY_PREFIX, authenticateAgent, generateApiKey, hashApiKey } from "./agent-keys";

let database: Database;
let workspaceId: string;

beforeAll(async () => {
  database = await createTestDb();
  workspaceId = await database.db.transaction((tx) => createWorkspace(tx, { name: "keys", isSandbox: false }, { key: TEST_HEAD_KEY }));
}, 60_000);

afterAll(async () => {
  await database?.close();
});

const envelope = { limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: "*" as const, allowedTools: "*" as const };
const newAgent = () => database.db.transaction((tx) => createAgent(tx, { workspaceId, name: "agent", envelope }));

describe("PXY-1: key generation", () => {
  it("PXY-1: keys have the av_test_ prefix and 256 bits of randomness", () => {
    const { key } = generateApiKey();
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(Buffer.from(key.slice(KEY_PREFIX.length), "base64url")).toHaveLength(32);
  });

  it("PXY-1: keys don't repeat", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it("PXY-1: only the SHA-256 hash is stored, never the key", async () => {
    const { agentId, apiKey } = await newAgent();
    const [row] = await database.db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.apiKeyHash).toBe(hashApiKey(apiKey));
    expect(JSON.stringify(row)).not.toContain(apiKey);
    expect(JSON.stringify(row)).not.toContain(apiKey.slice(KEY_PREFIX.length));
  });
});

describe("PXY-2, PXY-3: authentication", () => {
  it("PXY-2: a valid bearer key finds its agent", async () => {
    const { agentId, apiKey } = await newAgent();
    expect(await authenticateAgent(database.db, `Bearer ${apiKey}`)).toEqual({ id: agentId, workspaceId, name: "agent" });
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["a key without Bearer", "KEY"],
    ["the wrong scheme", "Basic KEY"],
    ["lowercase bearer", "bearer KEY"],
    ["an unknown key", `Bearer ${KEY_PREFIX}${"A".repeat(43)}`],
    ["a key with the wrong prefix", `Bearer av_live_${"A".repeat(43)}`],
    ["a truncated key", "Bearer TRUNCATED"],
  ])("PXY-3: rejects %s", async (_name, header) => {
    const { apiKey } = await newAgent();
    const value = header?.replace("KEY", apiKey).replace("TRUNCATED", apiKey.slice(0, -1)) ?? null;
    expect(await authenticateAgent(database.db, value)).toBeNull();
  });

  it("PXY-3: a revoked key is rejected", async () => {
    const { agentId, apiKey } = await newAgent();
    await database.db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
    expect(await authenticateAgent(database.db, `Bearer ${apiKey}`)).toBeNull();
  });
});
