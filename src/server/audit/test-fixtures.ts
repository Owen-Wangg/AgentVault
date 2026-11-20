import { eq } from "drizzle-orm";
import type { ChainHead, StoredEvent } from "@/core/audit";
import type { Db, Tx } from "@/server/db/client";
import { auditEvents, auditHeads } from "@/server/db/schema";
import { storedEvent } from "./append";

/**
 * Tests only: a workspace's whole chain and its head, in seq order. Not in
 * append.ts, so no request path can load a whole chain; verifyChain pages
 * through it instead.
 */
export async function loadChain(db: Db | Tx, workspaceId: string): Promise<{ events: StoredEvent[]; head: ChainHead | null }> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId)).orderBy(auditEvents.seq);
  const [head] = await db
    .select({ seq: auditHeads.seq, hash: auditHeads.hash, mac: auditHeads.mac })
    .from(auditHeads)
    .where(eq(auditHeads.workspaceId, workspaceId));
  return { events: rows.map(storedEvent), head: head ?? null };
}