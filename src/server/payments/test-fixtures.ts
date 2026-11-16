import { asc, eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { type Micros, fromDecimalString } from "@/core/money";
import type { Envelope } from "@/core/policy";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { RailConfig } from "@/rails/config";
import { type MockRails, createMockRails, railFor } from "@/rails/select";
import { createAgent } from "@/server/agents/agents";
import type { AuthenticatedAgent } from "@/server/auth/agent-keys";
import { type Db, queryRows } from "@/server/db/client";
import { auditEvents, sessions, tasks, vendors } from "@/server/db/schema";
import { createWorkspace } from "@/server/sandbox/sandbox";
import type { GuardedBody, GuardedDeps } from "./guarded";

/** Test-only helpers for the pay flow. */

export const MOCK_CONFIG: RailConfig = { mode: "mock", x402Network: "eip155:84532", x402MinUnits: 1n };

/** A clock tests can move. */
export class FakeClock {
  private t: number;
  constructor(start = Date.UTC(2026, 10, 18, 9, 30)) {
    this.t = start;
  }
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

export function testDeps(db: Db, overrides: Partial<GuardedDeps> & { mocks?: MockRails; clock?: FakeClock } = {}) {
  const mocks = overrides.mocks ?? createMockRails(MOCK_CONFIG);
  const clock = overrides.clock ?? new FakeClock();
  const deps: GuardedDeps = {
    db,
    key: TEST_HEAD_KEY,
    now: clock.now,
    railFor: (rail, workspace) => railFor(rail, workspace, { config: MOCK_CONFIG, mocks }),
    ...overrides,
  };
  return { deps, mocks, clock };
}

export interface Scene {
  workspaceId: string;
  agent: AuthenticatedAgent;
  apiKey: string;
  sessionId: string;
  taskId: string;
  /** A valid weather payment body. */
  body: (over?: Partial<GuardedBody>) => GuardedBody;
}

export interface SceneTask {
  allowedVendorCategories: string[];
  allowedTools: string[];
  budgetMicros: Micros;
}

/** Mark a session tainted, as a poisoned fetch through /api/v1/fetch would. */
export async function taintSession(db: Db, sessionId: string, sourceUrl = "https://agentvault.example/vendor/docs/integration", at = new Date()) {
  await db.update(sessions).set({ taintedAt: at, taintSourceUrl: sourceUrl, taintContentSha256: "ab".repeat(32) }).where(eq(sessions.id, sessionId));
}

export const OPEN_ENVELOPE: Omit<Envelope, "agentId"> = { limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" };

/** nimbus-weather's payment URLs in a scene (rail-adapters RAIL-23). gpu-cloud has none. */
export const SCENE_X402_URL = "https://agentvault.example/vendor/api/weather";
export const SCENE_MPP_URL = "https://agentvault.example/vendor/api/report";

/** A workspace with two vendors, one task, one agent, and one session. */
export async function createScene(
  db: Db,
  options: { envelope?: Omit<Envelope, "agentId">; isSandbox?: boolean; now?: Date; workspaceId?: string; task?: Partial<SceneTask> } = {},
): Promise<Scene> {
  return db.transaction(async (tx) => {
    let workspaceId = options.workspaceId;
    if (!workspaceId) {
      workspaceId = await createWorkspace(tx, { name: "pay test", isSandbox: options.isSandbox ?? false }, { key: TEST_HEAD_KEY });
      await tx.insert(vendors).values([
        {
          workspaceId,
          name: "nimbus-weather",
          origin: "https://agentvault.example",
          category: "weather",
          trusted: false,
          x402Url: SCENE_X402_URL,
          mppUrl: SCENE_MPP_URL,
        },
        { workspaceId, name: "gpu-cloud", origin: "https://agentvault.example", category: "compute", trusted: false },
      ]);
    }
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId,
        description: "weather",
        allowedVendorCategories: ["weather"],
        allowedTools: ["x402.pay", "mpp.pay"],
        budgetMicros: fromDecimalString("1000"),
        ...options.task,
      })
      .returning({ id: tasks.id });
    const { agentId, apiKey } = await createAgent(tx, { workspaceId, name: "agent", envelope: options.envelope ?? OPEN_ENVELOPE });
    const [session] = await tx
      .insert(sessions)
      .values({ agentId, taskId: task!.id, ...(options.now ? { createdAt: options.now } : {}) })
      .returning({ id: sessions.id });
    const sessionId = session!.id;
    const wsId = workspaceId;
    return {
      workspaceId: wsId,
      agent: { id: agentId, workspaceId: wsId, name: "agent" },
      apiKey,
      sessionId,
      taskId: task!.id,
      body: (over = {}) => ({ vendor: "nimbus-weather", tool: "x402.pay", amountMicros: fromDecimalString("0.0015"), sessionId, ...over }),
    };
  });
}

export async function eventsOf(db: Db, workspaceId: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId)).orderBy(asc(auditEvents.seq));
}

/**
 * Property 1, audit before spend (PXY-5): every rail_result event points
 * at a decision event with a lower seq in the same workspace. Run at the
 * end of every pay-flow test file.
 */
export async function expectAuditBeforeSpend(db: Db): Promise<number> {
  const rows = await queryRows<{ workspace_id: string; seq: number; decision_seq: number | null; decision_type: string | null }>(
    db,
    sql`SELECT r.workspace_id, r.seq, (r.payload->>'decision_seq')::int AS decision_seq, d.type AS decision_type
        FROM audit_events r
        LEFT JOIN audit_events d ON d.workspace_id = r.workspace_id AND d.seq = (r.payload->>'decision_seq')::int
        WHERE r.type = 'rail_result'`,
  );
  for (const r of rows) {
    expect(r.decision_type, `rail_result at seq ${r.seq} has no decision event`).toBe("decision");
    expect(r.decision_seq).toBeLessThan(r.seq);
  }
  return rows.length;
}
