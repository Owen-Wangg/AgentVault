import { cache } from "react";
import { type AgentSummary, listAgents } from "@/server/dashboard/agents";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";

/** The workspace's agents, loaded once per request. */
export const getAgents = cache(
  (workspaceId: string): Promise<AgentSummary[]> => withDashboardDb(defaultDashboardDeps(), "agents list", (db) => listAgents(db, workspaceId)),
);

export async function getAgentNames(workspaceId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await getAgents(workspaceId)).map((a) => [a.id, a.name]));
}
