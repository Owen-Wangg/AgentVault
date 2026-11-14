import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateInputArb, taskScopeArb } from "@/core/testing/arbitraries";
import { UNKNOWN_CATEGORY, intentRules } from "./rules";

const RUNS = { numRuns: 1000 };

/** Task scopes that sometimes list the unknown category, to check it still never passes. */
const anyScope = fc.tuple(taskScopeArb(), fc.boolean()).map(([scope, listsUnknown]) =>
  listsUnknown ? { ...scope, allowedVendorCategories: [...scope.allowedVendorCategories, UNKNOWN_CATEGORY] } : scope,
);

describe("intent properties", () => {
  // Property 4, unknown vendors never pass scope (INT-6): for any task
  // scope, a vendor category of `unknown` yields `DENY_INTENT_DRIFT`.
  it("INT-6: for any task scope, the unknown category yields DENY_INTENT_DRIFT", () => {
    fc.assert(
      fc.property(evaluateInputArb(), anyScope, (input, scope) => {
        const reasons = intentRules(input, scope, UNKNOWN_CATEGORY);
        expect(reasons).toContainEqual(expect.objectContaining({ code: "DENY_INTENT_DRIFT", detail: expect.objectContaining({ check: "vendor_category" }) }));
      }),
      RUNS,
    );
  });

  // INT-2: a category passes exactly when the task lists it (and it isn't unknown).
  it("INT-2: the category check passes exactly for listed categories", () => {
    fc.assert(
      fc.property(evaluateInputArb(), anyScope, fc.constantFrom("weather", "compute", "payments", UNKNOWN_CATEGORY), (input, scope, category) => {
        const drift = intentRules(input, scope, category).some((r) => r.detail?.check === "vendor_category");
        expect(drift).toBe(category === UNKNOWN_CATEGORY || !scope.allowedVendorCategories.includes(category));
      }),
      RUNS,
    );
  });
});
