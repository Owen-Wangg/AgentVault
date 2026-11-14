import fc from "fast-check";
import { describe, it } from "vitest";
import { anyMicros, microsWithEdges } from "@/core/testing/arbitraries";
import { MAX_MICROS, add, fromDecimalString, fromMicrosString, micros, sub, toDecimalString, toDisplay, toMicrosString } from "./micros";

const RUNS = { numRuns: 1000 };
// Three of these can be added without passing MAX_MICROS.
const THIRD = micros(MAX_MICROS / 3n);

describe("money properties", () => {
  // Property 1, round-trip (MON-2, MON-6): for all m, fromDecimalString(toDecimalString(m)) === m.
  it("MON-2: decimal strings round-trip exactly", () => {
    fc.assert(fc.property(microsWithEdges(), (m) => fromDecimalString(toDecimalString(m)) === m), RUNS);
  });

  // Property 1, display form (MON-6): the displayed text, without "$", parses back to the same amount.
  it("MON-6: displayed amounts parse back to the same value", () => {
    fc.assert(fc.property(microsWithEdges(), (m) => fromDecimalString(toDisplay(m).slice(1)) === m), RUNS);
  });

  it("wire strings round-trip exactly", () => {
    fc.assert(fc.property(microsWithEdges(), (m) => fromMicrosString(toMicrosString(m)) === m), RUNS);
  });

  // Property 2, algebra (MON-5): add is associative and commutative; sub(add(a, b), b) === a.
  it("MON-5: add is commutative", () => {
    fc.assert(fc.property(anyMicros(THIRD), anyMicros(THIRD), (a, b) => add(a, b) === add(b, a)), RUNS);
  });

  it("MON-5: add is associative", () => {
    fc.assert(
      fc.property(anyMicros(THIRD), anyMicros(THIRD), anyMicros(THIRD), (a, b, c) => add(add(a, b), c) === add(a, add(b, c))),
      RUNS,
    );
  });

  it("MON-5: sub undoes add", () => {
    fc.assert(fc.property(anyMicros(THIRD), anyMicros(THIRD), (a, b) => sub(add(a, b), b) === a), RUNS);
  });
});
