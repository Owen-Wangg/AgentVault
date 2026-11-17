"use client";
import { Pause, Radio, WifiOff } from "lucide-react";
import { useCopy } from "@/ui/ThemeProvider";
import type { StreamStatus } from "@/ui/events/use-event-stream";
import { Badge, Button } from "./primitives";
/**
 * "Live" while the event stream is connected, "Reconnecting…" while it's
 * down (design, "Error handling"), and "Live updates paused" with a Resume
 * button while nobody is watching (TEL-7).
 */
export function StreamStatusBadge({ status, onResume }: { status: StreamStatus; onResume?: () => void }) {
  const { t } = useCopy();
  const live = status === "live";
  const paused = status === "paused";
  const label = live ? t("state.live") : paused ? t("state.paused") : status === "closed" ? t("state.error") : t("state.reconnecting");
  const icon = live ? <Radio aria-hidden="true" className="size-3" /> : paused ? <Pause aria-hidden="true" className="size-3" /> : <WifiOff aria-hidden="true" className="size-3" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span role="status" aria-live="polite">
        <Badge tone={live ? "allow" : paused ? "neutral" : "hold"}>
          {icon}
          {label}
        </Badge>
      </span>
      {paused && onResume ? (
        <Button variant="secondary" className="min-h-8 px-3 text-xs" onClick={onResume}>
          {t("state.resume")}
        </Button>
      ) : null}
    </span>
  );
}
