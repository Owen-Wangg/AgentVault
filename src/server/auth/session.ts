import { env } from "@/server/env";

/**
 * The signed-in dashboard user (audit-and-approvals HITL-11), from the
 * Auth.js session cookie (telemetry-dashboard UI-2). Route handlers take
 * the lookup as a dependency, so tests inject a fake user.
 *
 * Never derive the user from an Authorization header: approval and
 * unfreeze routes reject every bearer header (HITL-10).
 */

export interface SessionUser {
  /** The Auth.js user ID, matched against `workspaces.owner_user_id`. */
  id: string;
  name?: string | null;
}

export type GetSessionUser = (request?: Request) => Promise<SessionUser | null>;

/**
 * Null when nobody is signed in, or when GitHub sign-in isn't configured
 * (nobody can be). Auth.js is imported on first use, so modules that only
 * pass this function around don't load it.
 */
export const getSessionUser: GetSessionUser = async () => {
  if (!env.githubAuthEnabled()) return null;
  const { auth } = await import("./auth");
  const session = await auth();
  const id = session?.user?.id;
  return typeof id === "string" && id !== "" ? { id, name: session?.user?.name ?? null } : null;
};
