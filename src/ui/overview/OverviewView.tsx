"use client";

import { AlertTriangle, Ban, Lock, PauseCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Amount } from "@/ui/components/Amount";
import { DataState } from "@/ui/components/DataState";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import { Card, CardTitle, PageTitle } from "@/ui/components/primitives";
import { useCopy } from "@/ui/ThemeProvider";
import { type Alert, RANGES, type Range, isCapped, summarize } from "@/ui/events/summarize";
import { type EventStreamOptions, useEventStream } from "@/ui/events/use-event-stream";
import { agentLabel } from "@/ui/feed/agent-label";
import { DecisionsChart, SpendChart } from "./Charts";

/** The overview page (UI-5): KPI cards, spend over time, decisions by outcome, and recent alerts. */
export function OverviewView({
  workspaceId,
  agentNames,
  now = Date.now,
  stream,
}: {
  workspaceId: string;
  agentNames: Record<string, string>;
  now?: () => number;
  stream?: EventStreamOptions;
}) {
  const { t } = useCopy();
  const { events, status, ready } = useEventStream(workspaceId, stream);
  const [range, setRange] = useState<Range>("day");
  // Recomputed when events arrive or the range changes; `now` is read then.
  const overview = useMemo(() => summarize(events, range, now()), [events, range, now]);

  return (
    <>
      <PageTitle
        actions={
          <div className="flex items-center gap-3">
            <StreamStatusBadge status={status} />
            <label className="flex items-center gap-2 text-sm">
              <span className="text-text-muted">{t("overview.range")}</span>
              <select
                value={range}
                onChange={(e) => setRange(e.target.value as Range)}
                className="min-h-10 rounded-card border border-border bg-surface px-2 text-sm"
              >
                {RANGES.map((r) => (
                  <option key={r} value={r}>
                    {t(`range.${r}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      >
        {t("overview.title")}
      </PageTitle>
      <DataState status={ready || events.length > 0 ? "ready" : "loading"} empty="">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label={t("overview.spend")}>
            {isCapped(overview.spendMicros) ? "≥ " : null}
            <Amount value={overview.spendMicros} />
          </Kpi>
          <Kpi label={t("overview.blocked")}>
            {isCapped(overview.blockedMicros) ? "≥ " : null}
            <Amount value={overview.blockedMicros} className="text-deny" />
          </Kpi>
          <Kpi label={t("overview.held")}>{overview.pendingApprovals}</Kpi>
          <Kpi label={t("overview.frozen")}>{overview.frozenAgents.length}</Kpi>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardTitle>{t("overview.spendOverTime")}</CardTitle>
            <SpendChart series={overview.spendSeries} range={range} />
          </Card>
          <Card>
            <CardTitle>{t("overview.decisions")}</CardTitle>
            <DecisionsChart decisions={overview.decisions} />
          </Card>
        </div>
        <Card className="mt-4">
          <CardTitle>{t("overview.alerts")}</CardTitle>
          {overview.alerts.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">{t("overview.noAlerts")}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {overview.alerts.map((a) => (
                <AlertItem key={`${a.kind}-${a.seq}`} alert={a} agentNames={agentNames} />
              ))}
            </ul>
          )}
        </Card>
      </DataState>
    </>
  );
}

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardTitle>{label}</CardTitle>
      <p className="mt-2 text-2xl font-semibold">{children}</p>
    </Card>
  );
}

function AlertItem({ alert, agentNames }: { alert: Alert; agentNames: Record<string, string> }) {
  const { t, reasonText } = useCopy();
  const when = new Date(alert.at).toLocaleTimeString();
  if (alert.kind === "frozen") {
    return (
      <li className="flex items-start gap-3 py-2 text-sm">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-deny" />
        <span>
          <span className="font-medium">{agentLabel(agentNames, alert.agentId)}</span>: {t("agents.frozen")} · <time dateTime={alert.at}>{when}</time>
        </span>
      </li>
    );
  }
  if (alert.kind === "taint") {
    return (
      <li className="flex items-start gap-3 py-2 text-sm">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-hold" />
        <span className="min-w-0">
          <span className="font-medium">{agentLabel(agentNames, alert.agentId)}</span>: {t("agents.tainted")} · <span className="break-all font-mono text-xs">{alert.url}</span> ·{" "}
          <time dateTime={alert.at}>{when}</time>
        </span>
      </li>
    );
  }
  const { row } = alert;
  const Icon = row.decision === "deny" ? Ban : PauseCircle;
  return (
    <li className="flex items-start gap-3 py-2 text-sm">
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${row.decision === "deny" ? "text-deny" : "text-hold"}`} />
      <span>
        <span className="font-medium">{agentLabel(agentNames, row.agentId)}</span> → {row.vendor} <Amount value={row.amountMicros} />:{" "}
        {row.reasons.map((r) => reasonText(r.code)).join(" ")} · <time dateTime={row.at}>{when}</time>
      </span>
    </li>
  );
}
