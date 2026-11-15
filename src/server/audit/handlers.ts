import { z } from "zod";
import { withHuman } from "@/server/approvals/handlers";
import { type GetSessionUser, getSessionUser } from "@/server/auth/session";
import { type ReadableWorkspace, defaultWorkspace, readAccess } from "@/server/auth/workspace-access";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { json, parseBody } from "@/server/http/agent-route";
import { type RateLimit, SANDBOX_ACTION_LIMIT, clientIp, hitRateLimit } from "@/server/http/rate-limit";
import { verifyChain } from "./append";

/**
 * POST /api/v1/audit/verify (audit-and-approvals AUD-4, AUD-6, AUD-8).
 * Body `{ workspace_id? }`. Recomputes the workspace's whole hash chain
 * and checks it against the signed head.
 *
 * Access is the event stream's (TEL-5): any sandbox, current or retired,
 * is public; other workspaces need their owner signed in. Without
 * `workspace_id`, the caller's default workspace. Human-only like the
 * other dashboard routes: any Authorization header and any cross-site
 * POST are 403 before the database opens. It reads the whole chain, so
 * sandbox calls are rate-limited per IP.
 *
 * 200 `{ workspace_id, ok: true, count, head_seq }` or
 * `{ workspace_id, ok: false, broken_at_seq, why, head_seq }`.
 */

export interface VerifyDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  getUser: GetSessionUser;
  rateLimit?: RateLimit;
}

export function defaultVerifyDeps(): VerifyDeps {
  return { openDb: () => createDb(env.databaseUrl()), key: env.auditHeadKey, now: () => new Date(), getUser: getSessionUser };
}

const BodySchema = z.strictObject({ workspace_id: z.uuid().optional() });

export function handleVerifyChain(request: Request, deps: VerifyDeps = defaultVerifyDeps()): Promise<Response> {
  return withHuman(request, deps, "chain verify", async (db) => {
    const body = await parseBody(request, BodySchema);
    if (!body.ok) return body.response;
    const user = await deps.getUser(request);
    let workspace: ReadableWorkspace | undefined;
    if (body.value.workspace_id) {
      const access = await readAccess(db, body.value.workspace_id, user);
      if (!access.ok) return json(access.status, { error: access.error });
      workspace = access.workspace;
    } else {
      workspace = await defaultWorkspace(db, user);
      if (!workspace) return json(404, { error: "NO_WORKSPACE" });
    }
    if (workspace.isSandbox) {
      const allowed = await hitRateLimit(db, { action: "chain verify", ip: clientIp(request), now: deps.now(), ...(deps.rateLimit ?? SANDBOX_ACTION_LIMIT) });
      if (!allowed) return json(429, { error: "RATE_LIMITED" });
    }
    const result = await verifyChain(db, workspace.id, { key: deps.key() });
    return json(
      200,
      result.ok
        ? { workspace_id: workspace.id, ok: true, count: result.count, head_seq: result.headSeq }
        : { workspace_id: workspace.id, ok: false, broken_at_seq: result.brokenAtSeq, why: result.why, head_seq: result.headSeq },
    );
  });
}
