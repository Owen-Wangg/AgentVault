import { describe, expect, it } from "vitest";
import { isDestinationFor, isPayoutRail } from "./destination";

describe("PO-10: payout destination formats", () => {
  it.each(["acct_1AcmeSupplies", "acct_1UcYiv3i6f4dGjiE", `acct_${"a".repeat(64)}`])("PO-10: %s is a Stripe destination", (ref) => {
    expect(isDestinationFor("stripe", ref)).toBe(true);
  });

  it.each(["acct_", "acct_1-2", "acct_1 2", "ACCT_1", "pi_123", "supplier@personal.example.com", `acct_${"a".repeat(65)}`])(
    "PO-10: %s is not a Stripe destination",
    (ref) => {
      expect(isDestinationFor("stripe", ref)).toBe(false);
    },
  );

  it.each(["supplier@personal.example.com", "sb-abc.def+1@business.example.com"])("PO-10: %s is a PayPal destination", (ref) => {
    expect(isDestinationFor("paypal", ref)).toBe(true);
  });

  it.each(["acct_1AcmeSupplies", "no-at-sign", "a@b", "a@@b.com", "a b@c.com", `${"a".repeat(65)}@b.com`, `a@${"b".repeat(250)}.com`])(
    "PO-10: %s is not a PayPal destination",
    (ref) => {
      expect(isDestinationFor("paypal", ref)).toBe(false);
    },
  );

  it("PO-1: only Stripe and PayPal can pay out", () => {
    expect(["stripe", "paypal", "x402", "mock", null].map((r) => isPayoutRail(r as never))).toEqual([true, true, false, false, false]);
    expect(isDestinationFor("x402", "acct_1AcmeSupplies")).toBe(false);
    expect(isDestinationFor("mock", "acct_1AcmeSupplies")).toBe(false);
  });
});
