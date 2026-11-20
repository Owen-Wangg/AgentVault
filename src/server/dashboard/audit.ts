import { and, desc, eq, lt } from "drizzle-orm";
import type { EventType } from "@/core/audit/chain";
import type { Db } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";

/**
 * One page of a workspace's audit log, newest first (telemetry-dashboard
 * UI-10). Pages go backwards by seq: `before` is the oldest seq of the
 * page the reader came from.
 */

export const AUDIT_PAGE_SIZE = 50;

export interface AuditEventRow {
  workspace_id: string;
  seq: number;
  type: string;
  created_at: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export interface AuditPage {
  events: AuditEventRow[];
  /** The `before` for the next page, or null on the last one. */
  older: number | null;
}

export async function listAuditEvents(
  db: Db,
  workspaceId: string,
  options: { before?: number; limit?: number; /** Only this event type (UI-31). */ type?: EventType } = {},
): Promise<AuditPage> {
  const limit = options.limit ?? AUDIT_PAGE_SIZE;
  const where = and(
    eq(auditEvents.workspaceId, workspaceId),
    options.before === undefined ? undefined : lt(auditEvents.seq, options.before),
    options.type === undefined ? undefined : eq(auditEvents.type, options.type),
  );
  // One extra row says whether there is an older page.
  const rows = await db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.seq)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({
      workspace_id: r.workspaceId,
      seq: r.seq,
      type: r.type,
      created_at: r.createdAt.toISOString(),
      payload: r.payload,
      prev_hash: r.prevHash,
      hash: r.hash,
    })),
    older: rows.length > limit ? (page.at(-1)?.seq ?? null) : null,
  };
}
