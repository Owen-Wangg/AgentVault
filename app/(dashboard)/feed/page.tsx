import type { Metadata } from "next";
import { DataState } from "@/ui/components/DataState";
import { getCopy } from "@/ui/server-copy";
import { FeedView } from "@/ui/feed/FeedView";
import { getAgentNames } from "../agent-names";
import { getDashboardContext } from "../dashboard-context";

export const metadata: Metadata = { title: "Live feed" };

export default async function FeedPage() {
  const { workspace } = await getDashboardContext();
  if (!workspace) return <DataState status="empty" empty={(await getCopy()).t("workspace.none")} />;
  return <FeedView workspaceId={workspace.id} agentNames={await getAgentNames(workspace.id)} />;
}
