import { describe, expect, it } from "vitest";
import { chargeableMicros, micros } from "@/core/money";
import { isHighPrivilege } from "@/core/taint";
import { findTool, policyTool } from "./registry";

describe("payout-rails tool registry", () => {
  it("PO-2, PO-3: payout.create and paypal.payout are payout credits on the Stripe and PayPal rails", () => {
    expect(findTool("payout.create")).toMatchObject({ rail: "stripe", direction: "credit", operation: "payout", privileged: true });
    expect(findTool("paypal.payout")).toMatchObject({ rail: "paypal", direction: "credit", operation: "payout", privileged: true });
  });

  it("PO-3: a payout counts the full requested amount, though the payee gets it rounded down", () => {
    for (const name of ["payout.create", "paypal.payout"]) {
      const tool = findTool(name)!;
      expect(chargeableMicros(micros(19_999n), tool.rail!, tool.direction)).toBe(19_999n);
    }
  });

  it("PO-14, PO-18: paypal.payout is high-privilege", () => {
    expect(isHighPrivilege(policyTool(findTool("paypal.payout")!))).toBe(true);
  });

  it("PO-10: payee.update moves no money: no registered rail, operation payee", () => {
    expect(findTool("payee.update")).toMatchObject({ rail: null, operation: "payee", privileged: true });
  });

  it("PO-2: refunds and payments keep their operations", () => {
    expect(["x402.pay", "mpp.pay", "stripe.refund", "wire_transfer"].map((n) => findTool(n)?.operation)).toEqual(["pay", "pay", "refund", "pay"]);
  });
});
