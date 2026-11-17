import type { Metadata } from "next";
import { LIVE_SCENARIO_NAMES } from "@/agents/gemini/scenarios";
import { SCENARIO_NAMES } from "@/agents/scripted/scenarios";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";
import { env } from "@/server/env";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { testnetRailReady } from "@/server/testnet/available";
import { findTestnetWorkspace } from "@/server/testnet/workspace";
import { DataState } from "@/ui/components/DataState";
import { getCopy } from "@/ui/server-copy";
import { ScenarioRunner } from "@/ui/scenarios/ScenarioRunner";
import { TestnetPaymentCard } from "@/ui/scenarios/TestnetPaymentCard";
export const metadata: Metadata = { title: "Scenarios" };
/**
 * Scenarios always run in the current public sandbox (demo-agents AGT-2),
 * so the page streams the sandbox's events even for a signed-in user,
 * whose other pages show their own workspace. The real testnet payment
 * card appears only where real rails are ready and the testnet workspace
 * exists (testnet-demo TN-1); only that yes or no reaches the client.
 */
export default async function ScenariosPage() {
  const { sandbox, testnet } = await withDashboardDb(defaultDashboardDeps(), "scenarios sandbox", async (db) => ({
    sandbox: await currentSandbox(db),
    testnet: testnetRailReady() && (await findTestnetWorkspace(db)) !== null,
  }));
  if (!sandbox) return <DataState status="empty" empty={(await getCopy()).t("workspace.none")} />;
  // AGT-11: live buttons only where GEMINI_API_KEY is set. Only the scenario names reach the client, never the key.
  const liveScenarios = env.geminiEnabled() ? LIVE_SCENARIO_NAMES : [];
  return <ScenarioRunner workspaceId={sandbox.id} scenarios={SCENARIO_NAMES} liveScenarios={liveScenarios} featured={testnet ? <TestnetPaymentCard /> : null} />;
}
