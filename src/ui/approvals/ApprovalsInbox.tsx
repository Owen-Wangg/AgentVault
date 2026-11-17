"use client";

import { Check, Clock, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Amount } from "@/ui/components/Amount";
import { DataState, type DataStatus } from "@/ui/components/DataState";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import { Badge, Button, Card, PageTitle } from "@/ui/components/primitives";
import type { Copy } from "@/ui/copy";
import { useCopy } from "@/ui/ThemeProvider";
import { type EventStreamOptions, useEventStream } from "@/ui/events/use-event-stream";
import { agentLabel } from "@/ui/feed/agent-label";
import { type InboxApproval, parseApprovals, timeLeft } from "./approval-view";

export interface ApprovalsApi {
  list: () => Promise<{ status: number; body: unknown }>;
  act: (id: string, action: "approve" | "deny") => Promise<{ status: number; body: unknown }>;
}

const asJson = async (response: Response) => ({ status: response.status, body: await response.json().catch(() => null) });

export const httpApprovalsApi: ApprovalsApi = {
  list: async () => asJson(await fetch("/api/v1/approvals?status=pending", { cache: "no-store" })),
  act: async (id, action) =>
    asJson(await fetch(`/api/v1/approvals/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })),
};

/** Events that can change the pending list. */
const APPROVAL_EVENTS = new Set(["approval_created", "approval_decided", "approval_expired", "approval_executed"]);

type Outcome = { id: string; tone: "allow" | "hold" | "deny"; text: string };

/** What happened after approve or deny, in plain language (HITL-2 to HITL-6). */
function outcomeOf(id: string, status: number, body: unknown, { t, reasonText }: Copy): Outcome {
  const b = (body ?? {}) as { status?: unknown; error?: unknown; reasons?: unknown };
  if (status === 200 && b.status === "executed") return { id, tone: "allow", text: t("approvals.executed") };
  if (status === 200 && b.status === "denied") return { id, tone: "deny", text: t("approvals.denied") };
  if (status === 200 && b.status === "failed_recheck") {
    const codes = Array.isArray(b.reasons) ? b.reasons.map((r) => String((r as { code?: unknown }).code ?? "")).filter(Boolean) : [];
    return { id, tone: "deny", text: [t("approvals.failedRecheck"), ...codes.map((c) => reasonText(c))].join(" ") };
  }
  if (status === 409 && b.error === "APPROVAL_EXPIRED") return { id, tone: "hold", text: t("approvals.expiredConflict") };
  if (status === 409) return { id, tone: "hold", text: t("approvals.notPending") };
  if (status === 429) return { id, tone: "hold", text: t("error.rateLimited") };
  if (status === 401) return { id, tone: "hold", text: t("error.unauthorized") };
  return { id, tone: "deny", text: t("error.generic") };
}

/** The current time, ticking every second for the countdowns. */
function useNow(now: () => number): number {
  const [value, setValue] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setValue(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);
  return value;
}

/**
 * The approvals inbox (UI-9): each pending approval with its request,
 * reasons, taint source, and time left, and approve and deny buttons.
 * It reloads the list when the event stream reports an approval change,
 * so a hold shows up without a page reload.
 */
export function ApprovalsInbox({
  workspaceId,
  isSandbox,
  canAct,
  agentNames,
  api = httpApprovalsApi,
  now = Date.now,
  stream,
}: {
  workspaceId: string;
  isSandbox: boolean;
  canAct: boolean;
  agentNames: Record<string, string>;
  api?: ApprovalsApi;
  now?: () => number;
  stream?: EventStreamOptions;
}) {
  const copy = useCopy();
  const { t } = copy;
  const [approvals, setApprovals] = useState<InboxApproval[]>([]);
  const [status, setStatus] = useState<DataStatus>("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const clock = useNow(now);
  const { events, status: streamStatus, resume } = useEventStream(workspaceId, stream);

  const load = useCallback(async () => {
    try {
      const r = await api.list();
      if (r.status !== 200) throw new Error(String(r.status));
      const list = parseApprovals(r.body).filter((a) => a.status === "pending");
      setApprovals(list);
      setStatus(list.length === 0 ? "empty" : "ready");
    } catch {
      setStatus("error");
    }
  }, [api]);

  // Reload on the first render and whenever an approval event arrives.
  const lastApprovalSeq = events.reduce((seq, e) => (APPROVAL_EVENTS.has(e.type) ? e.seq : seq), 0);
  const loaded = useRef<number | null>(null);
  useEffect(() => {
    if (loaded.current === lastApprovalSeq) return;
    loaded.current = lastApprovalSeq;
    void load();
  }, [lastApprovalSeq, load]);

  async function act(approval: InboxApproval, action: "approve" | "deny") {
    setBusy(approval.id);
    try {
      const r = await api.act(approval.id, action);
      setOutcome(outcomeOf(approval.id, r.status, r.body, copy));
    } catch {
      setOutcome({ id: approval.id, tone: "deny", text: t("error.generic") });
    } finally {
      setBusy(null);
      await load();
    }
  }

  return (
    <>
      <PageTitle actions={<StreamStatusBadge status={streamStatus} onResume={resume} />}>{t("approvals.title")}</PageTitle>
      {isSandbox ? (
        <p className="mb-4 text-sm text-text-muted" role="note">
          {t("workspace.sandboxNote")}
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="mb-4 text-sm">
        {outcome ? <Badge tone={outcome.tone}>{outcome.text}</Badge> : null}
      </p>
      <DataState status={status} empty={t("approvals.empty")} onRetry={() => void load()}>
        <ul className="flex flex-col gap-4">
          {approvals.map((a) => (
            <li key={a.id}>
              <ApprovalCard approval={a} agentNames={agentNames} now={clock} canAct={canAct} busy={busy === a.id} onAct={(action) => void act(a, action)} />
            </li>
          ))}
        </ul>
      </DataState>
    </>
  );
}

function ApprovalCard({
  approval: a,
  agentNames,
  now,
  canAct,
  busy,
  onAct,
}: {
  approval: InboxApproval;
  agentNames: Record<string, string>;
  now: number;
  canAct: boolean;
  busy: boolean;
  onAct: (action: "approve" | "deny") => void;
}) {
  const { t, reasonText } = useCopy();
  const left = timeLeft(a.expiresAt, now);
  const titleId = `approval-${a.id}`;
  return (
    <Card aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">
          {agentLabel(agentNames, a.agentId)} → <span className="font-mono">{a.tool}</span> · {a.vendor} · <Amount value={a.amountMicros} />
        </h2>
        <Badge tone={left ? "hold" : "deny"}>
          <Clock aria-hidden="true" className="size-3" />
          {left ? (
            <>
              <span className="sr-only">{t("approvals.timeLeft")}: </span>
              <span className="font-mono">{left}</span>
            </>
          ) : (
            t("approvals.expired")
          )}
        </Badge>
      </div>
      {Object.keys(a.args).length > 0 ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          {Object.entries(a.args).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="break-all font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {a.reasons.map((r) => (
          <li key={r.code} className="flex gap-2">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-hold" />
            {reasonText(r.code)}
          </li>
        ))}
      </ul>
      {a.taintSource ? (
        <p className="mt-2 text-sm">
          <span className="text-text-muted">{t("approvals.taintSource")} </span>
          {/* Shown as text, never as a link: it's the untrusted page itself (security-standards §3). */}
          <span className="break-all font-mono">{a.taintSource}</span>
        </p>
      ) : null}
      {canAct ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy || !left} onClick={() => onAct("approve")} aria-label={`${t("approvals.approve")}: ${a.tool} ${a.vendor}`}>
            <Check aria-hidden="true" className="size-4" />
            {t("approvals.approve")}
          </Button>
          <Button variant="danger" disabled={busy || !left} onClick={() => onAct("deny")} aria-label={`${t("approvals.deny")}: ${a.tool} ${a.vendor}`}>
            <X aria-hidden="true" className="size-4" />
            {t("approvals.deny")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
