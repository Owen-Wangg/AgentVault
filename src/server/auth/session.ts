/**
 * The signed-in dashboard user (audit-and-approvals HITL-11). Returns null
 * until telemetry-dashboard task 3 replaces it with the Auth.js session,
 * so outside the sandbox every approval action is 401 for now. Route
 * handlers take the lookup as a dependency, so tests inject a fake user.
 *
 * Never derive the user from an Authorization header: approval and
 * unfreeze routes reject every bearer header (HITL-10).
 */

export interface SessionUser {
  /** The Auth.js user ID, matched against `workspaces.owner_user_id`. */
  id: string;
}

export type GetSessionUser = (request: Request) => Promise<SessionUser | null>;

export const getSessionUser: GetSessionUser = async () => null;
