"use client";
import { useEffect, useState } from "react";
import { useCopy } from "@/ui/ThemeProvider";

/** The approvals list returns at most this many, so this many or more shows `99+`. */
export const PENDING_LIST_CAP = 100;

export interface PendingCountOptions {
  /** For tests. Defaults to the global fetch. */
  fetcher?: typeof fetch;
  /** For tests: the document whose visibility counts. Defaults to `document`. */
  doc?: Document;
}

/** How many approvals a response body `{ approvals: [...] }` lists, or null for any other body. */
function countOf(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { approvals?: unknown }).approvals)) return null;
  return (body as { approvals: unknown[] }).approvals.length;
}

/**
 * The number of pending approvals (UI-22). It reads the approvals list,
 * which applies expiry first, when `pathname` changes and when the tab
 * becomes visible: no stream and no timer, so an open tab costs nothing
 * (TEL-6, TEL-7). Any failure counts as 0. Call it once per page; both
 * navigation bars share the result.
 */
export function usePendingCount(pathname: string, { fetcher, doc }: PendingCountOptions = {}): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const d = doc ?? document;
    const get = fetcher ?? fetch;
    let controller: AbortController | undefined;
    const read = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      get("/api/v1/approvals?status=pending", { credentials: "same-origin", signal: current.signal })
        .then(async (response) => (response.ok ? countOf(await response.json()) : null))
        .then((n) => {
          if (!current.signal.aborted) setCount(n ?? 0);
        })
        .catch(() => {
          if (!current.signal.aborted) setCount(0);
        });
    };
    const onVisibility = () => {
      if (d.visibilityState !== "hidden") read();
    };
    read();
    d.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller?.abort();
      d.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pathname, fetcher, doc]);
  return count;
}

/** The count on the Approvals link, with screen-reader text after the number. Nothing for 0. */
export function PendingCount({ count, className }: { count: number; className?: string }) {
  const { t } = useCopy();
  if (count <= 0) return null;
  return (
    // The hold badge's colors, a pair the theme contrast test checks (UI-12).
    <span
      className={`inline-flex min-w-5 items-center justify-center rounded-full border border-hold bg-surface px-1.5 text-xs font-semibold leading-5 text-hold ${className ?? ""}`}
    >
      {count >= PENDING_LIST_CAP ? "99+" : String(count)}
      <span className="sr-only"> {t("nav.pendingSuffix")}</span>
    </span>
  );
}
