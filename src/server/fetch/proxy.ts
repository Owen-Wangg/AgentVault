import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Label, afterFetch, labelOrigin } from "@/core/taint";
import { appendEvent } from "@/server/audit/append";
import type { AuthenticatedAgent } from "@/server/auth/agent-keys";
import type { Db } from "@/server/db/client";
import { sessions, vendors } from "@/server/db/schema";
import { type FetchErrorCode, FetchError, type FetchedPage } from "./fetcher";
import { recordUrl } from "./redact-url";

/**
 * The proxied fetch (TAINT-1 to TAINT-4). The page is fetched outside any
 * transaction. If it is untrusted, the session's taint and the `taint`
 * audit event are committed before the body is returned, so the agent
 * never holds untrusted content that the policy doesn't know about. If
 * that commit fails, the caller gets a 503 and no body.
 */

export interface ProxyDeps {
  db: Db;
  key: Uint8Array;
  now: () => Date;
  fetchPage: (url: string) => Promise<FetchedPage>;
}

export interface ProxyRequest {
  agent: AuthenticatedAgent;
  url: string;
  sessionId: string;
}

export interface ProxyResponse {
  status: number;
  body: {
    label?: Label;
    url?: string;
    status?: number;
    content_type?: string | null;
    body?: string;
    /** The taint or fetch_failed event's seq, when one was written. */
    event_seq?: number;
    error?: string;
    issues?: readonly { path: string; message: string }[];
  };
}

const HTTP_STATUS: Record<FetchErrorCode, number> = {
  FETCH_BLOCKED: 400,
  FETCH_TOO_LARGE: 400,
  FETCH_TIMEOUT: 504,
  FETCH_FAILED: 502,
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Trusted only if every URL in the redirect chain is on the trusted list. */
export function labelChain(hops: readonly string[], trustedOrigins: readonly string[]): Label {
  if (hops.length === 0) return "untrusted";
  return hops.every((hop) => labelOrigin(new URL(hop), trustedOrigins) === "trusted") ? "trusted" : "untrusted";
}

export async function proxyFetch(req: ProxyRequest, deps: ProxyDeps): Promise<ProxyResponse> {
  const { agent } = req;
  const [session] = await deps.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, req.sessionId), eq(sessions.agentId, agent.id)));
  if (!session) {
    return { status: 400, body: { error: "INVALID_REQUEST", issues: [{ path: "session_id", message: "No such session for this agent" }] } };
  }

  const trusted = await deps.db
    .select({ origin: vendors.origin })
    .from(vendors)
    .where(and(eq(vendors.workspaceId, agent.workspaceId), eq(vendors.trusted, true)));

  let page: FetchedPage;
  try {
    page = await deps.fetchPage(req.url);
  } catch (error) {
    if (!(error instanceof FetchError)) throw error;
    // No content reached the agent, so the session is not tainted.
    const requested = recordUrl(req.url);
    const event = await deps.db.transaction((tx) =>
      appendEvent(
        tx,
        {
          workspaceId: agent.workspaceId,
          type: "fetch_failed",
          payload: { agent_id: agent.id, session_id: session.id, url: requested.url, url_sha256: requested.sha256, code: error.code, reason: error.reason },
        },
        { key: deps.key, now: deps.now() },
      ),
    );
    return { status: HTTP_STATUS[error.code], body: { error: error.code, event_seq: event.seq } };
  }

  const label = labelChain(page.hops, trusted.map((t) => t.origin));
  const ok: ProxyResponse["body"] = { label, url: page.url, status: page.status, content_type: page.contentType, body: page.body };
  if (label === "trusted") return { status: 200, body: ok };

  const contentSha256 = sha256(page.body);
  const source = recordUrl(page.url);
  const seq = await deps.db.transaction(async (tx) => {
    const now = deps.now();
    const [row] = await tx
      .select({ taintedAt: sessions.taintedAt, taintSourceUrl: sessions.taintSourceUrl, taintContentSha256: sessions.taintContentSha256 })
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .for("update");
    if (!row) throw new Error("Session vanished during fetch");
    const before = { taintedAt: row.taintedAt?.toISOString() ?? null, taintSourceUrl: row.taintSourceUrl, taintContentSha256: row.taintContentSha256 };
    const after = afterFetch(before, { ok: true, label, url: source.url, contentSha256, at: now.toISOString() });
    const first = after !== before;
    if (first) {
      await tx
        .update(sessions)
        .set({ taintedAt: now, taintSourceUrl: after.taintSourceUrl, taintContentSha256: after.taintContentSha256 })
        .where(eq(sessions.id, session.id));
    }
    // TAINT-4: the URL and a hash of the content, never the content itself (AUD-5).
    const event = await appendEvent(
      tx,
      {
        workspaceId: agent.workspaceId,
        type: "taint",
        payload: {
          agent_id: agent.id,
          session_id: session.id,
          url: source.url,
          url_sha256: source.sha256,
          ...(page.hops.length > 1 ? { redirected_from: page.hops.slice(0, -1).map((hop) => recordUrl(hop).url) } : {}),
          content_sha256: contentSha256,
          first_taint: first,
        },
      },
      { key: deps.key, now },
    );
    return event.seq;
  });
  return { status: 200, body: { ...ok, event_seq: seq } };
}
