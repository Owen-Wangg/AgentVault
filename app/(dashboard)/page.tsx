import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";
import { testnetRailReady } from "@/server/testnet/available";
import { findTestnetWorkspace } from "@/server/testnet/workspace";
import { DataState } from "@/ui/components/DataState";
import { getCopy } from "@/ui/server-copy";
import { OverviewView } from "@/ui/overview/OverviewView";
import type { Tour } from "@/ui/overview/TourCard";
import { getAgentNames } from "./agent-names";
import { getDashboardContext } from "./dashboard-context";

export default async function OverviewPage() {
  const { workspace } = await getDashboardContext();
  if (!workspace) return <DataState status="empty" empty={(await getCopy()).t("workspace.none")} />;
  // UI-23: the tour is for the public sandbox only.
  const tour = workspace.isSandbox ? await sandboxTour() : undefined;
  return <OverviewView workspaceId={workspace.id} agentNames={await getAgentNames(workspace.id)} tour={tour} />;
}

/**
 * The tour's testnet step appears only where /scenarios shows the testnet
 * card (testnet-demo TN-1), checked the same way. A failed check drops
 * the step rather than the overview.
 */
async function sandboxTour(): Promise<Tour> {
  if (!testnetRailReady()) return { testnet: false };
  try {
    const testnet = await withDashboardDb(defaultDashboardDeps(), "overview tour", async (db) => (await findTestnetWorkspace(db)) !== null);
    return { testnet };
  } catch {
    return { testnet: false };
  }
}
