"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { UiKey } from "@/ui/copy";
import { Card } from "@/ui/components/primitives";
import { useCopy } from "@/ui/ThemeProvider";

export interface Tour {
  /** Whether the real testnet payment card is shown on /scenarios (testnet-demo TN-1). */
  testnet: boolean;
}

interface TourStep {
  text: UiKey;
  href: string;
  link: UiKey;
}

const STEPS: readonly TourStep[] = [
  { text: "overview.tourStep.hijack", href: "/scenarios", link: "overview.tourLink.scenarios" },
  { text: "overview.tourStep.decide", href: "/approvals", link: "overview.tourLink.approvals" },
  { text: "overview.tourStep.verify", href: "/audit", link: "overview.tourLink.audit" },
];

const TESTNET_STEP: TourStep = { text: "overview.tourStep.testnet", href: "/scenarios", link: "overview.tourLink.scenarios" };

/** The tour steps in order, with the testnet step only where its card is shown (UI-23). */
export const tourSteps = (tour: Tour): readonly TourStep[] => (tour.testnet ? [...STEPS, TESTNET_STEP] : STEPS);

/**
 * The sandbox overview's "Start here" card (UI-23): the guided tour, in
 * order, each step linking to the page where it happens. Plain links, so
 * the keyboard order is the reading order (UI-13).
 */
export function TourCard({ tour }: { tour: Tour }) {
  const { t } = useCopy();
  return (
    <Card aria-labelledby="tour-title" className="mb-4 border-accent">
      <h2 id="tour-title" className="text-base font-semibold">
        {t("overview.tourTitle")}
      </h2>
      <p className="mt-1 text-sm text-text-muted">{t("overview.tourIntro")}</p>
      <ol className="mt-3 flex flex-col gap-3 text-sm">
        {tourSteps(tour).map((step, i) => (
          <li key={step.text} className="flex gap-3">
            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-xs text-accent-text">
              {i + 1}
            </span>
            <span className="min-w-0">
              {t(step.text)}{" "}
              <Link href={step.href} className="inline-flex items-center gap-1 font-medium text-accent underline">
                {t(step.link)}
                <ArrowRight aria-hidden="true" className="size-3" />
              </Link>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
