import { and, asc, eq, gt } from "drizzle-orm";
import {
  type AuditEventBody,
  type EventType,
  GENESIS_HASH,
  type StoredEvent,
  type VerifyResult,
  canonicalJson,
  chainHash,
  headMac,
  finishVerify,
  headMacIsValid,
  startVerify,
  verifyNext,
} from "@/core/audit";
import type { Db, Tx } from "@/server/db/client";
import { auditEvents, auditHeads } from "@/server/db/schema";
import { env } from "@/server/env";

/** The head is missing or its MAC is wrong, so the chain can't be safely extended. */
export class AuditHeadError extends Error {
  readonly code = "AUDIT_HEAD_INVALID";
  constructor(workspaceId: string, problem: string) {
    super(`Audit head for workspace ${workspaceId} ${problem}; refusing to append`);
    this.name = "AuditHeadError";
  }
}

export interface AppendInput {
  workspaceId: string;
  type: EventType;
  /** Must be canonically encodable: no floats, Dates, or undefined array elements (CJ-8). */
  payload: unknown;
}

export interface AppendOptions {
  /** Defaults to AUDIT_HEAD_KEY. */
  key?: Uint8Array;
  /** Defaults to the current time. Stored and hashed at millisecond precision. */
  now?: Date;
}

/** Create a workspace's genesis head: seq 0, the genesis hash, and its MAC. */
export async function createHead(tx: Tx, workspaceId: string, options: Pick<AppendOptions, "key"> = {}): Promise<void> {
  const key = options.key ?? env.auditHeadKey();
  await tx.insert(auditHeads).values({ workspaceId, seq: 0, hash: GENESIS_HASH, mac: headMac(key, workspaceId, 0, GENESIS_HASH) });
}

/**
 * Append one event to the workspace's chain inside the caller's
 * transaction (AUD-2, AUD-7):
 * 1. Lock the head row, which serializes appends per workspace.
 * 2. Check the head's MAC, so a head forged in the database is never
 *    extended and re-signed (that would hide a deleted tail).
 * 3. Insert the event with seq = head.seq + 1 and its chain hash.
 * 4. Move the head to the new event and re-sign it.
 * Throws if the payload can't be canonically encoded or the head is bad;
 * the caller's transaction then rolls back (CJ-8, PXY-7).
 */
export async function appendEvent(tx: Tx, input: AppendInput, options: AppendOptions = {}): Promise<StoredEvent> {
  const key = options.key ?? env.auditHeadKey();
  const [head] = await tx
    .select({ seq: auditHeads.seq, hash: auditHeads.hash, mac: auditHeads.mac })
    .from(auditHeads)
    .where(eq(auditHeads.workspaceId, input.workspaceId))
    .for("update");
  if (!head) throw new AuditHeadError(input.workspaceId, "is missing");
  if (!headMacIsValid(key, input.workspaceId, head)) throw new AuditHeadError(input.workspaceId, "has an invalid MAC");

  // Store exactly what is hashed: the canonical form, parsed back. Bigints
  // become digit strings here, so the jsonb read back hashes the same.
  const payload: unknown = JSON.parse(canonicalJson(input.payload));
  const createdAt = new Date((options.now ?? new Date()).getTime());
  const body: AuditEventBody = {
    workspace_id: input.workspaceId,
    seq: head.seq + 1,
    type: input.type,
    created_at: createdAt.toISOString(),
    payload,
  };
  const hash = chainHash(head.hash, body);

  await tx.insert(auditEvents).values({
    workspaceId: body.workspace_id,
    seq: body.seq,
    type: body.type,
    payload,
    prevHash: head.hash,
    hash,
    createdAt,
  });
  await tx
    .update(auditHeads)
    .set({ seq: body.seq, hash, mac: headMac(key, input.workspaceId, body.seq, hash), updatedAt: createdAt })
    .where(eq(auditHeads.workspaceId, input.workspaceId));
  return { ...body, prev_hash: head.hash, hash };
}



/** Rows read per page when verifying, so a long chain is never loaded whole. */
export const VERIFY_PAGE_SIZE = 1_000;

/**
 * Verify a workspace's chain against its signed head (AUD-4, AUD-8).
 * Also returns the head's seq, which the dashboard shows so that a head
 * rolled back to an older signed value is visible to anyone comparing.
 * Rows are read in pages of `pageSize` by seq, inside one read-only
 * repeatable-read transaction, so the rows and the head come from the
 * same snapshot even while other requests append.
 */
export async function verifyChain(
  db: Db,
  workspaceId: string,
  options: Pick<AppendOptions, "key"> & { pageSize?: number } = {},
): Promise<VerifyResult & { headSeq: number | null }> {
  const key = options.key ?? env.auditHeadKey();
  const pageSize = options.pageSize ?? VERIFY_PAGE_SIZE;
  return db.transaction(
    async (tx) => {
      const [head] = await tx
        .select({ seq: auditHeads.seq, hash: auditHeads.hash, mac: auditHeads.mac })
        .from(auditHeads)
        .where(eq(auditHeads.workspaceId, workspaceId));
      let state = startVerify();
      let after = 0;
      for (;;) {
        const rows = await tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.workspaceId, workspaceId), gt(auditEvents.seq, after)))
          .orderBy(asc(auditEvents.seq))
          .limit(pageSize);
        for (const row of rows) {
          const next = verifyNext(workspaceId, state, storedEvent(row));
          if ("ok" in next) return { ...next, headSeq: head?.seq ?? null };
          state = next;
          after = row.seq;
        }
        if (rows.length < pageSize) break;
      }
      return { ...finishVerify(workspaceId, state, head ?? null, key), headSeq: head?.seq ?? null };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** A database row in the shape the pure verifier takes. */
export function storedEvent(r: typeof auditEvents.$inferSelect): StoredEvent {
  return {
    workspace_id: r.workspaceId,
    seq: r.seq,
    type: r.type as EventType,
    created_at: r.createdAt.toISOString(),
    payload: r.payload,
    prev_hash: r.prevHash,
    hash: r.hash,
  };
}
