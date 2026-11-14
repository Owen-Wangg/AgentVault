import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_MICROS, micros } from "@/core/money";
import { MICROS_EDGE_VALUES, anyMicros, microsWithEdges } from "./arbitraries";

describe("money arbitraries", () => {
  // Property: every generated amount is a valid micros value (0 to MAX_MICROS inclusive).
  it("generates only amounts in the valid range", () => {
    fc.assert(
      fc.property(microsWithEdges(), (m) => m >= 0n && m <= MAX_MICROS),
      { numRuns: 1000 },
    );
  });

  it("includes every edge value", () => {
    const seen = new Set(fc.sample(microsWithEdges(), { numRuns: 2000, seed: 42 }));
    for (const edge of MICROS_EDGE_VALUES) expect(seen.has(edge)).toBe(true);
  });

  it("respects a smaller maximum, including for edge values", () => {
    const max = micros(5_000n);
    for (const m of fc.sample(microsWithEdges(max), 500)) expect(m <= max).toBe(true);
  });

  it("produces bigints, never numbers", () => {
    for (const m of fc.sample(anyMicros(), 100)) expect(typeof m).toBe("bigint");
  });
});
