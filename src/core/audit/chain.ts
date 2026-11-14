import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { CanonicalJsonError, canonicalJson } from "./canonical";

/**
 * Hash-chain math for the audit log (AUD-2, AUD-4, AUD-7, AUD-8, CJ-6,
 * CJ-7). Pure: no clock, no database. `@noble/hashes` keeps it free of
 * Node APIs, so the browser can recompute a chain too. Only the server
 * holds the head key, so only the server can check the head MAC.
 */

export const EVENT_TYPES = [
  "decision",
  "rail_result",
  "taint",
  "approval_created",
  "approval_decided",
  "approval_expired",
  "approval_executed",
  "agent_frozen",
  "agent_unfrozen",
  "envelope_updated",
  "scenario_started",
  "sandbox_created",
  "sandbox_retired",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The hashed body of an event: exactly these five fields (CJ-6). */
export interface AuditEventBody {
  workspace_id: string;
  seq: number;
  type: EventType;
  /** ISO 8601 UTC with exactly 3 fractional digits, set by the application. */
  created_at: string;
  payload: unknown;
}

/** An event as stored in `audit_events`. */
export interface StoredEvent extends AuditEventBody {
  prev_hash: string;
  hash: string;
}

/** The workspace's checkpoint row in `audit_heads` (AUD-7). */
export interface ChainHead {
  seq: number;
  hash: string;
  mac: string;
}

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: number; why: "hash" | "link" | "gap" | "head" };

/** `prev_hash` of the first event in a workspace (CJ-7). */
export const GENESIS_HASH = "0".repeat(64);

export const HEAD_KEY_BYTES = 32;

const HEX_64 = /^[0-9a-f]{64}$/;
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The event's hash (CJ-7): lowercase hex SHA-256 of the UTF-8 bytes of
 * `prevHash` followed directly by the canonical JSON of the body. Only the
 * five CJ-6 fields are hashed, even if `event` carries more.
 * Throws CanonicalJsonError if the body can't be encoded (CJ-8).
 */
export function chainHash(prevHash: string, event: AuditEventBody): string {
  if (!HEX_64.test(prevHash)) throw new CanonicalJsonError("prev_hash", "must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new CanonicalJsonError("$.seq", "must be a positive integer");
  if (typeof event.created_at !== "string" || !CREATED_AT.test(event.created_at)) {
    throw new CanonicalJsonError("$.created_at", "must be ISO 8601 UTC with 3 fractional digits, like 2026-11-18T09:30:00.123Z");
  }
  const body = {
    workspace_id: event.workspace_id,
    seq: event.seq,
    type: event.type,
    created_at: event.created_at,
    payload: event.payload,
  };
  return bytesToHex(sha256(utf8ToBytes(prevHash + canonicalJson(body))));
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== HEAD_KEY_BYTES) {
    throw new Error(`The audit head key must be ${HEAD_KEY_BYTES} bytes`);
  }
}

/**
 * HMAC-SHA256 of the head, so that a head can't be rewritten without the
 * server's key (AUD-7). The MAC covers the workspace, so a head copied
 * from another workspace fails too.
 */
export function headMac(key: Uint8Array, workspaceId: string, seq: number, hash: string): string {
  assertKey(key);
  const message = canonicalJson({ workspace_id: workspaceId, seq, hash });
  return bytesToHex(hmac(sha256, key, utf8ToBytes(message)));
}

/** Compare two strings without stopping at the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether the head's MAC is genuine for this workspace. Appending checks
 * this before extending the chain, so a forged head is never re-signed.
 */
export function headMacIsValid(key: Uint8Array, workspaceId: string, head: ChainHead): boolean {
  return (
    Number.isSafeInteger(head.seq) &&
    typeof head.hash === "string" &&
    typeof head.mac === "string" &&
    constantTimeEqual(headMac(key, workspaceId, head.seq, head.hash), head.mac)
  );
}

function hashMatches(event: StoredEvent): boolean {
  try {
    return chainHash(event.prev_hash, event) === event.hash;
  } catch {
    // A tampered row may not even be encodable (for example a float in the payload).
    return false;
  }
}

/**
 * Verify a workspace's chain (AUD-4, AUD-8). `events` must be every row for
 * the workspace in `seq` order. Reports the first `seq` that is wrong:
 * - `gap`: the next row's `seq` isn't the expected one, so that `seq` is missing.
 * - `link`: the row's `prev_hash` isn't the previous row's `hash`.
 * - `hash`: the row's `hash` doesn't match its contents, or the row belongs to another workspace.
 * - `head`: the head is missing, its MAC is invalid, or it doesn't match the last row.
 *   Rows deleted from the end report the first missing `seq`.
 * Never throws for tampered data; throws only if the key is the wrong size.
 */
export function verify(
  workspaceId: string,
  events: readonly StoredEvent[],
  head: ChainHead | null,
  key: Uint8Array,
): VerifyResult {
  assertKey(key);
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const event of events) {
    if (event.seq !== expectedSeq) return { ok: false, brokenAtSeq: expectedSeq, why: "gap" };
    if (event.prev_hash !== prev) return { ok: false, brokenAtSeq: expectedSeq, why: "link" };
    if (event.workspace_id !== workspaceId || !hashMatches(event)) return { ok: false, brokenAtSeq: expectedSeq, why: "hash" };
    prev = event.hash;
    expectedSeq += 1;
  }
  const lastSeq = expectedSeq - 1;
  // Without a genuine head, rows after the last one may have been deleted.
  if (head === null || !headMacIsValid(key, workspaceId, head)) return { ok: false, brokenAtSeq: lastSeq + 1, why: "head" };
  // Rows the head knows about are missing from the end.
  if (head.seq > lastSeq) return { ok: false, brokenAtSeq: lastSeq + 1, why: "head" };
  // Rows exist that the head never recorded.
  if (head.seq < lastSeq) return { ok: false, brokenAtSeq: head.seq + 1, why: "head" };
  if (head.hash !== prev) return { ok: false, brokenAtSeq: lastSeq === 0 ? 1 : lastSeq, why: "head" };
  return { ok: true, count: lastSeq };
}
