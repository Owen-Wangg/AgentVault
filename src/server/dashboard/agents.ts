import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { agents } from "@/server/db/schema";

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
