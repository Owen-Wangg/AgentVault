import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_HEAD_KEY, buildChain, testTime } from "@/core/testing/audit-fixtures";
import { CanonicalJsonError, canonicalJson } from "./canonical";
import { type AuditEventBody, GENESIS_HASH, type StoredEvent, chainHash, headMac, verify } from "./chain";
import vectors from "./vectors.json";

const WS = "ws_test";
const key = TEST_HEAD_KEY;
const body = (over: Partial<AuditEventBody> = {}): AuditEventBody => ({
  workspace_id: WS,
  seq: 1,
  type: "decision",
  created_at: testTime(0),
  payload: { decision: "allow", amount_micros: 1500n },
  ...over,
});
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "decision" as const, payload: { i } }));

describe("Property 8: fixed hash vectors (CJ-6, CJ-7)", () => {
  // Property 8, hash stability (CJ-6, CJ-7): fixed test vectors (body -> hash)
  // are checked in, so a change to the encoding fails the test.
  it.each(vectors.events)("CJ-6, CJ-7: $name", (v) => {
    const b = v.body as AuditEventBody;
    const { workspace_id, seq, type, created_at, payload } = b;
    expect(canonicalJson({ workspace_id, seq, type, created_at, payload })).toBe(v.canonical);
    expect(chainHash(v.prev_hash, b)).toBe(v.hash);
    // Independent check of the hash input against node:crypto.
    expect(createHash("sha256").update(v.prev_hash + v.canonical, "utf8").digest("hex")).toBe(v.hash);
  });

  it.each(vectors.heads)("AUD-7: $name", (v) => {
    const k = Uint8Array.from(Buffer.from(v.key_hex, "hex"));
    expect(headMac(k, v.workspace_id, v.seq, v.hash)).toBe(v.mac);
    expect(createHmac("sha256", k).update(v.message, "utf8").digest("hex")).toBe(v.mac);
  });

  it("CJ-7: the vectors form a valid two-event chain", () => {
    const [e1, e2] = vectors.events;
    expect(e2?.prev_hash).toBe(e1?.hash);
  });
});

describe("CJ-6, CJ-7: chainHash", () => {
  it("CJ-7: the first event uses 64 zeros as prev_hash", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    const expected = createHash("sha256").update(GENESIS_HASH + canonicalJson(body()), "utf8").digest("hex");
    expect(chainHash(GENESIS_HASH, body())).toBe(expected);
  });

  it("CJ-6: hashes only the five body fields", () => {
    const extra = { ...body(), prev_hash: GENESIS_HASH, hash: "f".repeat(64), note: "ignored" } as AuditEventBody;
    expect(chainHash(GENESIS_HASH, extra)).toBe(chainHash(GENESIS_HASH, body()));
  });

  it("CJ-6: workspace_id is hashed, so the same event in another workspace has another hash", () => {
    expect(chainHash(GENESIS_HASH, body({ workspace_id: "ws_other" }))).not.toBe(chainHash(GENESIS_HASH, body()));
  });

  it.each(["2026-11-18T09:30:00Z", "2026-11-18T09:30:00.123456Z", "2026-11-18T09:30:00.123+00:00", "yesterday"])(
    "CJ-6: rejects created_at %s",
    (created_at) => {
      expect(() => chainHash(GENESIS_HASH, body({ created_at }))).toThrow(CanonicalJsonError);
    },
  );

  it.each(["", "0".repeat(63), "A".repeat(64), "g".repeat(64)])("CJ-7: rejects prev_hash %j", (prev) => {
    expect(() => chainHash(prev, body())).toThrow(CanonicalJsonError);
  });

  it.each([0, -1, 1.5])("AUD-2: rejects seq %s", (seq) => {
    expect(() => chainHash(GENESIS_HASH, body({ seq }))).toThrow(CanonicalJsonError);
  });

  it("CJ-8: a float in the payload can't be hashed", () => {
    expect(() => chainHash(GENESIS_HASH, body({ payload: { amount: 0.15 } }))).toThrow(CanonicalJsonError);
  });
});

describe("AUD-7: headMac", () => {
  it("AUD-7: depends on the key, workspace, seq, and hash", () => {
    const base = headMac(key, WS, 3, "a".repeat(64));
    const otherKey = Uint8Array.from({ length: 32 }, () => 7);
    expect(headMac(otherKey, WS, 3, "a".repeat(64))).not.toBe(base);
    expect(headMac(key, "ws_other", 3, "a".repeat(64))).not.toBe(base);
    expect(headMac(key, WS, 4, "a".repeat(64))).not.toBe(base);
    expect(headMac(key, WS, 3, "b".repeat(64))).not.toBe(base);
  });

  it.each([0, 16, 31, 33, 64])("AUD-7: rejects a %s-byte key", (n) => {
    expect(() => headMac(new Uint8Array(n), WS, 1, GENESIS_HASH)).toThrow("32 bytes");
  });
});

