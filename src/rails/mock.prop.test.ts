import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Micros, type Rail, micros, toRailUnits } from "@/core/money";
import { MockRail } from "./mock";

// src/rails may import only src/core/money, so the shared generators in
// src/core/testing aren't available here. Amounts up to $10 with the
// cent and minimum boundaries mixed in.
const amountArb: fc.Arbitrary<Micros> = fc
  .oneof(
    { arbitrary: fc.bigInt({ min: 0n, max: 10_000_000n }), weight: 4 },
    { arbitrary: fc.constantFrom(0n, 1n, 9_999n, 10_000n, 499_999n, 500_000n, 500_001n), weight: 1 },
  )
  .map(micros);

const RUNS = { numRuns: 1000 };
const keyArb = fc.constantFrom("k1", "k2", "k3", "k4", "k5");
const railArb = fc.constantFrom<[Rail, bigint]>(["stripe", 50n], ["x402", 1n], ["x402", 10_000n], ["mock", 1n], ["paypal", 1n]);

const request = (key: string, amount: Micros) => ({ vendorUrl: "https://vendor.example/api", approvedMicros: amount, idempotencyKey: key });

describe("mock rail properties", () => {
  // Property 1, idempotency (RAIL-3): for any number of `execute` calls
  // with the same key, the mock adapter records one payment.
  it("RAIL-3: any number of execute calls with one key records at most one payment", async () => {
    await fc.assert(
      fc.asyncProperty(railArb, fc.array(amountArb, { minLength: 1, maxLength: 10 }), async ([rail, min], amounts) => {
        const adapter = new MockRail(rail, min);
        const results = [];
        for (const amount of amounts) results.push(await adapter.execute(request("same-key", amount)));
        const payments = adapter.recorded();
        expect(payments.length).toBeLessThanOrEqual(1);
        // After the first success, every replay returns that same result.
        const firstOk = results.findIndex((r) => r.ok);
        if (firstOk >= 0) for (const r of results.slice(firstOk)) expect(r).toEqual(results[firstOk]);
      }),
      RUNS,
    );
  });

  // Property 2, minimum (RAIL-4): for any amount below the minimum after
  // conversion, `execute` returns `BELOW_RAIL_MINIMUM` and makes no call.
  it("RAIL-4: any amount below the minimum after conversion is refused without a call", async () => {
    await fc.assert(
      fc.asyncProperty(railArb, amountArb, async ([rail, min], amount) => {
        const adapter = new MockRail(rail, min);
        const result = await adapter.execute(request("k", amount));
        const below = toRailUnits(amount, rail, "debit") < min;
        if (below) {
          expect(result).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
          expect(adapter.calls).toBe(0);
          expect(adapter.recorded()).toEqual([]);
        } else {
          expect(result.ok).toBe(true);
          // Never charges less than approved (MON-10).
          if (result.ok) expect(result.settledMicros >= amount).toBe(true);
        }
      }),
      RUNS,
    );
  });

  // Property 4, lookup is read-only (RAIL-21, RAIL-22): for any sequence of
  // `execute` and `lookup` calls on the mock adapter, the number of
  // recorded payments equals the number of distinct keys passed to
  // `execute`, and `lookup` reports `settled` exactly for keys with a
  // recorded payment.
  it("RAIL-21, RAIL-22: lookups never add payments, and report settled exactly for paid keys", async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant("execute" as const), key: keyArb }),
      fc.record({ kind: fc.constant("lookup" as const), key: keyArb }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        const adapter = new MockRail("x402", 1n);
        const executed = new Set<string>();
        for (const o of ops) {
          if (o.kind === "execute") {
            await adapter.execute(request(o.key, micros(1_500n)));
            executed.add(o.key);
          } else {
            const seen = await adapter.lookup(o.key);
            expect(seen.status).toBe(executed.has(o.key) ? "settled" : "unknown");
          }
        }
        expect(adapter.recorded().length).toBe(executed.size);
        expect(adapter.calls).toBe(executed.size);
      }),
      RUNS,
    );
  });

  const payoutRailArb = fc.constantFrom<[Rail, string]>(["stripe", "acct_1AcmeSupplies"], ["paypal", "supplier@personal.example.com"]);
  // Amounts of at least one cent, so every payout clears the 1-cent minimum.
  const payoutAmountArb = amountArb.filter((a) => a >= 10_000n);
  const payout = (key: string, amount: Micros, destination: string) => ({ destination, amountMicros: amount, idempotencyKey: key });

  // payout-rails property 3, one payout per key (PO-5): for any number of
  // `payout` calls with the same key on the mock adapter, one payout is
  // recorded.
  it("PO-5: any number of payout calls with one key records one payout, and replays return the first result", async () => {
    await fc.assert(
      fc.asyncProperty(payoutRailArb, fc.array(payoutAmountArb, { minLength: 1, maxLength: 10 }), async ([rail, destination], amounts) => {
        const adapter = new MockRail(rail, 1n);
        const results = [];
        for (const amount of amounts) results.push(await adapter.payout(payout("same-key", amount, destination)));
        expect(adapter.recorded()).toHaveLength(1);
        expect(adapter.calls).toBe(1);
        for (const r of results) expect(r).toEqual(results[0]);
        // PO-3: the payee gets the first amount rounded down, never more.
        const [first] = amounts;
        if (results[0]?.ok && first !== undefined) expect(results[0].settledMicros <= first).toBe(true);
      }),
      RUNS,
    );
  });

  // payout-rails property 6, lookup stays read-only (RAIL-22, PO-8): for
  // any sequence of payouts and lookups on the mock adapter, the number of
  // recorded payouts equals the number of distinct keys passed to `payout`.
  it("RAIL-22, PO-8: lookups never add payouts, and report settled exactly for keys paid out", async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant("payout" as const), key: keyArb }),
      fc.record({ kind: fc.constant("lookup" as const), key: keyArb }),
    );
    await fc.assert(
      fc.asyncProperty(payoutRailArb, fc.array(op, { maxLength: 30 }), async ([rail, destination], ops) => {
        const adapter = new MockRail(rail, 1n);
        const paid = new Set<string>();
        for (const o of ops) {
          if (o.kind === "payout") {
            await adapter.payout(payout(o.key, micros(1_000_000n), destination));
            paid.add(o.key);
          } else {
            expect((await adapter.lookup(o.key)).status).toBe(paid.has(o.key) ? "settled" : "unknown");
          }
        }
        expect(adapter.recorded().filter((r) => r.kind === "payout").length).toBe(paid.size);
        expect(adapter.recorded().length).toBe(paid.size);
      }),
      RUNS,
    );
  });
});
