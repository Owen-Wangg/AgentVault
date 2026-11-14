import { type AuditEventBody, type ChainHead, GENESIS_HASH, type StoredEvent, chainHash, headMac } from "@/core/audit/chain";

/** A fixed 32-byte test key: bytes 0 to 31. */
export const TEST_HEAD_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

/** Millisecond-precision ISO time, `ms` after a fixed start. */
export const testTime = (ms: number): string => new Date(Date.UTC(2026, 10, 18, 9, 30) + ms).toISOString();

/** Build a valid chain and its signed head from event types and payloads. */
export function buildChain(
  workspaceId: string,
  items: readonly Pick<AuditEventBody, "type" | "payload">[],
  key: Uint8Array = TEST_HEAD_KEY,
): { events: StoredEvent[]; head: ChainHead } {
  const events: StoredEvent[] = [];
  let prev = GENESIS_HASH;
  items.forEach((item, i) => {
    const body: AuditEventBody = { workspace_id: workspaceId, seq: i + 1, type: item.type, created_at: testTime(i), payload: item.payload };
    const hash = chainHash(prev, body);
    events.push({ ...body, prev_hash: prev, hash });
    prev = hash;
  });
  const seq = events.length;
  return { events, head: { seq, hash: prev, mac: headMac(key, workspaceId, seq, prev) } };
}
