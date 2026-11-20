"use client";
import { useSyncExternalStore } from "react";

/**
 * A time in the visitor's own zone and locale (telemetry-dashboard UI-32).
 * Pages render on the server, in UTC, and hydration keeps the server's
 * text, so formatting during render showed UTC on some pages. Here the
 * server snapshot is null: the server HTML and the hydration render carry
 * only `dateTime`, and React then fills in the browser's format. A plain
 * client render, such as a row the stream adds, has the text at once.
 * https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering
 */
const subscribe = () => () => {};

export function LocalTime({ iso, format = "datetime", className }: { iso: string; format?: "datetime" | "time"; className?: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => (format === "time" ? new Date(iso).toLocaleTimeString() : new Date(iso).toLocaleString()),
    () => null,
  );
  return (
    <time dateTime={iso} {...(className === undefined ? {} : { className })}>
      {text}
    </time>
  );
}
