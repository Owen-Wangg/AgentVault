import type { Metadata } from "next";
import { SCENARIO_NAMES } from "@/agents/scripted/scenarios";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { DataState } from "@/ui/components/DataState";
import { t } from "@/ui/copy";
import { ScenarioRunner } from "@/ui/scenarios/ScenarioRunner";

export const metadata: Metadata = { title: "Scenarios" };

/**
 * Scenarios always run in the current public sandbox (demo-agents AGT-2),
 * so the page streams the sandbox's events even for a signed-in user,
 * whose other pages show their own workspace.
 */
export default async function ScenariosPage() {
  const sandbox = await withDashboardDb(defaultDashboardDeps(), "scenarios sandbox", (db) => currentSandbox(db));
  if (!sandbox) return <DataState status="empty" empty={t("workspace.none")} />;
  return <ScenarioRunner workspaceId={sandbox.id} scenarios={SCENARIO_NAMES} />;
}
