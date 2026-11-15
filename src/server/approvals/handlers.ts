import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Rail } from "@/core/money";
import { railOptions } from "@/rails/real";
import { railFor } from "@/rails/select";
import type { RailAdapter } from "@/rails/types";
import { type GetSessionUser, getSessionUser } from "@/server/auth/session";
import { defaultWorkspace } from "@/server/auth/workspace-access";
import { type Database, type Db, createDb } from "@/server/db/client";
import { APPROVAL_STATUSES, agents, approvals, workspaces } from "@/server/db/schema";
import { env } from "@/server/env";
import { json, parseBody } from "@/server/http/agent-route";
import { type RateLimit, SANDBOX_ACTION_LIMIT, clientIp, hitRateLimit } from "@/server/http/rate-limit";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { type ApprovalsDeps, actOnApproval, listApprovals, unfreezeAgent } from "./service";

/**
 * Human-only routes: GET /api/v1/approvals, POST /api/v1/approvals/:id,
 * and POST /api/v1/agents/:id/unfreeze. Authorization, in this order
 * (audit-and-approvals design, "Authorization"):
 * 1. Any Authorization header is 403 AGENT_KEY_FORBIDDEN, in every
 *    workspace including the sandbox (HITL-10). It is checked before the
 *    database is opened, so nothing changes.
 * 2. A target in the current public sandbox is allowed, with the actor
 *    `sandbox_visitor`, and actions are rate-limited per IP (HITL-11).
 *    Retired sandboxes are read-only: actions there are 403.
 * 3. Anywhere else, the signed-in user must own the target's workspace:
 *    401 without a session, 403 for another workspace.
 */

export interface HumanRouteDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  railFor: (rail: Rail, workspace: { isSandbox: boolean }) => RailAdapter;
  getUser: GetSessionUser;
  rateLimit?: RateLimit;
}

export function defaultHumanRouteDeps(): HumanRouteDeps {
  return {
    openDb: () => createDb(env.databaseUrl()),
    key: env.auditHeadKey,
    now: () => new Date(),
    railFor: (rail, workspace) => railFor(rail, workspace, railOptions()),
    getUser: getSessionUser,
  };
}

export const SANDBOX_VISITOR = "sandbox_visitor";

const UUID = z.uuid();

interface TargetWorkspace {
  id: string;
  isSandbox: boolean;
  retiredAt: Date | null;
  ownerUserId: string | null;
}

type Access = { ok: true; actor: string; sandbox: boolean } | { ok: false; response: Response };

const deny = (status: number, error: string): Access => ({ ok: false, response: json(status, { error }) });

/** Steps 2 and 3 of the authorization order, for an action on `workspace`. */
async function authorizeAction(db: Db, request: Request, workspace: TargetWorkspace, deps: HumanRouteDeps): Promise<Access> {
  if (workspace.isSandbox) {
    const current = await currentSandbox(db);
    if (workspace.retiredAt !== null || current?.id !== workspace.id) return deny(403, "SANDBOX_RETIRED");
    return { ok: true, actor: SANDBOX_VISITOR, sandbox: true };
  }
  const user = await deps.getUser(request);
  if (!user) return deny(401, "UNAUTHORIZED");
  // A workspace has one member, its owner (design, "Workspace members").
  if (workspace.ownerUserId === null || workspace.ownerUserId !== user.id) return deny(403, "FORBIDDEN");
  return { ok: true, actor: user.id, sandbox: false };
}

/** Sandbox actions are public, so they are rate-limited per IP (security-standards §8). */
async function underRateLimit(db: Db, request: Request, action: string, deps: HumanRouteDeps): Promise<boolean> {
  return hitRateLimit(db, { action, ip: clientIp(request), now: deps.now(), ...(deps.rateLimit ?? SANDBOX_ACTION_LIMIT) });
}

/**
 * A state-changing request sent from another site (CSRF). The session
 * cookie is SameSite=Lax, which already keeps it off most cross-site
 * POSTs; this also refuses them when a browser says so. Browsers send
 * Origin on every cross-origin POST. Requests without it (scripts, curl)
 * carry no victim's cookie, so they are judged by the other checks.
 */
export function isCrossSite(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true; // "null" or garbage
  }
}

/**
 * Reject bearer auth and cross-site requests before touching the database, then run `handle` with
 * a fail-closed 503 for any error. Only the error message is logged.
 */
