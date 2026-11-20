import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { MicrosSchema, toMicrosString } from "@/core/money";
import type { Db } from "@/server/db/client";
import { agents, auditEvents } from "@/server/db/schema";

/** One agent as the dashboard shows it (UI-7). Dates are ISO strings so the list can go to client components. */
export interface AgentSummary {
  id: string;
  name: string;
  frozenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Some session of this agent read untrusted content (TAINT-3). */
  tainted: boolean;
  /** The first tainted session's source, for the agents list. */
  taintSourceUrl: string | null;
}

/** An agent's newest decision, for the agents list (UI-7). The amount is a decimal string of micros, as on the wire. */
export interface LastDecision {
  decision: "allow" | "hold" | "deny";
  tool: string;
  amountMicros: string;
  at: string;
}

const LastDecisionPayload = z.looseObject({
  agent_id: z.string(),
  decision: z.enum(["allow", "hold", "deny"]),
  request: z.looseObject({ tool: z.string().min(1).max(64), amount_micros: MicrosSchema }),
});

/**
 * The newest `decision` event of each of `agentIds` in the workspace, keyed
 * by agent ID. Only the listed agents' decisions are read, through the
 * partial index on (workspace, payload agent_id, seq) for decisions;
 * DISTINCT ON keeps the highest seq per agent. A payload this can't read is
 * left out, so that agent shows no decision.
 */
export async function lastDecisions(db: Db, workspaceId: string, agentIds: readonly string[]): Promise<Record<string, LastDecision>> {
  if (agentIds.length === 0) return {};
  const agentIdOf = sql`(${auditEvents.payload}->>'agent_id')`;
  const rows = await db
    .selectDistinctOn([agentIdOf], { payload: auditEvents.payload, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.type, "decision"), inArray(agentIdOf, [...agentIds])))
    .orderBy(agentIdOf, desc(auditEvents.seq));
  const out: Record<string, LastDecision> = {};
  for (const row of rows) {
    const p = LastDecisionPayload.safeParse(row.payload);
    if (!p.success) continue;
    out[p.data.agent_id] = {
      decision: p.data.decision,
      tool: p.data.request.tool,
      amountMicros: toMicrosString(p.data.request.amount_micros),
      at: row.createdAt.toISOString(),
    };
  }
  return out;
}

/**
 * At most this many agents per list (UI-7): every scenario run adds one to
 * the public sandbox, so the list and the agent names every page sends to
 * the browser would otherwise grow all day.
 */
export const AGENT_LIST_LIMIT = 200;

export interface AgentList {
  /** The newest agents, oldest of them first. */
  agents: AgentSummary[];
  /** True when older agents were left out. */
  truncated: boolean;
}

// The subqueries name the outer column as "agents"."id": Drizzle renders
// ${agents.id} unqualified here, and inside the subquery "id" would mean
// sessions.id.
export async function listAgents(db: Db, workspaceId: string, limit = AGENT_LIST_LIMIT): Promise<AgentList> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      frozenAt: agents.frozenAt,
      revokedAt: agents.revokedAt,
      createdAt: agents.createdAt,
      taintSourceUrl: sql<string | null>`(
        SELECT s.taint_source_url FROM sessions s
        WHERE s.agent_id = "agents"."id" AND s.tainted_at IS NOT NULL
        ORDER BY s.tainted_at LIMIT 1)`,
      tainted: sql<boolean>`EXISTS (SELECT 1 FROM sessions s WHERE s.agent_id = "agents"."id" AND s.tainted_at IS NOT NULL)`,
    })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    // Newest first, so the cut keeps the newest; one extra row says whether there are more.
    .orderBy(desc(agents.createdAt), desc(agents.id))
    .limit(limit + 1);
  const kept = rows.slice(0, limit).reverse();
  return {
    agents: kept.map((r) => ({
      id: r.id,
      name: r.name,
      frozenAt: r.frozenAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      tainted: r.tainted === true || (r.tainted as unknown) === "t",
      taintSourceUrl: r.taintSourceUrl,
    })),
    truncated: rows.length > limit,
  };
}
