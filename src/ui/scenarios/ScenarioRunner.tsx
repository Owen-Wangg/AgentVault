"use client";

import { Bot, Play, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { type LiveScenarioName, isLiveScenario } from "@/agents/gemini/scenarios";
import type { ScenarioName } from "@/agents/scripted/scenarios";
import { Amount } from "@/ui/components/Amount";
import { StreamStatusBadge } from "@/ui/components/StreamStatusBadge";
import { Badge, Button, Card, CardTitle, PageTitle } from "@/ui/components/primitives";
import type { UiKey } from "@/ui/copy";
import { useCopy } from "@/ui/ThemeProvider";
import { type EventStreamOptions, useEventStream } from "@/ui/events/use-event-stream";
import { DecisionPath } from "./DecisionPath";
import { type LiveStop, type RunResult, type RunStep, parseRunResult, runAgentId, runSteps } from "./run-view";

export type RunAgentKind = "scripted" | "gemini";

export interface ScenariosApi {
  run: (name: ScenarioName, runId: string, agent?: RunAgentKind) => Promise<{ status: number; body: unknown }>;
}

export const httpScenariosApi: ScenariosApi = {
  run: async (name, runId, agent = "scripted") => {
    const response = await fetch(`/api/v1/scenarios/${encodeURIComponent(name)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId, ...(agent === "gemini" ? { agent } : {}) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
};

type Run =
  | { name: ScenarioName; runId: string; agent: RunAgentKind; phase: "running" }
  | { name: ScenarioName; runId: string; agent: RunAgentKind; phase: "done"; result: RunResult }
  | { name: ScenarioName; runId: string; agent: RunAgentKind; phase: "failed"; message: UiKey };

const titleKey = (name: ScenarioName) => `scenario.${name}.title` as UiKey;
const descriptionKey = (name: ScenarioName) => `scenario.${name}.description` as UiKey;

const DECISION_TONE = { allow: "allow", hold: "hold", deny: "deny" } as const;

/** What to do next, for scenarios whose outcome depends on how the holds are decided (payout-rails PO-24). */
const SUMMARY_NOTE: Partial<Record<ScenarioName, UiKey>> = { hijack: "scenario.hijack.summaryNote" };

/**
 * Why each scenario without a live version is scripted only (AGT-11).
 * Typed over those scenarios, so a new one can't be added without a reason.
 */
const SCRIPTED_ONLY: Record<Exclude<ScenarioName, LiveScenarioName>, UiKey> = {
  runaway: "scenario.runaway.scriptedOnly",
  hijack: "scenario.hijack.scriptedOnly",
};
const scriptedOnlyKey = (name: ScenarioName): UiKey | undefined => (isLiveScenario(name) ? undefined : SCRIPTED_ONLY[name]);

/** Why a run didn't start or didn't return, as a copy key. */
function failureOf(status: number, body: unknown): UiKey {
  if (status === 409) return "scenarios.busy";
  if (status === 429 && (body as { error?: unknown } | null)?.error === "LIVE_QUOTA_USED") return "scenarios.liveQuotaUsed";
  if (status === 429) return "error.rateLimited";
  return "error.generic";
}

/** What to say about a live run that didn't finish on its own (AGT-14, AGT-15), and whether to offer the scripted run. */
const LIVE_STOP_COPY: Partial<Record<LiveStop, { key: UiKey; offerScripted: boolean }>> = {
  gemini_rate_limited: { key: "scenarios.liveRateLimited", offerScripted: true },
  gemini_failed: { key: "scenarios.liveFailed", offerScripted: true },
  tool_call_cap: { key: "scenarios.liveToolCap", offerScripted: false },
  turn_cap: { key: "scenarios.liveTurnCap", offerScripted: false },
  time_limit: { key: "scenarios.liveTimeLimit", offerScripted: false },
};

/**
 * The scenarios page (demo-agents AGT-1, AGT-3, AGT-10): one card per
 * scenario, the running scenario's steps as they arrive on the event
 * stream, and a summary when it finishes. Runs always use the public
 * sandbox, so `workspaceId` is the current sandbox's.
 *
 * `liveScenarios` lists the scenarios the live Gemini agent can run. It
 * is empty when GEMINI_API_KEY is unset, which hides every live button
 * (AGT-11).
 */
export function ScenarioRunner({
  workspaceId,
  scenarios,
  liveScenarios = [],
  api = httpScenariosApi,
  stream,
  newRunId = () => crypto.randomUUID(),
  featured,
}: {
  workspaceId: string;
  scenarios: readonly ScenarioName[];
  liveScenarios?: readonly ScenarioName[];
  api?: ScenariosApi;
  stream?: EventStreamOptions;
  newRunId?: () => string;
  /** Shown above the scenario cards: the real testnet payment card, when it's available (testnet-demo TN-1). */
  featured?: ReactNode;
}) {
  const { t } = useCopy();
  const title = (name: ScenarioName) => t(titleKey(name));
  const description = (name: ScenarioName) => t(descriptionKey(name));
  const [run, setRun] = useState<Run | null>(null);
  const { events, status, resume } = useEventStream(workspaceId, stream);
  const running = run?.phase === "running";
  const liveOn = liveScenarios.length > 0;

  // The response names the agent too, but the stream's scenario_started arrives first.
  const agentId = run ? (run.phase === "done" ? run.result.agentId : runAgentId(events, run.runId)) : null;
  const steps = agentId ? runSteps(events, agentId) : [];
  // AGT-17: the path shows the run's newest decision.
  const latestDecision = steps.findLast((s): s is Extract<RunStep, { kind: "decision" }> => s.kind === "decision")?.row;

  async function start(name: ScenarioName, agent: RunAgentKind = "scripted") {
    const runId = newRunId();
    setRun({ name, runId, agent, phase: "running" });
    try {
      const r = await api.run(name, runId, agent);
      const result = r.status === 200 ? parseRunResult(r.body) : null;
      setRun(result ? { name, runId, agent, phase: "done", result } : { name, runId, agent, phase: "failed", message: failureOf(r.status, r.body) });
    } catch {
      setRun({ name, runId, agent, phase: "failed", message: "error.generic" });
    }
  }

  const liveStop = run?.phase === "done" && run.result.stop ? LIVE_STOP_COPY[run.result.stop] : undefined;
  const offerScripted = run !== null && run.agent === "gemini" && ((run.phase === "done" && liveStop?.offerScripted) || run.phase === "failed");

  return (
    <>
      <PageTitle actions={<StreamStatusBadge status={status} onResume={resume} />}>{t("scenarios.title")}</PageTitle>
      <p className="mb-2 text-sm">{t("scenarios.intro")}</p>
      <p className={`${liveOn ? "mb-2" : "mb-6"} text-sm text-text-muted`} role="note">
        {t("scenarios.sandboxNote")}
      </p>
      {liveOn ? (
        <p className="mb-6 text-sm text-text-muted" role="note">
          {t("scenarios.liveNote")}
        </p>
      ) : null}

      {featured ? <div className="mb-6">{featured}</div> : null}
      <ul className="grid gap-4 sm:grid-cols-2">
        {scenarios.map((name) => (
          <li key={name}>
            <Card aria-labelledby={`scenario-${name}`} className="flex h-full flex-col gap-3">
              <h2 id={`scenario-${name}`} className="text-base font-semibold">
                {title(name)}
              </h2>
              <p className="flex-1 text-sm text-text-muted">{description(name)}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={running} onClick={() => void start(name)} aria-label={`${t("scenarios.run")}: ${title(name)}`}>
                  <Play aria-hidden="true" className="size-4" />
                  {run?.phase === "running" && run.name === name && run.agent === "scripted" ? t("scenarios.running") : t("scenarios.run")}
                </Button>
                {liveOn && liveScenarios.includes(name) ? (
                  <Button variant="secondary" disabled={running} onClick={() => void start(name, "gemini")} aria-label={`${t("scenarios.runLive")}: ${title(name)}`}>
                    <Bot aria-hidden="true" className="size-4" />
                    {run?.phase === "running" && run.name === name && run.agent === "gemini" ? t("scenarios.running") : t("scenarios.runLive")}
                  </Button>
                ) : null}
              </div>
              {liveOn && !liveScenarios.includes(name) ? <ScriptedOnlyNote name={name} /> : null}
            </Card>
          </li>
        ))}
      </ul>

      {run ? (
        <section aria-labelledby="run-title" className="mt-8">
          <h2 id="run-title" className="mb-3 flex flex-wrap items-center gap-2 text-lg font-semibold">
            {title(run.name)}
            {run.agent === "gemini" ? <Badge tone="accent">{t("scenarios.liveBadge")}</Badge> : null}
          </h2>
          <div role="status" aria-live="polite" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {run.phase === "running" ? t("scenarios.running") : null}
            {run.phase === "failed" ? <Badge tone="deny">{t(run.message)}</Badge> : null}
            {run.phase === "done" && liveStop ? <Badge tone="hold">{t(liveStop.key)}</Badge> : null}
            {run.phase === "done" && !run.result.completed && !liveStop ? <Badge tone="hold">{t("scenarios.stopped")}</Badge> : null}
            {offerScripted ? (
              <Button variant="secondary" disabled={running} onClick={() => void start(run.name)}>
                <Play aria-hidden="true" className="size-4" />
                {t("scenarios.runScripted")}
              </Button>
            ) : null}
          </div>
          {latestDecision ? (
            <Card className="mb-4">
              <DecisionPath row={latestDecision} />
            </Card>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardTitle>{t("scenarios.steps")}</CardTitle>
              <StepList steps={steps} running={running} />
            </Card>
            {run.phase === "done" ? <SummaryPanel result={run.result} note={SUMMARY_NOTE[run.name]} /> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

function ScriptedOnlyNote({ name }: { name: ScenarioName }) {
  const { t } = useCopy();
  const key = scriptedOnlyKey(name);
  return key ? <p className="text-xs text-text-muted">{t(key)}</p> : null;
}

function StepList({ steps, running }: { steps: RunStep[]; running: boolean }) {
  const { t, reasonText } = useCopy();
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
                {/* AGT-16: the advisory score next to the decision it fed. */}
                {step.row.advisoryDriftScore !== undefined ? (
                  <span className="text-text-muted">
                    {t("scenarios.driftScore")}: <span className="font-mono">{step.row.advisoryDriftScore}/100</span>
                  </span>
                ) : null}
              </span>
              {step.row.requestedPayee ? (
                // UI-25: where the agent tried to send the money. Text, never a link.
                <span data-testid="requested-payee">
                  <span className="font-medium">{t("feed.requestedPayee")}</span> <span className="break-all font-mono">{step.row.requestedPayee}</span>
                </span>
              ) : null}
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

function SummaryPanel({ result, note }: { result: RunResult; note?: UiKey | undefined }) {
  const { t, reasonText } = useCopy();
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
      {note ? <p className="mt-4 text-sm">{t(note)}</p> : null}
      {s.decisions.hold > 0 ? (
        <Link href="/approvals" className="mt-4 inline-block text-sm font-medium text-accent underline">
          {t("scenarios.openApprovals")}
        </Link>
      ) : null}
    </Card>
  );
}
