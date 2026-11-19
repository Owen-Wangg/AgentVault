import { and, asc, desc, eq, sql } from "drizzle-orm";
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
 * Each agent's newest `decision` event in the workspace, keyed by agent ID.
 * One pass over the workspace's decisions (DISTINCT ON keeps the highest
 * seq per agent), read from the audit log the decisions are written to.
 * A payload this can't read is left out, so that agent shows no decision.
 */
export async function lastDecisions(db: Db, workspaceId: string): Promise<Record<string, LastDecision>> {
  const rows = await db
    .selectDistinctOn([sql`${auditEvents.payload}->>'agent_id'`], { payload: auditEvents.payload, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.type, "decision")))
    .orderBy(sql`${auditEvents.payload}->>'agent_id'`, desc(auditEvents.seq));
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

// The subqueries name the outer column as "agents"."id": Drizzle renders
// ${agents.id} unqualified here, and inside the subquery "id" would mean
// sessions.id.
export async function listAgents(db: Db, workspaceId: string): Promise<AgentSummary[]> {
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
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    frozenAt: r.frozenAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    tainted: r.tainted === true || (r.tainted as unknown) === "t",
    taintSourceUrl: r.taintSourceUrl,
  }));
}