export async function withHuman(request: Request, deps: Pick<HumanRouteDeps, "openDb">, label: string, handle: (db: Db) => Promise<Response>): Promise<Response> {
  if (request.headers.has("authorization")) return json(403, { error: "AGENT_KEY_FORBIDDEN" });
  if (isCrossSite(request)) return json(403, { error: "CROSS_ORIGIN" });
  let database: Database | undefined;
  try {
    database = deps.openDb();
    return await handle(database.db);
  } catch (error) {
    const correlationId = randomUUID();
    console.error(`${label} failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
    return json(503, { error: "SERVICE_UNAVAILABLE", correlation_id: correlationId });
  } finally {
    await database?.close();
  }
}

const serviceDeps = (db: Db, deps: HumanRouteDeps): ApprovalsDeps => ({ db, key: deps.key(), now: deps.now, railFor: deps.railFor });

const ListQuerySchema = z.strictObject({ status: z.enum(APPROVAL_STATUSES).optional() });

/**
 * GET /api/v1/approvals. A signed-in user sees their workspace; anyone
 * else sees the current sandbox. Expiry runs first (HITL-12).
 */
export function handleListApprovals(request: Request, deps: HumanRouteDeps = defaultHumanRouteDeps()): Promise<Response> {
  return withHuman(request, deps, "approvals list", async (db) => {
    const query = ListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return json(400, { error: "INVALID_REQUEST", issues: query.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

    const workspace = await defaultWorkspace(db, await deps.getUser(request));
    if (!workspace) return json(404, { error: "NO_WORKSPACE" });

    const list = await listApprovals(serviceDeps(db, deps), workspace.id, query.data.status ? { status: query.data.status } : {});
    return json(200, { workspace_id: workspace.id, sandbox: workspace.isSandbox, approvals: list });
  });
}

const ActionBodySchema = z.strictObject({ action: z.enum(["approve", "deny"]) });

/** POST /api/v1/approvals/:id with `{ action: "approve" | "deny" }`. */
export function handleApprovalAction(request: Request, approvalId: string, deps: HumanRouteDeps = defaultHumanRouteDeps()): Promise<Response> {
  return withHuman(request, deps, "approval action", async (db) => {
    if (!UUID.safeParse(approvalId).success) return json(404, { error: "NOT_FOUND" });
    const [target] = await db
      .select({ id: workspaces.id, isSandbox: workspaces.isSandbox, retiredAt: workspaces.retiredAt, ownerUserId: workspaces.ownerUserId })
      .from(approvals)
      .innerJoin(workspaces, eq(workspaces.id, approvals.workspaceId))
      .where(eq(approvals.id, approvalId));
    if (!target) return json(404, { error: "NOT_FOUND" });

    const access = await authorizeAction(db, request, target, deps);
    if (!access.ok) return access.response;
    const body = await parseBody(request, ActionBodySchema);
    if (!body.ok) return body.response;
    if (access.sandbox && !(await underRateLimit(db, request, "approval", deps))) return json(429, { error: "RATE_LIMITED" });

    const result = await actOnApproval(serviceDeps(db, deps), { approvalId, workspaceId: target.id, action: body.value.action, actor: access.actor });
    return json(result.status, result.body);
  });
}

/** POST /api/v1/agents/:id/unfreeze (HITL-9). */
export function handleUnfreeze(request: Request, agentId: string, deps: HumanRouteDeps = defaultHumanRouteDeps()): Promise<Response> {
  return withHuman(request, deps, "unfreeze", async (db) => {
    if (!UUID.safeParse(agentId).success) return json(404, { error: "NOT_FOUND" });
    const [target] = await db
      .select({ id: workspaces.id, isSandbox: workspaces.isSandbox, retiredAt: workspaces.retiredAt, ownerUserId: workspaces.ownerUserId })
      .from(agents)
      .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
      .where(eq(agents.id, agentId));
    if (!target) return json(404, { error: "NOT_FOUND" });

    const access = await authorizeAction(db, request, target, deps);
    if (!access.ok) return access.response;
    if (access.sandbox && !(await underRateLimit(db, request, "unfreeze", deps))) return json(429, { error: "RATE_LIMITED" });

    const result = await unfreezeAgent(serviceDeps(db, deps), { agentId, actor: access.actor });
    return json(result.status, result.body);
  });
}
