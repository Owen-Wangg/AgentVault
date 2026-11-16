import type { Metadata } from "next";
import { AgentsTable } from "@/ui/agents/AgentsTable";
import { CreateAgentDialog } from "@/ui/agents/CreateAgentDialog";
import { DataState } from "@/ui/components/DataState";
import { PageTitle } from "@/ui/components/primitives";
import { getCopy } from "@/ui/server-copy";
import { getAgents } from "../agent-names";
import { getDashboardContext } from "../dashboard-context";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage() {
  const [{ workspace, user }, { t }] = await Promise.all([getDashboardContext(), getCopy()]);
  if (!workspace) return <DataState status="empty" empty={t("workspace.none")} />;
  // A signed-in user's context is always their own workspace; the sandbox is open to unfreeze (HITL-11)
  // but read-only for creating agents (see src/server/agents/handlers.ts).
  const owner = user !== null && !workspace.isSandbox;
  const canUnfreeze = owner || (workspace.isSandbox && !workspace.retired);
  return (
    <>
      <PageTitle actions={owner ? <CreateAgentDialog /> : null}>{t("agents.title")}</PageTitle>
      {!owner ? <p className="mb-4 text-sm text-text-muted">{t("agents.signInToEdit")}</p> : null}
      <AgentsTable agents={await getAgents(workspace.id)} canUnfreeze={canUnfreeze} />
    </>
  );
}
