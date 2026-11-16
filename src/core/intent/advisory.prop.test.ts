import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate } from "@/core/policy/evaluate";
import type { Decision, ReasonDetail } from "@/core/policy/types";
import { advisoryScoreArb, evaluateInputArb } from "@/core/testing/arbitraries";
import { ADVISORY_DRIFT_THRESHOLD, advisoryRule } from "./advisory";

const RUNS = { numRuns: 1000 };
const SEVERITY: Record<Decision["decision"], number> = { allow: 0, hold: 1, deny: 2 };

/** Each reason as a string, so the comparison counts repeats (a multiset). */
const keys = (reasons: readonly ReasonDetail[]) => reasons.map((r) => JSON.stringify([r.code, r.detail ?? null]));

/** True if every element of `small` is in `big`, at least as many times. */
function isSubMultiset(small: readonly string[], big: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const k of big) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const k of small) {
    const n = counts.get(k) ?? 0;
    if (n === 0) return false;
    counts.set(k, n - 1);
  }
  return true;
}

describe("taint-and-intent property 3", () => {
  // Property 3. Advisory can't loosen (INT-9): for any input and score, the
  // reasons with the score are a superset of the reasons without it.
  it("INT-9: for any input and score, the reasons with the score are a superset of the reasons without it", () => {
    fc.assert(
      fc.property(evaluateInputArb(), advisoryScoreArb(), (input, score) => {
        const without = evaluate(input);
        const withScore = evaluate({ ...input, advisoryDriftScore: score });
        expect(isSubMultiset(keys(without.reasons), keys(withScore.reasons))).toBe(true);
        // So the decision can only get stricter: a deny or hold never becomes an allow.
        expect(SEVERITY[withScore.decision]).toBeGreaterThanOrEqual(SEVERITY[without.decision]);
      }),
      RUNS,
    );
  });

  it("INT-8: for any score, advisoryRule adds ADVISORY_DRIFT exactly when the score is at or above the threshold", () => {
    fc.assert(
      fc.property(advisoryScoreArb(), (score) => {
        const reasons = advisoryRule(score, ADVISORY_DRIFT_THRESHOLD);
        expect(reasons.map((r) => r.code)).toEqual(score >= ADVISORY_DRIFT_THRESHOLD ? ["ADVISORY_DRIFT"] : []);
      }),
      RUNS,
    );
  });
});
