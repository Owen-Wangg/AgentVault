"use client";

import { Ghost, Skull } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DataState } from "@/ui/components/DataState";
import { Badge, Button } from "@/ui/components/primitives";
import type { UiKey } from "@/ui/copy";
import { useCopy } from "@/ui/ThemeProvider";

/** What the agents page shows per agent. Matches the server's AgentSummary. */
export interface AgentRow {
  id: string;
  name: string;
  frozenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  tainted: boolean;
  taintSourceUrl: string | null;
}

export type Unfreeze = (agentId: string) => Promise<number>;

export const postUnfreeze: Unfreeze = async (agentId) =>
  (await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/unfreeze`, { method: "POST" })).status;

const ERRORS: Record<number, UiKey> = { 401: "error.unauthorized", 429: "error.rateLimited" };

/** The agents list (UI-7): frozen and tainted status, a link to each envelope, and unfreeze. */
export function AgentsTable({ agents, canUnfreeze, unfreeze = postUnfreeze, onChanged }: { agents: AgentRow[]; canUnfreeze: boolean; unfreeze?: Unfreeze; onChanged?: () => void }) {
  const router = useRouter();
  const { t, theme } = useCopy();
  // Decoration only: the badges' text and tones are the same in both themes.
  const spooky = theme === "kiroween";
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function onUnfreeze(agent: AgentRow) {
    setBusy(agent.id);
    setMessage("");
    try {
      const status = await unfreeze(agent.id);
      // 409 means it was already unfrozen, which is the state the user wanted.
      if (status === 200 || status === 409) (onChanged ?? router.refresh)();
      else setMessage(t(ERRORS[status] ?? "error.generic"));
    } catch {
      setMessage(t("error.generic"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <DataState status={agents.length === 0 ? "empty" : "ready"} empty={t("agents.empty")}>
      <p role="status" aria-live="polite" className="mb-2 text-sm text-deny">
        {message}
      </p>
      {/* `relative` makes this the containing block of the cells' sr-only text, so it scrolls with the table instead of widening the page (UI-14). */}
      <div className="relative overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <caption className="sr-only">{t("agents.title")}</caption>
          <thead className="border-b border-border bg-surface-muted text-text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("agents.name")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("agents.status")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("agents.created")}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t("agents.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {agents.map((agent) => (
              <tr key={agent.id} className="align-top">
                <td className="px-3 py-2 font-medium">{agent.name}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {agent.frozenAt ? (
                      <Badge tone="deny">
                        {spooky ? <Skull aria-hidden="true" className="av-float size-3" /> : null}
                        {t("agents.frozen")}
                      </Badge>
                    ) : null}
                    {agent.tainted ? (
                      <Badge tone="hold">
                        {spooky ? <Ghost aria-hidden="true" className="av-float size-3" /> : null}
                        <span title={agent.taintSourceUrl ?? undefined}>{t("agents.tainted")}</span>
                      </Badge>
                    ) : null}
                    {agent.revokedAt ? <Badge>{t("agents.revoked")}</Badge> : null}
                    {!agent.frozenAt && !agent.tainted && !agent.revokedAt ? <Badge tone="allow">{t("agents.active")}</Badge> : null}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <time dateTime={agent.createdAt}>{agent.createdAt.slice(0, 10)}</time>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-2">
                    {agent.frozenAt && canUnfreeze ? (
                      <Button
                        variant="secondary"
                        disabled={busy === agent.id}
                        onClick={() => void onUnfreeze(agent)}
                        aria-label={`${t("agents.unfreeze")} ${agent.name}`}
                      >
                        {t("agents.unfreeze")}
                      </Button>
                    ) : null}
                    <Link
                      href={`/agents/${agent.id}`}
                      className="inline-flex min-h-10 items-center rounded-card px-3 text-accent underline-offset-2 hover:underline"
                      aria-label={`${t("agents.editEnvelope")} ${agent.name}`}
                    >
                      {t("agents.editEnvelope")}
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataState>
  );
}
