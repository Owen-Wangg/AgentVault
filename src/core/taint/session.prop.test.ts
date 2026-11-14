import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type FetchOutcome, type TaintState, afterFetch } from "./session";

const RUNS = { numRuns: 1000 };

const fetchOutcomeArb: fc.Arbitrary<FetchOutcome> = fc.oneof(
  fc.constant({ ok: false } as const),
  fc.record({
    ok: fc.constant(true as const),
    label: fc.constantFrom("trusted" as const, "untrusted" as const),
    url: fc.webUrl(),
    contentSha256: fc.stringMatching(/^[0-9a-f]{64}$/),
    at: fc.date({ min: new Date("2026-01-01T00:00:00Z"), max: new Date("2027-01-01T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString()),
  }),
);

const CLEAN: TaintState = { taintedAt: null, taintSourceUrl: null, taintContentSha256: null };

describe("taint session properties", () => {
  // Property 2, taint is sticky (TAINT-5): for any sequence of agent
  // operations after a taint, `taintedAt` stays non-null.
  it("TAINT-5: once tainted, a session stays tainted with its first source", () => {
    fc.assert(
      fc.property(fc.array(fetchOutcomeArb, { maxLength: 30 }), (outcomes) => {
        let state = CLEAN;
        let first: TaintState | null = null;
        for (const outcome of outcomes) {
          state = afterFetch(state, outcome);
          if (first === null && state.taintedAt !== null) first = state;
          if (first !== null) expect(state).toEqual(first);
        }
        // Tainted exactly when some fetch returned untrusted content.
        const sawUntrusted = outcomes.some((o) => o.ok && o.label === "untrusted");
        expect(state.taintedAt !== null).toBe(sawUntrusted);
      }),
      RUNS,
    );
  });
});
