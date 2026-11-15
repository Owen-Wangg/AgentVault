"use client";

import { useEffect, useState } from "react";
import type { AuditEventMessage } from "./summarize";

/**
 * Live audit events for one workspace from GET /api/v1/events (TEL-1,
 * UI-6). EventSource reconnects by itself with Last-Event-ID when the
 * server closes the stream (TEL-2, TEL-4); this hook adds:
 * - the workspace ID on the URL, so a reconnect never resumes another
 *   workspace's chain;
 * - a reload when the server says the workspace is a retired sandbox
 *   (UI-3), so the page moves to the new sandbox;
 * - a guard that keeps each seq once and in order;
 * - the connection status for the "Reconnecting…" badge.
 */

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

export interface EventStreamState {
  events: AuditEventMessage[];
  status: StreamStatus;
  /** The backlog has arrived, so an empty list means there are no events. */
  ready: boolean;
}

export interface EventStreamOptions {
  /** For tests. */
  createEventSource?: (url: string) => EventSource;
  /** Called when the workspace is a retired sandbox. Defaults to reloading the page. */
  onRetired?: () => void;
}

/** Add events in seq order, keeping each seq once. Events arrive in order; this also survives a replay. */
export function mergeEvents(current: readonly AuditEventMessage[], incoming: readonly AuditEventMessage[]): AuditEventMessage[] {
  const last = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
  const out = [...current];
  for (const e of fresh) if (e.seq > (out.at(-1)?.seq ?? 0)) out.push(e);
  return out.length === current.length ? (current as AuditEventMessage[]) : out;
}

export function useEventStream(workspaceId: string | null, options: EventStreamOptions = {}): EventStreamState {
  const [state, setState] = useState<EventStreamState>({ events: [], status: "connecting", ready: false });
  const { createEventSource, onRetired } = options;

  useEffect(() => {
    if (!workspaceId) return;
    const url = `/api/v1/events?workspace_id=${encodeURIComponent(workspaceId)}`;
    const source = createEventSource ? createEventSource(url) : new EventSource(url);
    // Batch events that arrive together into one render.
    let pending: AuditEventMessage[] = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const batch = pending;
      pending = [];
      setState((s) => ({ ...s, events: mergeEvents(s.events, batch) }));
    };

    source.addEventListener("open", () => setState((s) => ({ ...s, status: "live" })));
    source.addEventListener("audit", (message) => {
      try {
        pending.push(JSON.parse((message as MessageEvent<string>).data) as AuditEventMessage);
      } catch {
        return;
      }
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    });
    source.addEventListener("ready", () => {
      queueMicrotask(() => setState((s) => ({ ...s, ready: true })));
    });
    source.addEventListener("workspace", (message) => {
      try {
        const info = JSON.parse((message as MessageEvent<string>).data) as { retired?: unknown };
        if (info.retired === true) (onRetired ?? (() => window.location.reload()))();
      } catch {
        // ignore a malformed message
      }
    });
    source.addEventListener("error", () => {
      // CLOSED means the server refused the stream (for example 401 or 429), so EventSource won't retry.
      setState((s) => ({ ...s, status: source.readyState === 2 ? "closed" : "reconnecting" }));
    });
    return () => source.close();
  }, [workspaceId, createEventSource, onRetired]);

  return state;
}
