import { type EventType, type SegmentResult, type StoredEvent, verifySegment } from "@/core/audit";
import type { AuditEventMessage } from "@/ui/events/summarize";

/**
 * The audit page's tamper simulation (telemetry-dashboard UI-26). Pure:
 * it changes a copy of the page's events and rechecks the copy with the
 * chain code the server uses. Nothing here sends a request or touches
 * the stored log.
 */

export type TamperKind = "rewrite" | "delete";

/** What the simulation changed, for the page to describe. */
export type TamperChange =
  | { kind: "rewrite"; seq: number; type: string; from: string | null; to: string | null }
  | { kind: "delete"; seq: number; type: string };

export type Simulation =
  /** The untouched copy didn't verify in the browser, so there is nothing to compare against. */
  | { kind: "unchecked" }
  | { kind: "done"; untouched: number; change: TamperChange; result: SegmentResult };

/** Deleting needs a row strictly inside the run (see the design's "Tamper simulation"). */
export const MIN_EVENTS_TO_DELETE = 3;

/**
 * The page's events as the chain code reads them, oldest first. The type
 * is hashed as the string it is, so the cast changes nothing the check sees.
 */
function storedEvents(events: readonly AuditEventMessage[]): StoredEvent[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ workspace_id: e.workspace_id, seq: e.seq, type: e.type as EventType, created_at: e.created_at, payload: e.payload, prev_hash: e.prev_hash, hash: e.hash }));
}

const decisionOf = (payload: unknown): string | null => {
  const d = (payload as { decision?: unknown } | null)?.decision;
  return typeof d === "string" ? d : null;
};

/** The row to change: the newest held or denied decision, else the newest decision, else the newest event. */
export function tamperTarget(events: readonly StoredEvent[]): StoredEvent | null {
  const newestFirst = [...events].reverse();
  return (
    newestFirst.find((e) => e.type === "decision" && (decisionOf(e.payload) === "hold" || decisionOf(e.payload) === "deny")) ??
    newestFirst.find((e) => e.type === "decision") ??
    newestFirst[0] ??
    null
  );
}

/** A decision rewritten to `allow` with no reasons; any other event gains `tampered: true`. */
function rewritten(event: StoredEvent): { event: StoredEvent; change: TamperChange } {
  const payload = (typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload : {}) as Record<string, unknown>;
  const from = decisionOf(payload);
  const next = event.type === "decision" ? { ...payload, decision: "allow", reasons: [] } : { ...payload, tampered: true };
  return {
    event: { ...event, payload: next },
    change: { kind: "rewrite", seq: event.seq, type: event.type, from: event.type === "decision" ? from : null, to: event.type === "decision" ? "allow" : null },
  };
}

/**
 * Change a copy of `events` and recheck it. `events` is the page as the
 * server sent it, in any order; it isn't modified. Returns null when the
 * page has nothing to change (no events, or too few to delete one).
 */
export function simulateTamper(workspaceId: string, events: readonly AuditEventMessage[], kind: TamperKind): Simulation | null {
  const copy = storedEvents(events);
  const target = tamperTarget(copy);
  if (!target || (kind === "delete" && copy.length < MIN_EVENTS_TO_DELETE)) return null;

  const untouched = verifySegment(workspaceId, copy);
  if (!untouched.ok) return { kind: "unchecked" };

  if (kind === "rewrite") {
    const { event, change } = rewritten(target);
    return { kind: "done", untouched: untouched.count, change, result: verifySegment(workspaceId, copy.map((e) => (e.seq === target.seq ? event : e))) };
  }
  // Removing the first or last row leaves a shorter run that still links, so delete one inside it.
  const inside = target.seq > copy[0]!.seq && target.seq < copy[copy.length - 1]!.seq ? target : copy[Math.floor(copy.length / 2)]!;
  return {
    kind: "done",
    untouched: untouched.count,
    change: { kind: "delete", seq: inside.seq, type: inside.type },
    result: verifySegment(workspaceId, copy.filter((e) => e.seq !== inside.seq)),
  };
}
