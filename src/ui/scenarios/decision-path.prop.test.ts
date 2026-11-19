import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REASON_CODES, isDenyReason, isHoldReason } from "@/core/policy";
import { CHECKS, decisionPath } from "./decision-path";

const RUNS = { numRuns: 1000 };

/** A decision as evaluate() would make it from these codes: deny beats hold beats allow (ENV-12). */
const decisionOf = (codes: readonly string[]): "allow" | "hold" | "deny" => {
  const known = codes.filter((c): c is (typeof REASON_CODES)[number] => (REASON_CODES as readonly string[]).includes(c));
  if (known.some(isDenyReason)) return "deny";
  if (known.some(isHoldReason)) return "hold";
  return "allow";
};

const codesArb = fc.uniqueArray(fc.constantFrom(...REASON_CODES), { maxLength: 6 });

describe("decision path properties", () => {
  // Property 4, path consistency (AGT-17): for any set of reason codes and the
  // decision they produce (deny beats hold beats allow), each known code marks
  // exactly one check; the rail is reached exactly when the decision is
  // `allow`; a deny has a denied check, a hold has a held check and no denied
  // one, and an allow has neither.
  it("AGT-17: the path agrees with the decision for any set of reason codes", () => {
    fc.assert(
      fc.property(codesArb, (codes) => {
        const decision = decisionOf(codes);
        const path = decisionPath({ decision, reasons: codes.map((code) => ({ code })) });
        const states = path.checks.map((c) => c.state);
        expect(path.checks.map((c) => c.check)).toEqual([...CHECKS]);
        expect(path.railReached).toBe(decision === "allow");
        if (decision === "deny") expect(states).toContain("denied");
        if (decision === "hold") {
          expect(states).toContain("held");
          expect(states).not.toContain("denied");
        }
        if (decision === "allow") expect(states.every((s) => s === "passed")).toBe(true);
        // Each code shows on the one check it belongs to, at least as strict as itself.
        const marked = states.filter((s) => s === "held" || s === "denied").length;
        expect(marked).toBeLessThanOrEqual(codes.length);
        if (codes.length > 0) expect(marked).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("AGT-17: an unknown code on a deny or hold never leaves every check passed", () => {
    fc.assert(
      fc.property(codesArb, fc.constantFrom("SOMETHING_NEW", "constructor", "__proto__"), fc.constantFrom("hold" as const, "deny" as const), (codes, unknown, base) => {
        const decision = decisionOf(codes) === "allow" ? base : decisionOf(codes);
        const path = decisionPath({ decision, reasons: [...codes, unknown].map((code) => ({ code })) });
        expect(path.checks.some((c) => c.state === "held" || c.state === "denied")).toBe(true);
        expect(path.railReached).toBe(false);
      }),
      RUNS,
    );
  });
});
