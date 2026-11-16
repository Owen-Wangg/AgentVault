import type { Rail } from "@/core/money";

/**
 * Payout destination formats per rail (payout-rails PO-10, design
 * "Vendor registry"). The tool route checks an agent's `payee_ref` with
 * these, and the mock rail uses them as its destination check, so the
 * sandbox accepts exactly what the real rails would be asked to verify.
 */
const STRIPE_ACCOUNT = /^acct_[A-Za-z0-9]{1,64}$/;
/** A basic address check, at most 254 characters. PayPal itself decides whether it can receive. */
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Rails that can pay out, and the destination format each takes. x402 and the mock rail can't. */
export const PAYOUT_RAILS = ["stripe", "paypal"] as const;
export type PayoutRail = (typeof PAYOUT_RAILS)[number];

export function isPayoutRail(rail: Rail | null): rail is PayoutRail {
  return rail === "stripe" || rail === "paypal";
}

/** True if `destination` is a well-formed payout destination on `rail`. */
export function isDestinationFor(rail: Rail, destination: string): boolean {
  if (rail === "stripe") return STRIPE_ACCOUNT.test(destination);
  if (rail === "paypal") return destination.length <= 254 && EMAIL.test(destination);
  return false;
}
