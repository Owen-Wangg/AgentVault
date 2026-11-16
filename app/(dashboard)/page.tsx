import { DataState } from "@/ui/components/DataState";
import { getCopy } from "@/ui/server-copy";
import { OverviewView } from "@/ui/overview/OverviewView";
import { getAgentNames } from "./agent-names";
import { getDashboardContext } from "./dashboard-context";

export default async function OverviewPage() {
  const { workspace } = await getDashboardContext();
  if (!workspace) return <DataState status="empty" empty={(await getCopy()).t("workspace.none")} />;
  return <OverviewView workspaceId={workspace.id} agentNames={await getAgentNames(workspace.id)} />;
}
