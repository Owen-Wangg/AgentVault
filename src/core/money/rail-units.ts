import { InvalidAmountError } from "./errors";
import { type Micros, micros } from "./micros";

export type Rail = "stripe" | "x402" | "mock" | "paypal";

/**
 * `debit`: money the agent spends. `credit`: money the platform sends out,
 * a refund the agent issues or a payout to a payee (payout-rails PO-3).
 */
export type Direction = "debit" | "credit";

const RAILS: readonly Rail[] = ["stripe", "x402", "mock", "paypal"];
/** Rails whose smallest unit is the USD cent. PayPal amounts are cents, like Stripe's. */
const CENT_RAILS: readonly Rail[] = ["stripe", "paypal"];
const MICROS_PER_CENT = 10_000n;

function assertRail(rail: Rail): void {
  if (!RAILS.includes(rail)) throw new InvalidAmountError(rail, "unknown rail");
}

/**
 * Convert to the rail's smallest unit. Rounding never favors the agent:
 * cent-rail (Stripe, PayPal) debits round up to the next cent (MON-7) and
 * credits round down (MON-8, PO-3), so a refund or payout never sends more
 * than was approved. x402 USDC atomic units and mock units are micros, 1:1
 * (MON-9). Call this only inside src/rails; the server uses
 * `chargeableMicros`.
 */
export function toRailUnits(m: Micros, rail: Rail, dir: Direction): bigint {
  const amount = micros(m);
  assertRail(rail);
  if (!CENT_RAILS.includes(rail)) return amount;
  const cents = amount / MICROS_PER_CENT;
  const remainder = amount % MICROS_PER_CENT;
  if (dir === "debit") return remainder === 0n ? cents : cents + 1n;
  if (dir === "credit") return cents;
  throw new InvalidAmountError(dir, "direction must be debit or credit");
}

/** Convert rail units back to micros. Exact for every rail. */
export function fromRailUnits(units: bigint, rail: Rail): Micros {
  if (typeof units !== "bigint") throw new InvalidAmountError(units, "expected bigint rail units");
  assertRail(rail);
  return micros(CENT_RAILS.includes(rail) ? units * MICROS_PER_CENT : units);
}

/**
 * The amount counted against the envelope. A debit counts as what the rail
 * actually charges after rounding up (MON-10). A credit counts as the full
 * requested amount, not the rounded-down rail amount, so refunds and
 * payouts use up caps just like payments (MON-11, PO-3). Never less than `m`.
 */
export function chargeableMicros(m: Micros, rail: Rail, dir: Direction): Micros {
  const amount = micros(m);
  if (dir === "credit") {
    assertRail(rail);
    return amount;
  }
  return fromRailUnits(toRailUnits(amount, rail, dir), rail);
}
