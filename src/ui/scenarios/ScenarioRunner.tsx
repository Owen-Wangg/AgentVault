"use client";

import { Play, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ScenarioName } from "@/agents/scripted/scenarios";
import { Amount } from "@/ui/components/Amount";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import { Badge, Button, Card, CardTitle, PageTitle } from "@/ui/components/primitives";
import { type UiKey, reasonText, t } from "@/ui/copy";
import { type EventStreamOptions, useEventStream } from "@/ui/events/use-event-stream";
import { type RunResult, type RunStep, parseRunResult, runAgentId, runSteps } from "./run-view";

export interface ScenariosApi {
  run: (name: ScenarioName, runId: string) => Promise<{ status: number; body: unknown }>;
}

export const httpScenariosApi: ScenariosApi = {
  run: async (name, runId) => {
    const response = await fetch(`/api/v1/scenarios/${encodeURIComponent(name)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
};

type Run =
  | { name: ScenarioName; runId: string; phase: "running" }
  | { name: ScenarioName; runId: string; phase: "done"; result: RunResult }
  | { name: ScenarioName; runId: string; phase: "failed"; message: string };

const title = (name: ScenarioName) => t(`scenario.${name}.title` as UiKey);
const description = (name: ScenarioName) => t(`scenario.${name}.description` as UiKey);

const DECISION_TONE = { allow: "allow", hold: "hold", deny: "deny" } as const;

/** Why a run didn't start or didn't return, in plain language. */
function failureOf(status: number): string {
  if (status === 409) return t("scenarios.busy");
  if (status === 429) return t("error.rateLimited");
  return t("error.generic");
}

/**
 * The scenarios page (demo-agents AGT-1, AGT-3, AGT-10): one card per
 * scenario, the running scenario's steps as they arrive on the event
 * stream, and a summary when it finishes. Runs always use the public
 * sandbox, so `workspaceId` is the current sandbox's.
 */
export function ScenarioRunner({
  workspaceId,
  scenarios,
  api = httpScenariosApi,
  stream,
  newRunId = () => crypto.randomUUID(),
}: {
  workspaceId: string;
  scenarios: readonly ScenarioName[];
  api?: ScenariosApi;
  stream?: EventStreamOptions;
  newRunId?: () => string;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const { events, status } = useEventStream(workspaceId, stream);
  const running = run?.phase === "running";

  // The response names the agent too, but the stream's scenario_started arrives first.
  const agentId = run ? (run.phase === "done" ? run.result.agentId : runAgentId(events, run.runId)) : null;
  const steps = agentId ? runSteps(events, agentId) : [];

  async function start(name: ScenarioName) {
    const runId = newRunId();
    setRun({ name, runId, phase: "running" });
    try {
      const r = await api.run(name, runId);
      const result = r.status === 200 ? parseRunResult(r.body) : null;
      setRun(result ? { name, runId, phase: "done", result } : { name, runId, phase: "failed", message: failureOf(r.status) });
    } catch {
      setRun({ name, runId, phase: "failed", message: t("error.generic") });
    }
  }

  return (
    <>
      <PageTitle actions={<StreamStatusBadge status={status} />}>{t("scenarios.title")}</PageTitle>
      <p className="mb-2 text-sm">{t("scenarios.intro")}</p>
      <p className="mb-6 text-sm text-text-muted" role="note">
        {t("scenarios.sandboxNote")}
      </p>

      <ul className="grid gap-4 sm:grid-cols-2">
        {scenarios.map((name) => (
          <li key={name}>
            <Card aria-labelledby={`scenario-${name}`} className="flex h-full flex-col gap-3">
              <h2 id={`scenario-${name}`} className="text-base font-semibold">
                {title(name)}
              </h2>
              <p className="flex-1 text-sm text-text-muted">{description(name)}</p>
              <div>
                <Button disabled={running} onClick={() => void start(name)} aria-label={`${t("scenarios.run")}: ${title(name)}`}>
                  <Play aria-hidden="true" className="size-4" />
                  {run?.phase === "running" && run.name === name ? t("scenarios.running") : t("scenarios.run")}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {run ? (
        <section aria-labelledby="run-title" className="mt-8">
          <h2 id="run-title" className="mb-3 text-lg font-semibold">
            {title(run.name)}
          </h2>
          <p role="status" aria-live="polite" className="mb-3 text-sm">
            {run.phase === "running" ? t("scenarios.running") : null}
            {run.phase === "failed" ? <Badge tone="deny">{run.message}</Badge> : null}
            {run.phase === "done" && !run.result.completed ? <Badge tone="hold">{t("scenarios.stopped")}</Badge> : null}
          </p>
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardTitle>{t("scenarios.steps")}</CardTitle>
              <StepList steps={steps} running={running} />
            </Card>
            {run.phase === "done" ? <SummaryPanel result={run.result} /> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

function StepList({ steps, running }: { steps: RunStep[]; running: boolean }) {
  if (steps.length === 0) return <p className="mt-3 text-sm text-text-muted">{running ? t("scenarios.starting") : t("feed.empty")}</p>;
  return (
    <ol role="log" aria-label={t("scenarios.steps")} className="mt-3 flex flex-col divide-y divide-border text-sm">
      {steps.map((step, i) => (
        <li key={step.seq} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
          <span className="w-8 shrink-0 font-mono text-text-muted">{i + 1}</span>
          {step.kind === "taint" ? (
            <span className="flex min-w-0 flex-1 gap-2">
              <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-hold" />
              <span className="min-w-0">
                {t("scenarios.taintStep")}{" "}
                {/* Shown as text, never as a link: it's the untrusted page itself (security-standards §3). */}
                <span className="break-all font-mono">{step.url}</span>
              </span>
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{step.row.tool}</span>
                <span>{step.row.vendor}</span>
                <Amount value={step.row.amountMicros} />
                <Badge tone={DECISION_TONE[step.row.decision]}>{t(`decision.${step.row.decision}`)}</Badge>
              </span>
              <span className="text-text-muted">
                {step.row.reasons.length === 0 ? t("feed.noReasons") : step.row.reasons.map((r) => reasonText(r.code)).join(" ")}
              </span>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function SummaryPanel({ result }: { result: RunResult }) {
  const s = result.summary;
  return (
    <Card aria-labelledby="run-summary">
      <h3 id="run-summary" className="text-sm font-medium text-text-muted">
        {t("scenarios.summary")}
      </h3>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
        <dt>{t("scenarios.requests")}</dt>
        <dd className="text-right font-mono">{s.requests}</dd>
        <dt>{t("scenarios.allowedSpend")}</dt>
        <dd className="text-right">
          <Amount value={s.allowedMicros} />
        </dd>
        <dt>{t("scenarios.heldSpend")}</dt>
        <dd className="text-right">
          <Amount value={s.heldMicros} />
        </dd>
        <dt>{t("scenarios.blockedSpend")}</dt>
        <dd className="text-right">
          <Amount value={s.blockedMicros} />
        </dd>
        {(["allow", "hold", "deny"] as const).map((d) => (
          <div key={d} className="contents">
            <dt>{t(`decision.${d}`)}</dt>
            <dd className="text-right font-mono">{s.decisions[d]}</dd>
          </div>
        ))}
      </dl>
      <h4 className="mt-4 text-sm font-medium text-text-muted">{t("scenarios.byReason")}</h4>
      {s.reasons.length === 0 ? (
        <p className="mt-2 text-sm">{t("scenarios.noReasons")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {s.reasons.map((r) => (
            <li key={r.code} className="flex justify-between gap-3">
              <span>{reasonText(r.code)}</span>
              <span className="font-mono">×{r.count}</span>
            </li>
          ))}
        </ul>
      )}
      {s.decisions.hold > 0 ? (
        <Link href="/approvals" className="mt-4 inline-block text-sm font-medium text-accent underline">
          {t("scenarios.openApprovals")}
        </Link>
      ) : null}
    </Card>
  );
}
