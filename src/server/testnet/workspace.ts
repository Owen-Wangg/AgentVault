import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type Micros, fromDecimalString, toMicrosString } from "@/core/money";
import type { Envelope } from "@/core/policy";
import { appendEvent } from "@/server/audit/append";
import { type Db, type Tx, queryRows } from "@/server/db/client";
import { encodeEnvelope } from "@/server/db/envelope-json";
import { agents, envelopes, tasks, vendors, workspaces } from "@/server/db/schema";
import { createWorkspace } from "@/server/sandbox/sandbox";

/**
 * The public testnet workspace (testnet-demo TN-9): the one workspace a
 * visitor can reach a real rail through, with one vendor, one task, and
 * one demo agent whose key nobody has. Not a sandbox, so with
 * RAIL_MODE=real its payments go to the real x402 adapter.
 */

export const TESTNET_VENDOR = "nimbus-weather";
/** The hosted weather endpoint's path. Must match WEATHER_PATH in src/server/vendor/weather.ts (a test checks). */
export const TESTNET_X402_PATH = "/vendor/api/weather";
/** The one payment a press makes. Must match WEATHER_PRICE, what the vendor charges (a test checks). */
export const TESTNET_PRICE: Micros = fromDecimalString("0.0015");
export const TESTNET_AGENT_NAME = "testnet-demo-agent";

/** TN-6: x402 to nimbus-weather only, $0.01 a payment, $0.05 a day, and 30 calls a minute, above the endpoint's 6. */
export const TESTNET_ENVELOPE: Omit<Envelope, "agentId"> = {
  limits: { txMaxMicros: fromDecimalString("0.01"), windowCapsMicros: { day: fromDecimalString("0.05") }, callsPerMinute: 30 },
  vendorLimits: {},
  toolLimits: {},
  allowedVendors: [TESTNET_VENDOR],
  allowedTools: ["x402.pay"],
};

/** The task every press's session runs under. It allows no high-privilege tool, so nothing can be held for approval. */
export const TESTNET_TASK = {
  description: "Make one real testnet payment",
  allowedVendorCategories: ["weather"],
  allowedTools: ["x402.pay"],
  budgetMicros: fromDecimalString("0.01"),
} as const;

export interface TestnetWorkspace {
  workspaceId: string;
  agentId: string;
  taskId: string;
}

/** An API key hash that matches no key, as the sandbox seed uses: only the server acts as this agent. */
const unusableKeyHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

/** The testnet workspace's IDs, or null if there is none. */
export async function findTestnetWorkspace(db: Db | Tx): Promise<TestnetWorkspace | null> {
  const [row] = await db
    .select({ workspaceId: workspaces.id, agentId: agents.id, taskId: tasks.id })
    .from(workspaces)
    .innerJoin(agents, and(eq(agents.workspaceId, workspaces.id), eq(agents.name, TESTNET_AGENT_NAME)))
    .innerJoin(tasks, and(eq(tasks.workspaceId, workspaces.id), eq(tasks.description, TESTNET_TASK.description)))
    .where(eq(workspaces.publicTestnet, true))
    .limit(1);
  return row ?? null;
}

/**
 * Create the testnet workspace, its vendor, task, and demo agent, and a
 * `testnet_workspace_created` event, in one transaction. If one exists,
 * return it and create nothing. A transaction-scoped advisory lock makes
 * concurrent runs wait, and the database refuses a second one anyway.
 */
export async function createTestnetWorkspace(
  db: Db,
  options: { appOrigin: string; key?: Uint8Array; now?: Date },
): Promise<TestnetWorkspace & { created: boolean }> {
  const origin = new URL(options.appOrigin).origin;
  const now = options.now ?? new Date();
  const keyOption = options.key ? { key: options.key } : {};
  return db.transaction(async (tx) => {
    await queryRows(tx, sql`SELECT pg_advisory_xact_lock(hashtext('agentvault:testnet-setup'))`);
    const existing = await findTestnetWorkspace(tx);
    if (existing) return { ...existing, created: false };

    const workspaceId = await createWorkspace(tx, { name: "Public testnet demo", isSandbox: false }, { ...keyOption, now });
    await tx.update(workspaces).set({ publicTestnet: true }).where(eq(workspaces.id, workspaceId));
    const x402Url = `${origin}${TESTNET_X402_PATH}`;
    await tx.insert(vendors).values({ workspaceId, name: TESTNET_VENDOR, origin, category: "weather", trusted: false, x402Url });
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId,
        description: TESTNET_TASK.description,
        allowedVendorCategories: [...TESTNET_TASK.allowedVendorCategories],
        allowedTools: [...TESTNET_TASK.allowedTools],
        budgetMicros: TESTNET_TASK.budgetMicros,
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error("Task insert returned no row");
    const [agent] = await tx
      .insert(agents)
      .values({ workspaceId, name: TESTNET_AGENT_NAME, apiKeyHash: unusableKeyHash(), createdAt: now })
      .returning({ id: agents.id });
    if (!agent) throw new Error("Agent insert returned no row");
    await tx.insert(envelopes).values({ agentId: agent.id, ...encodeEnvelope(TESTNET_ENVELOPE) });
    const { limits } = TESTNET_ENVELOPE;
    await appendEvent(
      tx,
      {
        workspaceId,
        type: "testnet_workspace_created",
        payload: {
          agent_id: agent.id,
          vendor: TESTNET_VENDOR,
          x402_url: x402Url,
          amount_micros: toMicrosString(TESTNET_PRICE),
          tx_max_micros: limits.txMaxMicros ? toMicrosString(limits.txMaxMicros) : null,
          day_cap_micros: limits.windowCapsMicros?.day ? toMicrosString(limits.windowCapsMicros.day) : null,
          calls_per_minute: limits.callsPerMinute ?? null,
        },
      },
      { ...keyOption, now },
    );
    return { workspaceId, agentId: agent.id, taskId: task.id, created: true };
  });
}
