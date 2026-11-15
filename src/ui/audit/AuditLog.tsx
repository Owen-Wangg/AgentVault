"use client";

import { ShieldCheck, ShieldX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DataState } from "@/ui/components/DataState";
import { Badge, Button, Card, PageTitle } from "@/ui/components/primitives";
import { type UiKey, t } from "@/ui/copy";
import type { AuditEventMessage } from "@/ui/events/summarize";
import { agentLabel } from "@/ui/feed/agent-label";

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
type Outcome = { kind: "ok"; count: number; headSeq: number | null } | { kind: "broken"; seq: number; why: Why; headSeq: number | null } | { kind: "error"; text: string };

const WHYS: readonly Why[] = ["hash", "link", "gap", "head"];
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The verify response in plain language (AUD-4, AUD-8). Anything unexpected is an error, never "verified". */
export function outcomeOf(status: number, body: unknown): Outcome {
  if (status === 429) return { kind: "error", text: t("error.rateLimited") };
  if (status === 401) return { kind: "error", text: t("error.unauthorized") };
  const b = (body ?? {}) as Record<string, unknown>;
  const headSeq = isInt(b.head_seq) ? b.head_seq : null;
  if (status === 200 && b.ok === true && isInt(b.count)) return { kind: "ok", count: b.count, headSeq };
  if (status === 200 && b.ok === false && isInt(b.broken_at_seq) && WHYS.includes(b.why as Why)) return { kind: "broken", seq: b.broken_at_seq, why: b.why as Why, headSeq };
  return { kind: "error", text: t("error.generic") };
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
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function verify() {
    setBusy(true);
    try {
      const r = await api.verify(workspaceId);
      setOutcome(outcomeOf(r.status, r.body));
    } catch {
      setOutcome({ kind: "error", text: t("error.generic") });
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
        {outcome?.kind === "error" ? <Badge tone="deny">{outcome.text}</Badge> : null}
      </div>

      <DataState status={events.length === 0 ? "empty" : "ready"} empty={t("audit.empty")}>
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
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
