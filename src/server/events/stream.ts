/**
 * The audit event stream loop behind GET /api/v1/events (telemetry-dashboard
 * TEL-1 to TEL-4). It polls a cursor over one workspace's audit events and
 * writes server-sent events. The event source, clock, and writer are
 * injected, so property 1 runs against a fake source with fake time.
 *
 * Why a `seq > cursor` poll never skips an event: `appendEvent` locks the
 * workspace's audit head until its transaction commits, so a workspace's
 * events commit in `seq` order, and a rolled-back append frees its `seq`
 * for the next one. A single query that sees `seq = n` therefore also sees
 * every lower `seq`. An event committed while a poll runs has a higher
 * `seq` than anything that poll returned, so the next poll picks it up.
 */

/** One audit event as sent to the client. Amounts in payloads are micros strings (CJ-3). */
export interface StreamEvent {
  workspace_id: string;
  seq: number;
  type: string;
  created_at: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

/** Events with `seq > afterSeq`, in `seq` order, at most `limit`. */
export type ReadBatch = (afterSeq: number, limit: number) => Promise<StreamEvent[]>;

export interface StreamClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or early once `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface StreamTiming {
  /** Wait between polls that found less than a full batch. */
  pollMs: number;
  /** Write `: ping` once nothing has been written for this long. */
  heartbeatMs: number;
  /** Start no poll after this long; then end the stream so the browser reconnects. */
  durationMs: number;
  batchSize: number;
}

/** The route's `maxDuration`, in seconds (app/api/v1/events/route.ts must match). */
export const EVENTS_MAX_DURATION_S = 60;

export const DEFAULT_TIMING: StreamTiming = {
  pollMs: 1_000,
  // TEL-3 asks for a heartbeat at least every 15 s. Pinging after 10 s idle
  // leaves room for one poll interval and a slow query.
  heartbeatMs: 10_000,
  // TEL-4: close 5 s before the function's limit, as in the design.
  durationMs: (EVENTS_MAX_DURATION_S - 5) * 1_000,
  batchSize: 200,
};

/** How long the browser waits before reconnecting after the stream ends. */
export const RETRY_MS = 1_000;

/** The largest `seq` Postgres `integer` holds. */
const MAX_SEQ = 2_147_483_647;

/**
 * Parse a `Last-Event-ID` header into a cursor. Absent means start from
 * the beginning (0). Anything other than a seq this stream could have
 * sent is null, and the caller answers 400.
 */
export function parseLastEventId(header: string | null): number | null {
  if (header === null || header === "") return 0;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(header)) return null;
  const seq = Number(header);
  return seq <= MAX_SEQ ? seq : null;
}

/**
 * One SSE message. The `id` is the event's `seq` (TEL-1), which the
 * browser sends back as `Last-Event-ID` when it reconnects (TEL-2).
 * JSON.stringify escapes CR and LF, so the data is always one line.
 */
export const formatEvent = (event: StreamEvent): string => `id: ${event.seq}\nevent: audit\ndata: ${JSON.stringify(event)}\n\n`;

export const HEARTBEAT = ": ping\n\n";

/**
 * A message without an `id`, so it doesn't move the browser's last event
 * ID. Used for the `workspace` message at the start of each connection.
 */
export const formatInfo = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export type StreamEnd = "deadline" | "aborted";

/**
 * Stream events with `seq > after` until the duration runs out or the
 * client goes away. Writes each event once, in `seq` order, and advances
 * the cursor only past events it has written. A full batch is followed by
 * another poll right away; otherwise the loop sleeps `pollMs`. Errors from
 * `read` propagate, and the caller ends the stream; the browser then
 * reconnects from the last `seq` it received.
 */
export async function pumpEvents(input: {
  read: ReadBatch;
  after: number;
  write: (chunk: string) => void;
  clock: StreamClock;
  signal: AbortSignal;
  timing?: StreamTiming;
}): Promise<StreamEnd> {
  const { read, write, clock, signal } = input;
  const timing = input.timing ?? DEFAULT_TIMING;
  const start = clock.now();
  const deadline = start + timing.durationMs;
  let cursor = input.after;
  let lastWrite = start;
  let caughtUp = false;

  while (!signal.aborted) {
    const batch = await read(cursor, timing.batchSize);
    if (signal.aborted) break;
    for (const event of batch) {
      write(formatEvent(event));
      cursor = event.seq;
    }
    const now = clock.now();
    if (batch.length > 0) lastWrite = now;
    const full = batch.length >= timing.batchSize;
    if (!full && !caughtUp) {
      // The backlog is sent, so the client can tell "nothing yet" from "still loading".
      caughtUp = true;
      write(formatInfo("ready", { seq: cursor }));
      lastWrite = now;
    }
    if (now - lastWrite >= timing.heartbeatMs) {
      write(HEARTBEAT);
      lastWrite = now;
    }
    const nextPollAt = full ? now : now + timing.pollMs;
    if (nextPollAt >= deadline) return "deadline";
    if (!full) await clock.sleep(timing.pollMs, signal);
  }
  return "aborted";
}
