import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "@/server/db/client";
import { agents } from "@/server/db/schema";

/**
 * Agent API keys (PXY-1 to PXY-3). A key is `av_test_` plus 32 random
 * bytes in base64url, 256 bits of entropy. It is shown once, when the
 * agent is created; only its SHA-256 hash is stored.
 */

export const KEY_PREFIX = "av_test_";
/** 32 bytes in base64url is 43 characters with no padding. */
const KEY_FORMAT = /^av_test_[A-Za-z0-9_-]{43}$/;

export function generateApiKey(): { key: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The key from an `Authorization: Bearer <key>` header, or null if the header is missing or malformed. */
export function bearerKey(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match?.[1] || !KEY_FORMAT.test(match[1])) return null;
  return match[1];
}

export interface AuthenticatedAgent {
  id: string;
  workspaceId: string;
  name: string;
}

/**
 * Find the agent for a bearer header (PXY-2). The lookup is by the
 * SHA-256 of the key through the unique index on the hash. Timing there
 * reveals nothing useful: the attacker would have to guess hashes of
 * 256-bit random keys. The timingSafeEqual below is a second check that
 * the row's hash is the one asked for, as security-standards §2 requires;
 * it does not by itself make the lookup constant-time.
 * Returns null for a missing, malformed, unknown, or revoked key (PXY-3).
 */
export async function authenticateAgent(db: Db | Tx, authorization: string | null | undefined): Promise<AuthenticatedAgent | null> {
  const key = bearerKey(authorization);
  if (key === null) return null;
  const hash = hashApiKey(key);
  const [row] = await db
    .select({ id: agents.id, workspaceId: agents.workspaceId, name: agents.name, hash: agents.apiKeyHash, revokedAt: agents.revokedAt })
    .from(agents)
    .where(eq(agents.apiKeyHash, hash))
    .limit(1);
  if (!row) return null;
  const matches = timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex"));
  if (!matches || row.revokedAt !== null) return null;
  return { id: row.id, workspaceId: row.workspaceId, name: row.name };
}
