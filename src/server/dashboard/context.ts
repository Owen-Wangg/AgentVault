import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type GetSessionUser, type SessionUser, getSessionUser } from "@/server/auth/session";
import { defaultWorkspace, ensurePersonalWorkspace } from "@/server/auth/workspace-access";
import { type Database, type Db, createDb } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { env } from "@/server/env";

/**
 * Data for dashboard server components (telemetry-dashboard design, "Auth
 * and access"). A signed-in user sees their personal workspace, created
 * on first visit (UI-2); anyone else sees the current sandbox (UI-1).
 */

export interface DashboardDeps {
  openDb: () => Database;
  getUser: GetSessionUser;
  signInAvailable: () => boolean;
  /** Signs the genesis head of a new personal workspace. */
  key: () => Uint8Array;
}

export function defaultDashboardDeps(): DashboardDeps {
  return { openDb: () => createDb(env.databaseUrl()), getUser: getSessionUser, signInAvailable: env.githubAuthEnabled, key: env.auditHeadKey };
}

/** The error a dashboard page sees. Details go only to the server log. */
export class DashboardDataError extends Error {
  constructor(readonly correlationId: string) {
    super(`Dashboard data failed to load [${correlationId}]`);
    this.name = "DashboardDataError";
  }
}

/**
 * Open the database, run `load`, and close it. Any error is logged with
 * its message and code only (driver errors can reference connection
 * settings) and rethrown as a DashboardDataError.
 */
export async function withDashboardDb<T>(deps: Pick<DashboardDeps, "openDb">, label: string, load: (db: Db) => Promise<T>): Promise<T> {
  let database: Database | undefined;
  try {
    database = deps.openDb();
    return await load(database.db);
  } catch (error) {
    const correlationId = randomUUID();
    const code = (error as { code?: unknown } | null)?.code;
    console.error(`${label} failed [${correlationId}]${typeof code === "string" ? ` ${code}` : ""}:`, error instanceof Error ? error.message : "unknown error");
    throw new DashboardDataError(correlationId);
  } finally {
    await database?.close().catch(() => {});
  }
}

export interface DashboardWorkspace {
  id: string;
  name: string;
  isSandbox: boolean;
  retired: boolean;
}

export interface DashboardContext {
  user: SessionUser | null;
  signInAvailable: boolean;
  workspace: DashboardWorkspace | null;
}

export function loadDashboardContext(deps: DashboardDeps = defaultDashboardDeps()): Promise<DashboardContext> {
  return withDashboardDb(deps, "dashboard context", async (db) => {
    const user = await deps.getUser();
    const found = user ? await ensurePersonalWorkspace(db, user, { key: deps.key() }) : await defaultWorkspace(db, null);
    let workspace: DashboardWorkspace | null = null;
    if (found) {
      const [row] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, found.id));
      workspace = { ...found, name: row?.name ?? "" };
    }
    return { user, signInAvailable: deps.signInAvailable(), workspace };
  });
}
