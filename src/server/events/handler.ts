import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { type GetSessionUser, getSessionUser } from "@/server/auth/session";
import { type ReadableWorkspace, defaultWorkspace, readAccess } from "@/server/auth/workspace-access";
import { type Database, type Db, createDb } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { env } from "@/server/env";
import { json } from "@/server/http/agent-route";
import { type RateLimit, SANDBOX_ACTION_LIMIT, clientIp, hitRateLimit } from "@/server/http/rate-limit";
import { RETRY_MS, type ReadBatch, type StreamClock, type StreamTiming, formatInfo, parseLastEventId, pumpEvents } from "./stream";

/**
 * GET /api/v1/events: a workspace's audit events as server-sent events
 * (telemetry-dashboard TEL-1 to TEL-5).
 *
 * - Bearer headers are 403 AGENT_KEY_FORBIDDEN before the database is
 *   opened, as on the other dashboard routes. Browsers' EventSource
 *   can't send one, so only scripts would.
 * - `?workspace_id=` names the workspace. Any sandbox, current or retired,
 *   is public to read; other workspaces need their owner signed in.
 *   Without it, the reader gets the same workspace as the approvals list:
 *   their own, or the current sandbox.
 * - Each connection starts with `retry` and an id-less `workspace` message
 *   (`workspace_id`, `sandbox`, `retired`). Clients should reconnect with
 *   that `workspace_id`, so a `Last-Event-ID` is never applied to a
 *   different workspace's chain, and reload when `retired` is true.
 * - Opening a sandbox stream counts toward a per-IP rate limit and an
 *   all-visitor one, since the sandbox is public and each stream holds a
 *   function for up to 55 s.
 */

export interface EventsDeps {
  openDb: () => Database;
  now: () => Date;
  sleep: StreamClock["sleep"];
  getUser: GetSessionUser;
  rateLimit?: RateLimit;
  /** Sandbox streams opened by everyone together. */
  totalRateLimit?: RateLimit;
  timing?: StreamTiming;
}

/** Sandbox streams opened per minute by all visitors together. */
export const SANDBOX_STREAM_TOTAL_LIMIT: RateLimit = { limit: 120, windowMs: 60_000 };

/** The rate-limit bucket every sandbox stream counts against. Not an IP, so no visitor can land in it. */
const ALL_VISITORS = "all-visitors";

/** setTimeout that resolves early on abort. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function defaultEventsDeps(): EventsDeps {
  return { openDb: () => createDb(env.databaseUrl()), now: () => new Date(), sleep, getUser: getSessionUser };
}

const QuerySchema = z.strictObject({ workspace_id: z.uuid().optional() });

/** Events after a cursor in one workspace, oldest first (TEL-1, TEL-5). */
export function readWorkspaceEvents(db: Db, workspaceId: string): ReadBatch {
  return async (afterSeq, limit) => {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), gt(auditEvents.seq, afterSeq)))
      .orderBy(asc(auditEvents.seq))
      .limit(limit);
    return rows.map((r) => ({
      workspace_id: r.workspaceId,
      seq: r.seq,
      type: r.type,
      created_at: r.createdAt.toISOString(),
      payload: r.payload,
      prev_hash: r.prevHash,
      hash: r.hash,
    }));
  };
}

const logFailure = (stage: string, error: unknown): string => {
  const correlationId = randomUUID();
  console.error(`event stream ${stage} failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
  return correlationId;
};

export async function handleEvents(request: Request, deps: EventsDeps = defaultEventsDeps()): Promise<Response> {
  if (request.headers.has("authorization")) return json(403, { error: "AGENT_KEY_FORBIDDEN" });
  const query = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return json(400, { error: "INVALID_REQUEST", issues: query.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const after = parseLastEventId(request.headers.get("last-event-id"));
  if (after === null) return json(400, { error: "INVALID_LAST_EVENT_ID" });

  let database: Database | undefined;
  let handedOff = false;
  try {
    database = deps.openDb();
    const { db } = database;
    const user = await deps.getUser(request);
    let workspace: ReadableWorkspace | undefined;
    if (query.data.workspace_id) {
      const access = await readAccess(db, query.data.workspace_id, user);
      if (!access.ok) return json(access.status, { error: access.error });
      workspace = access.workspace;
    } else {
      workspace = await defaultWorkspace(db, user);
      if (!workspace) return json(404, { error: "NO_WORKSPACE" });
    }
    if (workspace.isSandbox) {
      const allowed = await hitRateLimit(db, { action: "events", ip: clientIp(request), now: deps.now(), ...(deps.rateLimit ?? SANDBOX_ACTION_LIMIT) });
      if (!allowed) return json(429, { error: "RATE_LIMITED" });
      // All visitors together: each open stream holds a database connection for up to 55 s.
      const totalAllowed = await hitRateLimit(db, { action: "events total", ip: ALL_VISITORS, now: deps.now(), ...(deps.totalRateLimit ?? SANDBOX_STREAM_TOTAL_LIMIT) });
      if (!totalAllowed) return json(429, { error: "RATE_LIMITED" });
    }
    const response = streamResponse(request, database, workspace, after, deps);
    handedOff = true;
    return response;
  } catch (error) {
    return json(503, { error: "SERVICE_UNAVAILABLE", correlation_id: logFailure("setup", error) });
  } finally {
    if (!handedOff) await database?.close();
  }
}

/** The SSE response. The stream owns `database` and closes it when it ends. */
function streamResponse(
  request: Request,
  database: Database,
  workspace: ReadableWorkspace,
  after: number,
  deps: EventsDeps,
): Response {
  const encoder = new TextEncoder();
  const stop = new AbortController();
  const onClientGone = () => stop.abort();
  request.signal.addEventListener("abort", onClientGone, { once: true });

  async function run(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const write = (chunk: string) => {
      if (stop.signal.aborted) return;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        stop.abort(); // the client has gone
      }
    };
    try {
      write(`retry: ${RETRY_MS}\n\n`);
      write(formatInfo("workspace", { workspace_id: workspace.id, sandbox: workspace.isSandbox, retired: workspace.retired }));
      await pumpEvents({
        read: readWorkspaceEvents(database.db, workspace.id),
        after,
        write,
        clock: { now: () => deps.now().getTime(), sleep: deps.sleep },
        signal: stop.signal,
        ...(deps.timing ? { timing: deps.timing } : {}),
      });
    } catch (error) {
      // Ending the stream makes the browser reconnect from its last event ID.
      logFailure("poll", error);
    } finally {
      request.signal.removeEventListener("abort", onClientGone);
      await database.close().catch((error: unknown) => logFailure("close", error));
      try {
        controller.close();
      } catch {
        // already closed or cancelled
      }
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void run(controller);
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
