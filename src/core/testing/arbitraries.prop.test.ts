import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_MICROS, micros } from "@/core/money";
import { EvaluateInputSchema } from "@/core/policy/schemas";
import { MICROS_EDGE_VALUES, anyMicros, envelopeArb, evaluateInputArb, microsWithEdges } from "./arbitraries";

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

describe("policy arbitraries", () => {
  // Property: every generated evaluate() input passes the input schema, so
  // policy properties test the rules rather than INVALID_REQUEST.
  it("ENV-15: generates only schema-valid evaluate() inputs", () => {
    fc.assert(
      fc.property(evaluateInputArb(), (input) => EvaluateInputSchema.safeParse(input).success),
      { numRuns: 1000 },
    );
  });

  it("generates vendor and tool limit records whose keys are own properties, including __proto__", () => {
    const envelopes = fc.sample(envelopeArb(), { numRuns: 2000, seed: 42 });
    const protoKeyed = envelopes.filter((e) => Object.hasOwn(e.vendorLimits, "__proto__"));
    expect(protoKeyed.length).toBeGreaterThan(0);
    for (const e of protoKeyed) expect(Object.getPrototypeOf(e.vendorLimits)).toBe(Object.prototype);
  });
});
