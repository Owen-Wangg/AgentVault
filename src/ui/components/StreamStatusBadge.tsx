import { Radio, WifiOff } from "lucide-react";
import { t } from "@/ui/copy";
import type { StreamStatus } from "@/ui/events/use-event-stream";
import { Badge } from "./primitives";

/** "Live" while the event stream is connected, "Reconnecting…" while it's down (design, "Error handling"). */
export function StreamStatusBadge({ status }: { status: StreamStatus }) {
  const live = status === "live";
  return (
    <span role="status" aria-live="polite">
      <Badge tone={live ? "allow" : "hold"}>
        {live ? <Radio aria-hidden="true" className="size-3" /> : <WifiOff aria-hidden="true" className="size-3" />}
        {live ? t("state.live") : status === "closed" ? t("state.error") : t("state.reconnecting")}
      </Badge>
    </span>
  );
}
