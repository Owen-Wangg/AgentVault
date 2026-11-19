import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TEST_HEAD_KEY, buildChain, testTime } from "@/core/testing/audit-fixtures";
import { canonicalJson } from "./canonical";
import { type AuditEventBody, type ChainHead, EVENT_TYPES, type StoredEvent, verify, verifySegment } from "./chain";

const RUNS = { numRuns: 1000 };
const WS = "ws_prop";
const key = TEST_HEAD_KEY;

const payloadArb = fc.oneof(
  fc.record({ decision: fc.constantFrom("allow", "hold", "deny"), amount_micros: fc.bigInt({ min: 0n, max: 10n ** 15n }) }),
  fc.record({ status: fc.constantFrom("settled", "failed", "unknown"), decision_seq: fc.nat() }),
  fc.dictionary(fc.string({ maxLength: 5 }), fc.oneof(fc.string(), fc.maxSafeInteger(), fc.boolean(), fc.constant(null)), { maxKeys: 4 }),
);

const itemArb: fc.Arbitrary<Pick<AuditEventBody, "type" | "payload">> = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  payload: payloadArb,
});

const chainArb = (minLength: number) =>
  fc.array(itemArb, { minLength, maxLength: 12 }).map((items) => buildChain(WS, items, key));

/** Database order: rows come back sorted by seq. */
const bySeq = (events: readonly StoredEvent[]) => [...events].sort((a, b) => a.seq - b.seq);

type Edit = (e: StoredEvent, n: number) => StoredEvent;

/** Single-field edits that always change the row. */
const EDITS: Record<string, Edit> = {
  payload: (e) => ({ ...e, payload: { tampered: canonicalJson(e.payload) } }),
  type: (e) => ({ ...e, type: e.type === "decision" ? "rail_result" : "decision" }),
  created_at: (e) => ({ ...e, created_at: testTime(1_000_000) }),
  workspace_id: (e) => ({ ...e, workspace_id: "ws_attacker" }),
  prev_hash: (e) => ({ ...e, prev_hash: e.prev_hash.startsWith("f") ? "e".repeat(64) : "f".repeat(64) }),
  hash: (e) => ({ ...e, hash: e.hash.startsWith("f") ? "e".repeat(64) : "f".repeat(64) }),
  // Moved to an unused seq past the end. The unique key prevents duplicates.
  seq: (e, n) => ({ ...e, seq: n + 5 }),
};

describe("hash chain properties", () => {
  // Property 4, tamper detection (AUD-4, AUD-8): for any chain and any single
  // edit, delete, or swap, or the deletion of any non-empty suffix, `verify`
  // returns `ok: false` at the first affected `seq`. A head with a changed
  // `seq`, `hash`, or `mac` fails with `why: "head"`.
  it("AUD-4: an intact chain verifies with its count", () => {
    fc.assert(
      fc.property(chainArb(0), ({ events, head }) => {
        expect(verify(WS, events, head, key)).toEqual({ ok: true, count: events.length });
      }),
      RUNS,
    );
  });

  it("AUD-4: any single-field edit is caught at the edited row", () => {
    const arb = chainArb(1).chain((c) =>
      fc.tuple(fc.constant(c), fc.integer({ min: 1, max: c.events.length }), fc.constantFrom(...Object.keys(EDITS))),
    );
    fc.assert(
      fc.property(arb, ([{ events, head }, at, field]) => {
        const edit = EDITS[field] as Edit;
        const tampered = bySeq(events.map((e) => (e.seq === at ? edit(e, events.length) : e)));
        const result = verify(WS, tampered, head, key);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.brokenAtSeq).toBe(at);
      }),
      RUNS,
    );
  });

  it("AUD-4, AUD-8: deleting any one row is caught at that seq", () => {
    const arb = chainArb(1).chain((c) => fc.tuple(fc.constant(c), fc.integer({ min: 1, max: c.events.length })));
    fc.assert(
      fc.property(arb, ([{ events, head }, at]) => {
        const result = verify(WS, events.filter((e) => e.seq !== at), head, key);
        // The last row's deletion is a suffix deletion, caught by the head.
        expect(result).toEqual({ ok: false, brokenAtSeq: at, why: at === events.length ? "head" : "gap" });
      }),
      RUNS,
    );
  });

  it("AUD-4: swapping the contents of two rows is caught at the earlier one", () => {
    const arb = chainArb(2).chain((c) =>
      fc.tuple(fc.constant(c), fc.uniqueArray(fc.integer({ min: 1, max: c.events.length }), { minLength: 2, maxLength: 2 })),
    );
    fc.assert(
      fc.property(arb, ([{ events, head }, pair]) => {
        const [i, j] = [...pair].sort((a, b) => a - b) as [number, number];
        const a = events[i - 1] as StoredEvent;
        const b = events[j - 1] as StoredEvent;
        const swapped = events.map((e) => (e.seq === i ? { ...b, seq: i } : e.seq === j ? { ...a, seq: j } : e));
        const result = verify(WS, swapped, head, key);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.brokenAtSeq).toBe(i);
      }),
      RUNS,
    );
  });

  it("AUD-8: deleting any non-empty suffix is caught by the head at the first missing seq", () => {
    const arb = chainArb(1).chain((c) => fc.tuple(fc.constant(c), fc.integer({ min: 1, max: c.events.length })));
    fc.assert(
      fc.property(arb, ([{ events, head }, removed]) => {
        const kept = events.slice(0, events.length - removed);
        expect(verify(WS, kept, head, key)).toEqual({ ok: false, brokenAtSeq: kept.length + 1, why: "head" });
      }),
      RUNS,
    );
  });

  it("AUD-8: changing the head's seq, hash, or mac fails with why: head", () => {
    const change = fc.constantFrom<(h: ChainHead) => ChainHead>(
      (h) => ({ ...h, seq: h.seq + 1 }),
      (h) => ({ ...h, seq: h.seq - 1 }),
      (h) => ({ ...h, hash: h.hash.startsWith("f") ? "e".repeat(64) : "f".repeat(64) }),
      (h) => ({ ...h, mac: h.mac.startsWith("f") ? "e".repeat(64) : "f".repeat(64) }),
    );
    fc.assert(
      fc.property(chainArb(0), change, ({ events, head }, f) => {
        const result = verify(WS, events, f(head), key);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.why).toBe("head");
      }),
      RUNS,
    );
  });

  it("AUD-8: a head re-signed with any other key fails", () => {
    fc.assert(
      fc.property(
        chainArb(1),
        fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((k) => k.some((b, i) => b !== key[i])),
        ({ events }, otherKey) => {
          const forged = buildChain(WS, events.map(({ type, payload }) => ({ type, payload })), otherKey).head;
          expect(verify(WS, events, forged, key)).toEqual({ ok: false, brokenAtSeq: events.length + 1, why: "head" });
        },
      ),
      RUNS,
    );
    // Each run rebuilds and re-signs a whole chain, so this property takes about 4 s alone
    // and can pass Vitest's 5 s default when every test file runs at once.
  }, 30_000);
});

