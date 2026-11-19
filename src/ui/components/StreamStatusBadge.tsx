"use client";
import { type LucideIcon, Pause, Radio, WifiOff } from "lucide-react";
import type { UiKey } from "@/ui/copy";
import { useCopy } from "@/ui/ThemeProvider";
import type { StreamStatus } from "@/ui/events/use-event-stream";
import { Badge, Button } from "./primitives";
/**
 * "Connecting…" before the first connection, "Live" while the event
 * stream is connected, "Reconnecting…" while it's
 * down (design, "Error handling"), and "Live updates paused" with a Resume
 * button while nobody is watching (TEL-7).
 */
const LOOK: Record<StreamStatus, { label: UiKey; tone: "allow" | "neutral" | "hold"; Icon: LucideIcon }> = {
  // Not a problem yet, so neutral, not the warning tone.
  connecting: { label: "state.connecting", tone: "neutral", Icon: Radio },
  live: { label: "state.live", tone: "allow", Icon: Radio },
  reconnecting: { label: "state.reconnecting", tone: "hold", Icon: WifiOff },
  closed: { label: "state.error", tone: "hold", Icon: WifiOff },
  paused: { label: "state.paused", tone: "neutral", Icon: Pause },
};

export function StreamStatusBadge({ status, onResume }: { status: StreamStatus; onResume?: () => void }) {
  const { t } = useCopy();
  const { label, tone, Icon } = LOOK[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span role="status" aria-live="polite">
        <Badge tone={tone}>
          <Icon aria-hidden="true" className="size-3" />
          {t(label)}
        </Badge>
      </span>
      {status === "paused" && onResume ? (
        <Button variant="secondary" className="min-h-8 px-3 text-xs" onClick={onResume}>
          {t("state.resume")}
        </Button>
      ) : null}
    </span>
  );
}
