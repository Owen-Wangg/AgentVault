import { z } from "zod";
import { EnvelopeWireSchema, envelopeFromWire } from "@/core/policy";
import { withHuman } from "@/server/approvals/handlers";
import { type GetSessionUser, type SessionUser, getSessionUser } from "@/server/auth/session";
import { ensurePersonalWorkspace } from "@/server/auth/workspace-access";
import { type Database, type Db, createDb } from "@/server/db/client";
import { agents, workspaces } from "@/server/db/schema";
import { env } from "@/server/env";
import { json, parseBody } from "@/server/http/agent-route";
import { eq } from "drizzle-orm";
import { createWorkspaceAgent, updateEnvelope } from "./manage";

/**
 * POST /api/v1/agents and PUT /api/v1/agents/:id/envelope (UI-7, UI-8).
 * Human-only, like the approvals routes: bearer headers and cross-site
 * requests are 403 before the database opens. Only a workspace's
 * signed-in owner may create agents or change envelopes. The public
 * sandbox is read-only here: anonymous visitors may approve, deny, and
 * unfreeze there (HITL-11), but not mint API keys or loosen limits that
 * every visitor's demo runs under.
 */

export interface AgentAdminDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  getUser: GetSessionUser;
}

export function defaultAgentAdminDeps(): AgentAdminDeps {
  return { openDb: () => createDb(env.databaseUrl()), key: env.auditHeadKey, now: () => new Date(), getUser: getSessionUser };
}

const UUID = z.uuid();

/** Printable characters, no control characters, 1 to 60 after trimming. */
const CreateBodySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Give the agent a name")
    .max(60, "At most 60 characters")
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, "No control characters"),
});

/** Never cache a response that holds an API key. */
const noStore = (response: Response): Response => {
  response.headers.set("cache-control", "no-store");
  return response;
};

export function handleCreateAgent(request: Request, deps: AgentAdminDeps = defaultAgentAdminDeps()): Promise<Response> {
  return withHuman(request, deps, "create agent", async (db) => {
    const user = await deps.getUser(request);
    if (!user) return json(401, { error: "UNAUTHORIZED" });
    const body = await parseBody(request, CreateBodySchema);
    if (!body.ok) return body.response;
    const workspace = await ensurePersonalWorkspace(db, user, { key: deps.key() });
    const { agentId, apiKey } = await createWorkspaceAgent(db, { workspaceId: workspace.id, name: body.value.name, now: deps.now() });
    return noStore(json(201, { agent_id: agentId, name: body.value.name, workspace_id: workspace.id, api_key: apiKey }));
  });
}

/** The agent's workspace, if the user owns it. */
async function ownedAgent(db: Db, agentId: string, user: SessionUser | null): Promise<{ ok: true; workspaceId: string; actor: string } | { ok: false; response: Response }> {
  const [row] = await db
    .select({ workspaceId: workspaces.id, isSandbox: workspaces.isSandbox, ownerUserId: workspaces.ownerUserId })
    .from(agents)
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(eq(agents.id, agentId));
  if (!row) return { ok: false, response: json(404, { error: "NOT_FOUND" }) };
  if (row.isSandbox) return { ok: false, response: json(403, { error: "SANDBOX_READ_ONLY" }) };
  if (!user) return { ok: false, response: json(401, { error: "UNAUTHORIZED" }) };
  if (row.ownerUserId === null || row.ownerUserId !== user.id) return { ok: false, response: json(403, { error: "FORBIDDEN" }) };
  return { ok: true, workspaceId: row.workspaceId, actor: user.id };
}

export function handleUpdateEnvelope(request: Request, agentId: string, deps: AgentAdminDeps = defaultAgentAdminDeps()): Promise<Response> {
  return withHuman(request, deps, "update envelope", async (db) => {
    if (!UUID.safeParse(agentId).success) return json(404, { error: "NOT_FOUND" });
    const access = await ownedAgent(db, agentId, await deps.getUser(request));
    if (!access.ok) return access.response;
    const body = await parseBody(request, EnvelopeWireSchema);
    if (!body.ok) return body.response;
    const result = await updateEnvelope(
      db,
      { agentId, workspaceId: access.workspaceId, envelope: envelopeFromWire(body.value), expectedVersion: body.value.expectedVersion, actor: access.actor },
      { key: deps.key(), now: deps.now() },
    );
    return result.ok ? json(200, { agent_id: agentId, version: result.version }) : json(result.status, result.body);
  });
}
