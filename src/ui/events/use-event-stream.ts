"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * - the connection status for the "Reconnecting…" badge;
 * - no open stream while the page is hidden or idle (TEL-6, TEL-7), so a
 *   forgotten tab doesn't keep a function and the database awake. A
 *   reopened EventSource can't send Last-Event-ID, so it gets the backlog
 *   again, and mergeEvents drops what's already shown.
 */

/** How long backlog events wait for the server's `ready` before they render anyway. */
export const BACKLOG_FLUSH_MS = 100;
/** Pause after this long without input on a visible page (TEL-7). */
export const IDLE_MS = 15 * 60_000;
/** The inputs that count as someone watching. */
export const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
/** Restart the idle timer at most this often, since pointermove fires constantly. */
const ACTIVITY_THROTTLE_MS = 1_000;

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed" | "paused";

export interface EventStreamState {
  events: AuditEventMessage[];
  status: StreamStatus;
  /** The backlog has arrived, so an empty list means there are no events. */
  ready: boolean;
}

export interface EventStreamResult extends EventStreamState {
  /** Reopen a paused stream (the badge's Resume button). */
  resume: () => void;
}

export interface EventStreamOptions {
  /** For tests. */
  createEventSource?: (url: string) => EventSource;
  /** Called when the workspace is a retired sandbox. Defaults to reloading the page. */
  onRetired?: () => void;
  /** For tests. Defaults to BACKLOG_FLUSH_MS. */
  backlogFlushMs?: number;
  /** For tests. Defaults to IDLE_MS. */
  idleMs?: number;
  /** For tests: the document whose visibility counts. Defaults to `document`. */
  doc?: Document;
}

/** Add events in seq order, keeping each seq once. Events arrive in order; this also survives a replay. */
export function mergeEvents(current: readonly AuditEventMessage[], incoming: readonly AuditEventMessage[]): AuditEventMessage[] {
  const last = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
  const out = [...current];
  for (const e of fresh) if (e.seq > (out.at(-1)?.seq ?? 0)) out.push(e);
  return out.length === current.length ? (current as AuditEventMessage[]) : out;
}

export function useEventStream(workspaceId: string | null, options: EventStreamOptions = {}): EventStreamResult {
  const [state, setState] = useState<EventStreamState>({ events: [], status: "connecting", ready: false });
  const { createEventSource, onRetired, backlogFlushMs = BACKLOG_FLUSH_MS, idleMs = IDLE_MS, doc } = options;
  const [visible, setVisible] = useState(() => (doc ?? globalThis.document)?.visibilityState !== "hidden");
  const [idle, setIdle] = useState(false);
  const wake = useRef<() => void>(() => setIdle(false));
  const active = visible && !idle;

  // TEL-6, TEL-7: track whether anyone is watching. Input restarts the idle timer; the page
  // becoming visible counts as input.
  useEffect(() => {
    if (!workspaceId) return;
    const d = doc ?? document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastArmed = Number.NEGATIVE_INFINITY;
    const arm = (force: boolean) => {
      setIdle(false);
      const now = Date.now();
      if (!force && now - lastArmed < ACTIVITY_THROTTLE_MS) return;
      lastArmed = now;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), idleMs);
    };
    const onInput = () => arm(false);
    const onVisibility = () => {
      const shown = d.visibilityState !== "hidden";
      setVisible(shown);
      if (shown) arm(true);
    };
    wake.current = () => arm(true);
    arm(true);
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onInput, { passive: true });
    d.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onInput);
      d.removeEventListener("visibilitychange", onVisibility);
      wake.current = () => setIdle(false);
    };
  }, [workspaceId, doc, idleMs]);

  const resume = useCallback(() => wake.current(), []);

  useEffect(() => {
    if (!workspaceId || !active) return;
    const url = `/api/v1/events?workspace_id=${encodeURIComponent(workspaceId)}`;
    const source = createEventSource ? createEventSource(url) : new EventSource(url);
    // Batch events into as few renders as possible. Each SSE message is its own task, so the
    // backlog (hundreds of events on a busy sandbox) would otherwise render once per event,
    // and the overview recomputes its summary on each render. Until the server sends `ready`,
    // events wait for `ready` (or BACKLOG_FLUSH_MS, if a server never sends it); after that,
    // each live event renders at once.
    let pending: AuditEventMessage[] = [];
    let scheduled = false;
    let backlogDone = false;
    let backlogTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      scheduled = false;
      if (backlogTimer !== undefined) clearTimeout(backlogTimer);
      backlogTimer = undefined;
      if (pending.length === 0) return;
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
      if (!backlogDone) {
        backlogTimer ??= setTimeout(flush, backlogFlushMs);
      } else if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    });
    source.addEventListener("ready", () => {
      // The whole backlog lands in one render, together with `ready`.
      backlogDone = true;
      flush();
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
    return () => {
      if (backlogTimer !== undefined) clearTimeout(backlogTimer);
      source.close();
      // The next stream starts as connecting, not with this one's status.
      setState((s) => ({ ...s, status: "connecting" }));
    };
  }, [workspaceId, active, createEventSource, onRetired, backlogFlushMs]);

  return { ...state, status: active ? state.status : "paused", resume };
}
