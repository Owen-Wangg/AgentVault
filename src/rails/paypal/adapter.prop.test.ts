import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PAYPAL_FAILURE_STATUSES, itemOutcome, paypalAmount, parsePayPalAmount } from "./adapter";

const KNOWN = ["SUCCESS", ...PAYPAL_FAILURE_STATUSES, "PENDING", "UNCLAIMED", "ONHOLD", "NEW", "success", "Failed", ""];

describe("PayPal status mapping and amounts", () => {
  // Property 5: Status mapping is conservative (PO-16): for any PayPal item status, only SUCCESS maps to
  // settled, only the five listed failure statuses map to a confirmed failure, and every other string maps to unknown.
  it("PO-16: property 5, the status mapping is conservative", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...KNOWN), fc.string()), (status) => {
        const expected = status === "SUCCESS" ? "settled" : (PAYPAL_FAILURE_STATUSES as readonly string[]).includes(status) ? "failed" : "unknown";
        expect(itemOutcome(status)).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  });

  it("PO-15: the decimal amount string round-trips through integer cents", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000_000_000_000n }), (cents) => {
        const value = paypalAmount(cents);
        expect(value).toMatch(/^\d+\.\d{2}$/);
        expect(parsePayPalAmount(value)).toBe(cents);
      }),
      { numRuns: 1000 },
    );
  });

  it("PO-15: amounts that aren't exactly two decimals are refused", () => {
    for (const bad of ["1", "1.0", "1.000", "-1.00", "1e2", " 1.00", "1.00 ", "", "0x10.00"]) expect(parsePayPalAmount(bad)).toBeNull();
  });
});
