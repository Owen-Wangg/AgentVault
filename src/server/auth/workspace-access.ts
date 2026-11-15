import { and, desc, eq, sql } from "drizzle-orm";
import { type Db, queryRows } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { createWorkspace, currentSandbox } from "@/server/sandbox/sandbox";
import type { SessionUser } from "./session";

/**
 * Which workspace a dashboard read shows (telemetry-dashboard design,
 * "Auth and access"). Used by the approvals list and the event stream.
 */

export interface ReadableWorkspace {
  id: string;
  isSandbox: boolean;
  retired: boolean;
}

/**
 * The workspace a reader sees when they don't name one: a signed-in user's
 * own (non-sandbox) workspace, or the current sandbox for anyone else.
 * Undefined if there is none.
 */
export async function defaultWorkspace(db: Db, user: SessionUser | null): Promise<ReadableWorkspace | undefined> {
  if (user) {
    const [row] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.ownerUserId, user.id), eq(workspaces.isSandbox, false)))
      .orderBy(desc(workspaces.createdAt))
      .limit(1);
    return row ? { id: row.id, isSandbox: false, retired: false } : undefined;
  }
  const sandbox = await currentSandbox(db);
  return sandbox ? { id: sandbox.id, isSandbox: true, retired: false } : undefined;
}

/**
 * Open a signed-in user's personal workspace, creating it on first visit
 * (UI-2). A transaction-scoped advisory lock per user makes concurrent
 * first visits create one workspace, not two.
 */
export async function ensurePersonalWorkspace(db: Db, user: SessionUser, options: { key?: Uint8Array; now?: Date } = {}): Promise<ReadableWorkspace> {
  const existing = await defaultWorkspace(db, user);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    await queryRows(tx, sql`SELECT pg_advisory_xact_lock(hashtext(${`agentvault:personal-workspace:${user.id}`}))`);
    const [row] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.ownerUserId, user.id), eq(workspaces.isSandbox, false)))
      .orderBy(desc(workspaces.createdAt))
      .limit(1);
    if (row) return { id: row.id, isSandbox: false, retired: false };
    const name = user.name ? `${user.name}'s workspace` : "My workspace";
    const id = await createWorkspace(tx, { name, isSandbox: false, ownerUserId: user.id }, options);
    return { id, isSandbox: false, retired: false };
  });
}

export type ReadAccess = { ok: true; workspace: ReadableWorkspace } | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Read access to a named workspace (TEL-5). Any sandbox, current or
 * retired, is public to read: retired sandboxes stay readable (AUD-9),
 * so an open dashboard can finish showing the old one. Any other
 * workspace needs its owner signed in: 401 without a session, 403 for
 * someone else's workspace, 404 if it doesn't exist.
 */
export async function readAccess(db: Db, workspaceId: string, user: SessionUser | null): Promise<ReadAccess> {
  const [row] = await db
    .select({ id: workspaces.id, isSandbox: workspaces.isSandbox, retiredAt: workspaces.retiredAt, ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!row) return { ok: false, status: 404, error: "NO_WORKSPACE" };
  const workspace = { id: row.id, isSandbox: row.isSandbox, retired: row.retiredAt !== null };
  if (row.isSandbox) return { ok: true, workspace };
  if (!user) return { ok: false, status: 401, error: "UNAUTHORIZED" };
  // A workspace has one member, its owner (audit-and-approvals design).
  if (row.ownerUserId === null || row.ownerUserId !== user.id) return { ok: false, status: 403, error: "FORBIDDEN" };
  return { ok: true, workspace };
}