describe("segment verification", () => {
  /** A chain and a contiguous run of it, as [from, to) indexes. */
  const runArb = (minRun: number) =>
    chainArb(minRun).chain((c) =>
      fc.integer({ min: 0, max: c.events.length - minRun }).chain((from) =>
        fc.integer({ min: from + minRun, max: c.events.length }).map((to) => ({ chain: c, run: c.events.slice(from, to) })),
      ),
    );

  // telemetry-dashboard property 4, segment tamper detection (UI-26): for any
  // chain and any contiguous run of it, `verifySegment` accepts the untouched
  // run; a payload edit to any row of the run fails at that row with
  // `why: "hash"`; and deleting any row strictly inside the run fails at that
  // row's `seq` with `why: "gap"`.
  it("UI-26: any untouched run of a chain verifies with its length", () => {
    fc.assert(
      fc.property(runArb(0), ({ run }) => {
        expect(verifySegment(WS, run)).toEqual({ ok: true, count: run.length });
      }),
      RUNS,
    );
  });

  it("UI-26: a payload edit to any row of a run is caught at that row", () => {
    const arb = runArb(1).chain((r) => fc.tuple(fc.constant(r.run), fc.integer({ min: 0, max: r.run.length - 1 })));
    fc.assert(
      fc.property(arb, ([run, i]) => {
        const tampered = run.map((e, j) => (j === i ? EDITS.payload!(e, 0) : e));
        expect(verifySegment(WS, tampered)).toEqual({ ok: false, brokenAtSeq: (run[i] as StoredEvent).seq, why: "hash" });
      }),
      RUNS,
    );
  });

  it("UI-26: deleting any row strictly inside a run is caught at its seq", () => {
    const arb = runArb(3).chain((r) => fc.tuple(fc.constant(r.run), fc.integer({ min: 1, max: r.run.length - 2 })));
    fc.assert(
      fc.property(arb, ([run, i]) => {
        expect(verifySegment(WS, run.filter((_, j) => j !== i))).toEqual({ ok: false, brokenAtSeq: (run[i] as StoredEvent).seq, why: "gap" });
      }),
      RUNS,
    );
  });

  it("UI-26: a run from another workspace fails at its first row", () => {
    fc.assert(
      fc.property(runArb(1), ({ run }) => {
        expect(verifySegment("ws_other", run)).toEqual({ ok: false, brokenAtSeq: (run[0] as StoredEvent).seq, why: "hash" });
      }),
      RUNS,
    );
  });
});