describe("AUD-2, AUD-4: verify", () => {
  it("AUD-2: each event links to the previous one and seq counts up from 1", () => {
    const { events } = buildChain(WS, items(3));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(events[1]?.prev_hash).toBe(events[0]?.hash);
    expect(events[2]?.prev_hash).toBe(events[1]?.hash);
  });

  it("AUD-4: reports OK with the count for an intact chain", () => {
    const { events, head } = buildChain(WS, items(5));
    expect(verify(WS, events, head, key)).toEqual({ ok: true, count: 5 });
  });

  it("AUD-4: an empty workspace with its genesis head is OK", () => {
    const { events, head } = buildChain(WS, []);
    expect(head).toEqual({ seq: 0, hash: GENESIS_HASH, mac: headMac(key, WS, 0, GENESIS_HASH) });
    expect(verify(WS, events, head, key)).toEqual({ ok: true, count: 0 });
  });

  it("AUD-4: an edited payload is reported at that seq as a hash mismatch", () => {
    const { events, head } = buildChain(WS, items(5));
    const tampered = events.map((e) => (e.seq === 3 ? { ...e, payload: { i: 99 } } : e));
    expect(verify(WS, tampered, head, key)).toEqual({ ok: false, brokenAtSeq: 3, why: "hash" });
  });

  it("AUD-4: an edit that makes the payload unencodable is still just a hash mismatch", () => {
    const { events, head } = buildChain(WS, items(3));
    const tampered = events.map((e) => (e.seq === 2 ? { ...e, payload: { amount: 1.5 } } : e));
    expect(verify(WS, tampered, head, key)).toEqual({ ok: false, brokenAtSeq: 2, why: "hash" });
  });

  it("AUD-4: an edited prev_hash is reported as a broken link", () => {
    const { events, head } = buildChain(WS, items(4));
    const tampered = events.map((e) => (e.seq === 2 ? { ...e, prev_hash: "1".repeat(64) } : e));
    expect(verify(WS, tampered, head, key)).toEqual({ ok: false, brokenAtSeq: 2, why: "link" });
  });

  it("AUD-4: a deleted middle row is reported as a gap at the missing seq", () => {
    const { events, head } = buildChain(WS, items(5));
    expect(verify(WS, events.filter((e) => e.seq !== 3), head, key)).toEqual({ ok: false, brokenAtSeq: 3, why: "gap" });
  });

  it("AUD-4: a row from another workspace is a hash mismatch, even if re-hashed", () => {
    const other = buildChain("ws_other", items(2));
    expect(verify(WS, other.events, other.head, key)).toEqual({ ok: false, brokenAtSeq: 1, why: "hash" });
  });
});

describe("AUD-8: chain head", () => {
  it("AUD-8: rows deleted from the end are reported at the first missing seq", () => {
    const { events, head } = buildChain(WS, items(6));
    expect(verify(WS, events.slice(0, 4), head, key)).toEqual({ ok: false, brokenAtSeq: 5, why: "head" });
    expect(verify(WS, [], head, key)).toEqual({ ok: false, brokenAtSeq: 1, why: "head" });
  });

  it("AUD-8: a missing head fails at the seq after the last row", () => {
    const { events } = buildChain(WS, items(3));
    expect(verify(WS, events, null, key)).toEqual({ ok: false, brokenAtSeq: 4, why: "head" });
  });

  it("AUD-8: a head forged without the key fails", () => {
    const { events } = buildChain(WS, items(4));
    const kept = events.slice(0, 2);
    const last = kept[1] as StoredEvent;
    const wrongKey = Uint8Array.from({ length: 32 }, () => 1);
    const forged = { seq: 2, hash: last.hash, mac: headMac(wrongKey, WS, 2, last.hash) };
    expect(verify(WS, kept, forged, key)).toEqual({ ok: false, brokenAtSeq: 3, why: "head" });
  });

  it("AUD-8: a head copied from another workspace fails", () => {
    const mine = buildChain(WS, items(2));
    const theirs = buildChain("ws_other", items(2));
    // Same seq, and signed with the same key, but for another workspace's chain.
    expect(verify(WS, mine.events, theirs.head, key)).toEqual({ ok: false, brokenAtSeq: 3, why: "head" });
  });

  it("AUD-8: rows appended without updating the head are reported after the head's seq", () => {
    const longer = buildChain(WS, items(5));
    const shorter = buildChain(WS, items(3));
    expect(verify(WS, longer.events, shorter.head, key)).toEqual({ ok: false, brokenAtSeq: 4, why: "head" });
  });

  it("AUD-8: a validly signed head with the wrong hash fails at the last seq", () => {
    const { events } = buildChain(WS, items(3));
    const hash = "e".repeat(64);
    expect(verify(WS, events, { seq: 3, hash, mac: headMac(key, WS, 3, hash) }, key)).toEqual({
      ok: false,
      brokenAtSeq: 3,
      why: "head",
    });
  });

  it("AUD-8: a malformed head doesn't throw", () => {
    const { events } = buildChain(WS, items(2));
    const bad = { seq: 1.5, hash: 5, mac: null } as unknown as { seq: number; hash: string; mac: string };
    expect(verify(WS, events, bad, key)).toEqual({ ok: false, brokenAtSeq: 3, why: "head" });
  });
});
