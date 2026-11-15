import type { Metadata } from "next";
import { ApprovalsInbox } from "@/ui/approvals/ApprovalsInbox";
import { DataState } from "@/ui/components/DataState";
import { t } from "@/ui/copy";
import { getAgentNames } from "../agent-names";
import { getDashboardContext } from "../dashboard-context";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const { workspace, user } = await getDashboardContext();
  if (!workspace) return <DataState status="empty" empty={t("workspace.none")} />;
  // The same rule the approval routes enforce (HITL-10, HITL-11): anyone in the current
  // sandbox, otherwise the signed-in owner. The routes check again; this only hides buttons.
  const canAct = workspace.isSandbox ? !workspace.retired : user !== null;
  return <ApprovalsInbox workspaceId={workspace.id} isSandbox={workspace.isSandbox} canAct={canAct} agentNames={await getAgentNames(workspace.id)} />;
}
