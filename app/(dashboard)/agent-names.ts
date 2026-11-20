import { cache } from "react";
import { type AgentList, type LastDecision, lastDecisions, listAgents } from "@/server/dashboard/agents";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";

/** The workspace's newest agents (at most AGENT_LIST_LIMIT), loaded once per request. */
export const getAgents = cache(
  (workspaceId: string): Promise<AgentList> => withDashboardDb(defaultDashboardDeps(), "agents list", (db) => listAgents(db, workspaceId)),
);

/** The newest decision of each listed agent, for the agents page only (UI-7). */
export const getLastDecisions = cache(
  (workspaceId: string, agentIds: readonly string[]): Promise<Record<string, LastDecision>> =>
    withDashboardDb(defaultDashboardDeps(), "agents last decisions", (db) => lastDecisions(db, workspaceId, agentIds)),
);

/**
 * Names for the newest agents. Pages label any other agent by the start of
 * its ID (`agentLabel`), as they already do for agents made after the page loaded.
 */
export async function getAgentNames(workspaceId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await getAgents(workspaceId)).agents.map((a) => [a.id, a.name]));
}
