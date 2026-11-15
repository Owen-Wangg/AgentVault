import type { Metadata } from "next";
import { listAuditEvents } from "@/server/dashboard/audit";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";
import { AuditLog } from "@/ui/audit/AuditLog";
import { DataState } from "@/ui/components/DataState";
import { t } from "@/ui/copy";
import { getAgentNames } from "../agent-names";
import { getDashboardContext } from "../dashboard-context";

export const metadata: Metadata = { title: "Audit log" };

/** A positive integer seq from `?before=`, or undefined for the newest page. */
function cursor(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspace } = await getDashboardContext();
  if (!workspace) return <DataState status="empty" empty={t("workspace.none")} />;
  const before = cursor((await searchParams).before);
  const page = await withDashboardDb(defaultDashboardDeps(), "audit list", (db) => listAuditEvents(db, workspace.id, before === undefined ? {} : { before }));
  return <AuditLog workspaceId={workspace.id} events={page.events} older={page.older} isFirstPage={before === undefined} agentNames={await getAgentNames(workspace.id)} />;
}
