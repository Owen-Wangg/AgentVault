import { type Micros, toRailUnits } from "@/core/money";

/** Stripe's minimum for SPT card payments, in cents (RAIL-4). The mock rail uses the same value. */
export const STRIPE_SPT_MINIMUM_CENTS = 50n;

/**
 * The amount string mppx's Stripe charge takes with `decimals: 2`, built
 * from micros: 500_000n (50 cents) becomes "0.50". Debits round up to the
 * cent (MON-8), so the vendor never asks for less than its price.
 */
export function stripeChargeAmount(price: Micros): string {
  const cents = toRailUnits(price, "stripe", "debit");
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** The same price in cents, as a string: 500_000n becomes "50". MPP challenges and discovery documents use this form. */
export function stripeChargeCents(price: Micros): string {
  return toRailUnits(price, "stripe", "debit").toString();
}

/**
 * The GA API version for Stripe Connect, which serves both Accounts v2
 * and v1 Transfers (measured by `pnpm connect:probe`, payout-rails task 2).
 */
export const CONNECT_API_VERSION = "2026-10-28.endive";

/** Stripe's minimum transfer, in cents, measured by `pnpm connect:probe` (PO-22). */
export const STRIPE_TRANSFER_MINIMUM_CENTS = 1n;

/** The Dashboard page for a test-mode PaymentIntent, Refund, or Transfer. */
export function stripeDashboardUrl(ref: string): string {
  if (ref.startsWith("re_")) return `https://dashboard.stripe.com/test/refunds/${ref}`;
  if (ref.startsWith("tr_")) return `https://dashboard.stripe.com/test/connect/transfers/${ref}`;
  return `https://dashboard.stripe.com/test/payments/${ref}`;
}
