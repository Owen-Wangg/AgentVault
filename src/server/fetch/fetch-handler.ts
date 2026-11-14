import { z } from "zod";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { json, parseBody, withAgent } from "@/server/http/agent-route";
import { type FetchedPage, safeFetch } from "./fetcher";
import { proxyFetch } from "./proxy";

/**
 * POST /api/v1/fetch (taint-and-intent TAINT-1 to TAINT-4). Body:
 * `{ url, session_id }`. Returns `{ label, url, status, content_type,
 * body, event_seq? }`, or `{ error }` with 400, 502, or 504 for a fetch
 * that was refused or failed.
 */

export interface FetchDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  fetchPage: (url: string) => Promise<FetchedPage>;
}

export function defaultFetchDeps(): FetchDeps {
  return {
    openDb: () => createDb(env.databaseUrl()),
    key: env.auditHeadKey,
    now: () => new Date(),
    // http://localhost is allowed only in development (TAINT-2).
    fetchPage: (url) => safeFetch(url, { allowLocalhost: process.env.NODE_ENV === "development" }),
  };
}

export const FetchBodySchema = z.strictObject({
  url: z.string().min(1).max(2048),
  session_id: z.uuid(),
});

export function handleFetch(request: Request, deps: FetchDeps = defaultFetchDeps()): Promise<Response> {
  return withAgent(request, deps.openDb, "fetch", async (db, agent) => {
    const parsed = await parseBody(request, FetchBodySchema);
    if (!parsed.ok) return parsed.response;
    const result = await proxyFetch(
      { agent, url: parsed.value.url, sessionId: parsed.value.session_id },
      { db, key: deps.key(), now: deps.now, fetchPage: deps.fetchPage },
    );
    return json(result.status, result.body);
  });
}
