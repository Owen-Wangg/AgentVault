"use client";

import { PencilLine, ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DataState } from "@/ui/components/DataState";
import { Badge, Button, Card, PageTitle } from "@/ui/components/primitives";
import type { UiKey } from "@/ui/copy";
import { useCopy } from "@/ui/ThemeProvider";
import type { AuditEventMessage } from "@/ui/events/summarize";
import { agentLabel } from "@/ui/feed/agent-label";
import { describeEvent } from "./describe";
import { MIN_EVENTS_TO_DELETE, type Simulation, type TamperKind, simulateTamper } from "./tamper";

export interface VerifyApi {
  verify: (workspaceId: string) => Promise<{ status: number; body: unknown }>;
}

export const httpVerifyApi: VerifyApi = {
  verify: async (workspaceId) => {
    const response = await fetch("/api/v1/audit/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
};

type Why = "hash" | "link" | "gap" | "head";
type Outcome = { kind: "ok"; count: number; headSeq: number | null } | { kind: "broken"; seq: number; why: Why; headSeq: number | null } | { kind: "error"; message: UiKey };

const WHYS: readonly Why[] = ["hash", "link", "gap", "head"];
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * The verify response, as copy keys the page renders in the visitor's theme (AUD-4, AUD-8).
 * Anything unexpected is an error, never "verified".
 */
export function outcomeOf(status: number, body: unknown): Outcome {
  if (status === 429) return { kind: "error", message: "error.rateLimited" };
  if (status === 401) return { kind: "error", message: "error.unauthorized" };
  const b = (body ?? {}) as Record<string, unknown>;
  const headSeq = isInt(b.head_seq) ? b.head_seq : null;
  if (status === 200 && b.ok === true && isInt(b.count)) return { kind: "ok", count: b.count, headSeq };
  if (status === 200 && b.ok === false && isInt(b.broken_at_seq) && WHYS.includes(b.why as Why)) return { kind: "broken", seq: b.broken_at_seq, why: b.why as Why, headSeq };
  return { kind: "error", message: "error.generic" };
}

const short = (hash: string) => `${hash.slice(0, 12)}…`;
const agentOf = (payload: unknown): string | null => {
  const id = (payload as { agent_id?: unknown } | null)?.agent_id;
  return typeof id === "string" ? id : null;
};

/**
 * The audit page (UI-10, AUD-6): one page of events, newest first, with
 * seq and hash, and a "Verify chain" button that recomputes the whole
 * chain on the server and shows the result.
 */
export function AuditLog({
  workspaceId,
  events,
  older,
  isFirstPage,
  agentNames,
  api = httpVerifyApi,
}: {
  workspaceId: string;
  events: readonly AuditEventMessage[];
  /** The `before` cursor for the next page, or null on the last one. */
  older: number | null;
  isFirstPage: boolean;
  agentNames: Record<string, string>;
  api?: VerifyApi;
}) {
  const copy = useCopy();
  const { t } = copy;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function verify() {
    setBusy(true);
    try {
      const r = await api.verify(workspaceId);
      setOutcome(outcomeOf(r.status, r.body));
    } catch {
      setOutcome({ kind: "error", message: "error.generic" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle
        actions={
          <Button onClick={() => void verify()} disabled={busy}>
            <ShieldCheck aria-hidden="true" className="size-4" />
            {busy ? t("audit.verifying") : t("audit.verify")}
          </Button>
        }
      >
        {t("audit.title")}
      </PageTitle>
      <p className="mb-4 text-sm text-text-muted">{t("audit.intro")}</p>
      <div role="status" aria-live="polite" className="mb-4">
        {outcome?.kind === "ok" ? (
          <Card className="flex items-start gap-2 border-allow text-sm">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-allow" />
            <p>
              <strong>{t("audit.verified")}</strong> {t("audit.eventsChecked")}: <span className="font-mono">{outcome.count}</span>. {t("audit.headSeq")}{" "}
              <span className="font-mono">{outcome.headSeq ?? "–"}</span>.
            </p>
          </Card>
        ) : null}
        {outcome?.kind === "broken" ? (
          <Card className="flex items-start gap-2 border-deny text-sm">
            <ShieldX aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-deny" />
            <p>
              <strong>
                {t("audit.broken")} <span className="font-mono">{outcome.seq}</span>.
              </strong>{" "}
              {t(`audit.why.${outcome.why}` as UiKey)} {t("audit.headSeq")} <span className="font-mono">{outcome.headSeq ?? "–"}</span>.
            </p>
          </Card>
        ) : null}
        {outcome?.kind === "error" ? <Badge tone="deny">{t(outcome.message)}</Badge> : null}
      </div>

      {/* An empty page already says "No events yet." */}
      {events.length > 0 ? <TamperCard workspaceId={workspaceId} events={events} /> : null}

      <DataState status={events.length === 0 ? "empty" : "ready"} empty={t("audit.empty")}>
        {/* `relative` keeps the cells' sr-only text inside the scrolling box (UI-14). */}
        <div className="relative overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("audit.seq")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("audit.time")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("audit.type")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("audit.what")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("audit.agent")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("audit.hash")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {events.map((e) => {
                const agent = agentOf(e.payload);
                return (
                  <tr key={e.seq}>
                    <td className="px-3 py-2 font-mono">{e.seq}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {/* Local time differs between the server render and the browser, so React may not compare it. */}
                      <time dateTime={e.created_at} suppressHydrationWarning>
                        {new Date(e.created_at).toLocaleString()}
                      </time>
                    </td>
                    <td className="px-3 py-2 font-mono">{e.type}</td>
                    {/* UI-30: plain text, never markup or a link, even for the URL a taint names. */}
                    <td className="min-w-[16rem] px-3 py-2 [overflow-wrap:anywhere]">{describeEvent(e, copy)}</td>
                    <td className="px-3 py-2">{agent ? agentLabel(agentNames, agent) : "–"}</td>
                    <td className="px-3 py-2 font-mono" title={e.hash}>
                      <span aria-hidden="true">{short(e.hash)}</span>
                      <span className="sr-only">{e.hash}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DataState>
      <nav aria-label={t("audit.title")} className="mt-4 flex gap-4 text-sm">
        {!isFirstPage ? (
          <Link href="/audit" className="text-accent underline">
            {t("audit.newest")}
          </Link>
        ) : null}
        {older !== null ? (
          <Link href={`/audit?before=${older}`} className="text-accent underline">
            {t("audit.older")}
          </Link>
        ) : null}
      </nav>
    </>
  );
}

/**
 * "Try to tamper with it" (UI-26): changes a copy of this page's events in
 * the browser and rechecks it with the server's chain code. It sends no
 * request and never touches `events` or the stored log.
 */
function TamperCard({ workspaceId, events }: { workspaceId: string; events: readonly AuditEventMessage[] }) {
  const { t } = useCopy();
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const run = (kind: TamperKind) => setSimulation(simulateTamper(workspaceId, events, kind));
  return (
    <Card aria-labelledby="tamper-title" className="mb-4">
      <h2 id="tamper-title" className="text-base font-semibold">
        {t("audit.tamperTitle")}
      </h2>
      <p className="mt-1 text-sm text-text-muted">{t("audit.tamperIntro")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => run("rewrite")}>
          <PencilLine aria-hidden="true" className="size-4" />
          {t("audit.tamperRewrite")}
        </Button>
        <Button variant="secondary" disabled={events.length < MIN_EVENTS_TO_DELETE} onClick={() => run("delete")}>
          <Trash2 aria-hidden="true" className="size-4" />
          {t("audit.tamperDelete")}
        </Button>
      </div>
      {/* Live but not role="status": Verify chain's result is the page's status. */}
      <div aria-live="polite" data-testid="tamper-result" className="mt-3 text-sm">
        {simulation ? <SimulationResult simulation={simulation} /> : null}
      </div>
      <p className="mt-3 text-xs text-text-muted">{t("audit.tamperHeadNote")}</p>
    </Card>
  );
}

function SimulationResult({ simulation }: { simulation: Simulation }) {
  const { t } = useCopy();
  if (simulation.kind === "unchecked") return <p>{t("audit.tamperUnchecked")}</p>;
  const { change, result } = simulation;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-allow" />
        <span>
          {t("audit.tamperUntouched")}: <span className="font-mono">{simulation.untouched}</span>.
        </span>
      </p>
      <p>
        {change.kind === "rewrite" ? t("audit.tamperRewrote") : t("audit.tamperDeleted")} <span className="font-mono">{change.seq}</span> (<span className="font-mono">{change.type}</span>)
        {change.kind === "rewrite" && change.from !== null && change.to !== null ? (
          <>
            : <span className="font-mono">{change.from}</span> {t("audit.tamperTo")} <span className="font-mono">{change.to}</span>
          </>
        ) : null}
        .
      </p>
      {result.ok ? (
        <p>{t("audit.tamperNotCaught")}</p>
      ) : (
        <p className="flex items-start gap-2 text-deny" data-testid="tamper-broken">
          <ShieldX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>
              {t("audit.broken")} <span className="font-mono">{result.brokenAtSeq}</span>.
            </strong>{" "}
            {t(`audit.why.${result.why}` as UiKey)}
          </span>
        </p>
      )}
    </div>
  );
}