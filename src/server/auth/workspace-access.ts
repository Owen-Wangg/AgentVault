import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { currentSandbox } from "@/server/sandbox/sandbox";
import type { SessionUser } from "./session";

/**
 * Which workspace a dashboard read shows (telemetry-dashboard design,
 * "Auth and access"). Used by the approvals list.
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
