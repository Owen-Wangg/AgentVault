"use client";

import { useMemo, useState } from "react";
import { REASON_CODES } from "@/core/policy";
import { Amount } from "@/ui/components/Amount";
import { DataState } from "@/ui/components/DataState";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import { Badge, PageTitle } from "@/ui/components/primitives";
import { useCopy } from "@/ui/ThemeProvider";
import { type DecisionKind, type FeedFilter, type FeedRow, feedRows, filterRows } from "@/ui/events/summarize";
import { type EventStreamOptions, useEventStream } from "@/ui/events/use-event-stream";
import { agentLabel } from "./agent-label";

/** Rows rendered at once. The feed is newest first, so older rows drop off. */
const MAX_ROWS = 300;

const DECISION_TONE: Record<DecisionKind, "allow" | "hold" | "deny"> = { allow: "allow", hold: "hold", deny: "deny" };

/** The live feed (UI-6): each decision with time, agent, vendor, amount, decision, and reasons in plain language. */
export function FeedView({ workspaceId, agentNames, stream }: { workspaceId: string; agentNames: Record<string, string>; stream?: EventStreamOptions }) {
  const { t } = useCopy();
  const { events, status, ready, resume } = useEventStream(workspaceId, stream);
  const [filter, setFilter] = useState<FeedFilter>({});
  const rows = useMemo(() => feedRows(events), [events]);
  const shown = useMemo(() => filterRows(rows, filter).slice(0, MAX_ROWS), [rows, filter]);
  const agentIds = useMemo(() => [...new Set([...Object.keys(agentNames), ...rows.map((r) => r.agentId)])], [agentNames, rows]);

  const set = (key: keyof FeedFilter) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setFilter((f) => {
      const next = { ...f };
      if (e.target.value === "") delete next[key];
      else (next as Record<string, string>)[key] = e.target.value;
      return next;
    });

  const status_ = !ready && rows.length === 0 ? "loading" : shown.length === 0 ? "empty" : "ready";

  return (
    <>
      <PageTitle actions={<StreamStatusBadge status={status} onResume={resume} />}>{t("feed.title")}</PageTitle>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FilterSelect label={t("feed.filterAgent")} value={filter.agentId ?? ""} onChange={set("agentId")}>
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {agentLabel(agentNames, id)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={t("feed.filterDecision")} value={filter.decision ?? ""} onChange={set("decision")}>
          {(["allow", "hold", "deny"] as const).map((d) => (
            <option key={d} value={d}>
              {t(`decision.${d}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={t("feed.filterReason")} value={filter.reason ?? ""} onChange={set("reason")}>
          {REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </FilterSelect>
      </div>
      <DataState status={status_} empty={t("feed.empty")}>
        {/* `relative` keeps the cells' sr-only text inside the scrolling box (UI-14). */}
        <div className="relative overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">{t("feed.title")}</caption>
            <thead className="border-b border-border bg-surface-muted text-text-muted">
              <tr>
                {(["feed.time", "feed.agent", "feed.vendor", "feed.amount", "feed.decision", "feed.reasons"] as const).map((k) => (
                  <th key={k} scope="col" className="px-3 py-2 font-medium">
                    {t(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((row) => (
                <Row key={row.seq} row={row} agentNames={agentNames} />
              ))}
            </tbody>
          </table>
        </div>
      </DataState>
    </>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void; children: React.ReactNode }) {
  const { t } = useCopy();
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-text-muted">{label}</span>
      <select value={value} onChange={onChange} className="min-h-10 rounded-card border border-control-border bg-surface px-2">
        <option value="">{t("feed.any")}</option>
        {children}
      </select>
    </label>
  );
}

function Row({ row, agentNames }: { row: FeedRow; agentNames: Record<string, string> }) {
  const { t, reasonText } = useCopy();
  return (
    <tr className="align-top">
      <td className="whitespace-nowrap px-3 py-2">
        <time dateTime={row.at}>{new Date(row.at).toLocaleTimeString()}</time>
      </td>
      <td className="px-3 py-2">{agentLabel(agentNames, row.agentId)}</td>
      <td className="px-3 py-2">
        {row.vendor}
        <span className="block font-mono text-xs text-text-muted">{row.tool}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <Amount value={row.amountMicros} />
      </td>
      <td className="px-3 py-2">
        <Badge tone={DECISION_TONE[row.decision]}>{t(`decision.${row.decision}`)}</Badge>
        {row.railStatus && row.railStatus !== "settled" ? <span className="mt-1 block text-xs text-text-muted">{row.railStatus}</span> : null}
      </td>
      <td className="px-3 py-2">
        {row.reasons.length === 0 ? (
          <span className="text-text-muted">{t("feed.noReasons")}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {row.reasons.map((r) => (
              <li key={r.code}>{reasonText(r.code)}</li>
            ))}
          </ul>
        )}
        {row.payeeChange ? (
          // payout-rails PO-12. References render as text, never as links.
          <p className="mt-1 text-xs" data-testid="payee-change">
            <span className="font-medium">{t("feed.payeeChanged")}</span>{" "}
            <span className="font-mono">{row.payeeChange.oldRef ?? t("feed.payeeNone")}</span> {t("feed.payeeTo")}{" "}
            <span className="font-mono">{row.payeeChange.newRef}</span>
          </p>
        ) : null}
        {row.payoutTo ? (
          // payout-rails PO-24: where the money went. Text, never a link.
          <p className="mt-1 text-xs" data-testid="payout-to">
            <span className="font-medium">{t("feed.payoutTo")}</span> <span className="font-mono">{row.payoutTo}</span>
          </p>
        ) : null}
      </td>
    </tr>
  );
}
