import { BILLING_ENVELOPE, BILLING_TASK, type ScenarioTask, WEATHER_ENVELOPE, WEATHER_TASK } from "@/agents/scripted/scenarios";
import { toMicrosString } from "@/core/money";
import { type Envelope, envelopeToWire } from "@/core/policy";
import { createAgent } from "@/server/agents/agents";
import { appendEvent } from "@/server/audit/append";
import type { Db } from "@/server/db/client";
import { sessions, tasks } from "@/server/db/schema";

/**
 * An agent, task, and session for an MCP client (`pnpm mcp:agent`).
 * Nothing else hands out a session: agents created in the dashboard get
 * none, and scenario agents keep their keys in memory. The task's scope
 * is one of the seeded presets, chosen by the person running the script,
 * never by the agent, so the agent can't widen its own limits.
 */

export const MCP_PRESETS = {
  /** Pay weather vendors over x402: $1 per call, $0.50 a minute, $1 for the task. */
  weather: { task: WEATHER_TASK, envelope: WEATHER_ENVELOPE },
  /** Weather payments and refunds: refunds up to $1,000, approval at $100 or more (ENV-8). Shows the taint hold. */
  billing: { task: BILLING_TASK, envelope: BILLING_ENVELOPE },
} as const satisfies Record<string, { task: ScenarioTask; envelope: Omit<Envelope, "agentId"> }>;

export type McpPreset = keyof typeof MCP_PRESETS;

export const isMcpPreset = (value: string): value is McpPreset => Object.hasOwn(MCP_PRESETS, value);

export interface McpAgent {
  agentId: string;
  taskId: string;
  sessionId: string;
  /** The only copy. Show it once; it is never stored or logged. */
  apiKey: string;
  eventSeq: number;
}

/** The agent, task, session, and an `mcp_agent_created` audit event, in one transaction. */
export async function createMcpAgent(
  db: Db,
  input: { workspaceId: string; name: string; preset: McpPreset; actor: string },
  options: { key: Uint8Array; now: Date },
): Promise<McpAgent> {
  const { task: scope, envelope } = MCP_PRESETS[input.preset];
  return db.transaction(async (tx) => {
    // As in the scenario runner: the new envelope row first, the audit head last (the pay flow's lock order).
    const { agentId, apiKey } = await createAgent(tx, { workspaceId: input.workspaceId, name: input.name, envelope, now: options.now });
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: input.workspaceId,
        description: scope.description,
        allowedVendorCategories: [...scope.allowedVendorCategories],
        allowedTools: [...scope.allowedTools],
        budgetMicros: scope.budgetMicros,
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error("Task insert returned no row");
    const [session] = await tx.insert(sessions).values({ agentId, taskId: task.id, createdAt: options.now }).returning({ id: sessions.id });
    if (!session) throw new Error("Session insert returned no row");
    const { limits, vendorLimits, toolLimits, allowedVendors, allowedTools } = envelopeToWire(envelope, 1);
    const event = await appendEvent(
      tx,
      {
        workspaceId: input.workspaceId,
        type: "mcp_agent_created",
        payload: {
          actor: input.actor,
          preset: input.preset,
          agent_id: agentId,
          agent_name: input.name,
          task_id: task.id,
          session_id: session.id,
          envelope: { limits, vendorLimits, toolLimits, allowedVendors, allowedTools },
          task: {
            description: scope.description,
            allowed_vendor_categories: scope.allowedVendorCategories,
            allowed_tools: scope.allowedTools,
            budget_micros: toMicrosString(scope.budgetMicros),
          },
        },
      },
      options,
    );
    return { agentId, taskId: task.id, sessionId: session.id, apiKey, eventSeq: event.seq };
  });
}
