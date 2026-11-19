"use client";

import { ArrowDown, ArrowRight, Ban, CheckCircle2, CircleSlash, MinusCircle, PauseCircle, Send } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Amount } from "@/ui/components/Amount";
import { cn } from "@/ui/components/primitives";
import type { UiKey } from "@/ui/copy";
import { useCopy } from "@/ui/ThemeProvider";
import type { FeedRow } from "@/ui/events/summarize";
import { type CheckState, decisionPath } from "./decision-path";

const STATE: Record<CheckState, { icon: LucideIcon; tone: string }> = {
  passed: { icon: CheckCircle2, tone: "border-allow text-allow" },
  held: { icon: PauseCircle, tone: "border-hold text-hold" },
  denied: { icon: Ban, tone: "border-deny text-deny" },
  not_checked: { icon: MinusCircle, tone: "border-border text-text-muted" },
};

/**
 * The run's latest decision as a path through the checks to the payment
 * rail (demo-agents AGT-17). A column at 375 px and a row from `sm` up;
 * each stage names its state in words, so color is never the only cue.
 */
export function DecisionPath({ row }: { row: FeedRow }) {
  const { t } = useCopy();
  const path = decisionPath(row);
  const stages: { name: UiKey; state: UiKey; icon: LucideIcon; tone: string }[] = [
    ...path.checks.map(({ check, state }) => ({ name: `path.check.${check}` as UiKey, state: `path.state.${state}` as UiKey, ...STATE[state] })),
    path.railReached
      ? { name: "path.rail" as UiKey, state: "path.railReached" as UiKey, icon: Send, tone: "border-allow text-allow" }
      : { name: "path.rail" as UiKey, state: "path.railNotReached" as UiKey, icon: CircleSlash, tone: "border-border text-text-muted" },
  ];
  return (
    <section aria-labelledby="path-title" data-testid="decision-path">
      <h3 id="path-title" className="text-sm font-medium text-text-muted">
        {t("path.title")}
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
        <span className="text-text-muted">{t("path.latest")}:</span>
        <span className="font-mono">{row.tool}</span>
        <span>{row.vendor}</span>
        <Amount value={row.amountMicros} />
      </p>
      <ol className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {stages.map((stage, i) => {
          const Icon = stage.icon;
          return (
            <li key={stage.name} className="flex flex-col items-center gap-2 sm:min-w-0 sm:flex-1 sm:flex-row">
              {i > 0 ? (
                <>
                  <ArrowDown aria-hidden="true" className="size-4 shrink-0 text-text-muted sm:hidden" />
                  <ArrowRight aria-hidden="true" className="hidden size-4 shrink-0 text-text-muted sm:block" />
                </>
              ) : null}
              <div className={cn("flex w-full min-w-0 flex-1 items-center gap-2 self-stretch rounded-card border bg-surface px-3 py-2", stage.tone)}>
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-col text-sm">
                  <span className="font-medium text-text">{t(stage.name)}</span>
                  <span data-testid="path-state">{t(stage.state)}</span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-text-muted">{t("path.note")}</p>
    </section>
  );
}
