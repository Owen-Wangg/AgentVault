import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { microsWithEdges } from "@/core/testing/arbitraries";
import { floatToStripeCents } from "./__fixtures__/float-rail-units";
import type { Micros } from "./micros";
import { chargeableMicros, toRailUnits, type Direction, type Rail } from "./rail-units";

const RUNS = { numRuns: 1000 };
const CENT = 10_000n;
const rails = fc.constantFrom<Rail>("stripe", "x402", "mock");
const directions = fc.constantFrom<Direction>("debit", "credit");

/** Property 3 as a reusable predicate, so it can also be run against the broken fixture. */
const debitNeverFavorsAgent = (toCents: (m: Micros) => bigint) => (m: Micros) => {
  const cents = toCents(m);
  return cents * CENT >= m && cents * CENT < m + CENT;
};

describe("rail conversion properties", () => {
  // Property 3, debit rounding never favors the agent (MON-7, MON-10):
  // toRailUnits(m, "stripe", "debit") * 10_000n >= m and < m + 10_000n.
  it("MON-7: Stripe debits never round below the amount, and round up by less than a cent", () => {
    fc.assert(fc.property(microsWithEdges(), debitNeverFavorsAgent((m) => toRailUnits(m, "stripe", "debit"))), RUNS);
  });

  // Property 4, credit rounding never favors the agent (MON-8):
  // toRailUnits(m, "stripe", "credit") * 10_000n <= m.
  it("MON-8: Stripe credits never round above the amount", () => {
    fc.assert(
      fc.property(microsWithEdges(), (m) => {
        const cents = toRailUnits(m, "stripe", "credit");
        return cents * CENT <= m && cents * CENT > m - CENT;
      }),
      RUNS,
    );
  });

  // Property 9, counted amount never under-counts (MON-10, MON-11):
  // for all m, rails, and directions, chargeableMicros(m, rail, dir) >= m.
  it("MON-10, MON-11: the amount counted against the envelope is never less than requested", () => {
    fc.assert(fc.property(microsWithEdges(), rails, directions, (m, rail, dir) => chargeableMicros(m, rail, dir) >= m), RUNS);
  });

  it("MON-9: x402 and mock conversion is exact in both directions", () => {
    fc.assert(
      fc.property(microsWithEdges(), fc.constantFrom<Rail>("x402", "mock"), directions, (m, rail, dir) => toRailUnits(m, rail, dir) === m),
      RUNS,
    );
  });

  // The broken float fixture rounds to the nearest cent, so property 3 must fail on it.
  it("MON-7: property 3 catches a float implementation that rounds to the nearest cent", () => {
    const result = fc.check(fc.property(microsWithEdges(), debitNeverFavorsAgent(floatToStripeCents)), { ...RUNS, seed: 20261114 });
    expect(result.failed).toBe(true);
    // Shrinking finds the smallest amount the float version under-charges: 1 micro rounds to 0 cents.
    expect(result.counterexample).toEqual([1n]);
  });
});
