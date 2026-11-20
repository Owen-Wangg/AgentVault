import type { Metadata } from "next";
import { EVENT_TYPES, type EventType } from "@/core/audit/chain";
import { listAuditEvents } from "@/server/dashboard/audit";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";
import { AuditLog } from "@/ui/audit/AuditLog";
import { DataState } from "@/ui/components/DataState";
import { getCopy } from "@/ui/server-copy";
import { getAgentNames } from "../agent-names";
import { getDashboardContext } from "../dashboard-context";

export const metadata: Metadata = { title: "Audit log" };

/** A positive integer seq from `?before=`, or undefined for the newest page. */
function cursor(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

/** A known event type from `?type=`, or undefined for all events. Anything else is ignored (UI-31). */
function eventType(value: string | string[] | undefined): EventType | undefined {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value) ? (value as EventType) : undefined;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspace } = await getDashboardContext();
  if (!workspace) return <DataState status="empty" empty={(await getCopy()).t("workspace.none")} />;
  const params = await searchParams;
  const before = cursor(params.before);
  const type = eventType(params.type);
  const page = await withDashboardDb(defaultDashboardDeps(), "audit list", (db) =>
    listAuditEvents(db, workspace.id, { ...(before === undefined ? {} : { before }), ...(type === undefined ? {} : { type }) }),
  );
  return (
    <AuditLog
      workspaceId={workspace.id}
      events={page.events}
      older={page.older}
      isFirstPage={before === undefined}
      agentNames={await getAgentNames(workspace.id)}
      sandbox={workspace.isSandbox}
      {...(type === undefined ? {} : { type })}
    />
  );
}
