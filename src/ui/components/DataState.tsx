"use client";

import type { ReactNode } from "react";
import { useCopy } from "@/ui/ThemeProvider";
import { Button, cn } from "./primitives";

export type DataStatus = "loading" | "error" | "empty" | "ready";

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
    return (
      <div className={box} role="status" aria-live="polite" aria-busy="true">
        {t("state.loading")}
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
