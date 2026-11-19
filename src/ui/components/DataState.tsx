"use client";

import type { ReactNode } from "react";
import { useCopy } from "@/ui/ThemeProvider";
import { Button, cn } from "./primitives";

export type DataStatus = "loading" | "error" | "empty" | "ready";

/** The skeleton's rows: a heading-width bar, then table-row bars of varied length. */
const SKELETON_WIDTHS = ["w-1/3", "w-full", "w-11/12", "w-5/6", "w-3/4"] as const;

/**
 * The shared loading, empty, and error states for every data view (UI-15).
 * Loading and error use a live region, so screen readers hear the change.
 */
export function DataState({
  status,
  empty,
  error,
  onRetry,
  children,
  className,
}: {
  status: DataStatus;
  /** Shown when there is nothing to list. */
  empty: string;
  /** Defaults to a generic message. Never put server error details here. */
  error?: string;
  onRetry?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useCopy();
  if (status === "ready") return <>{children}</>;
  const box = cn("rounded-card border border-dashed border-border bg-surface p-6 text-center text-sm text-text-muted", className);
  if (status === "loading") {
    // A skeleton in the card's shape; the words are for screen readers only.
    return (
      <div className={cn("rounded-card border border-border bg-surface p-4", className)} role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">{t("state.loading")}</span>
        <div aria-hidden="true" data-testid="skeleton" className="flex animate-pulse flex-col gap-3">
          {SKELETON_WIDTHS.map((w) => (
            <div key={w} className={cn("h-4 rounded bg-border/60", w)} />
          ))}
        </div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className={box} role="alert">
        <p>{error ?? t("state.error")}</p>
        {onRetry ? (
          <Button variant="secondary" className="mt-3" onClick={onRetry}>
            {t("state.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  return <div className={box}>{empty}</div>;
}
