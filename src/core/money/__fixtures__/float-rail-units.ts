/**
 * A deliberately broken Stripe conversion that uses floats and rounds to the
 * nearest cent, the way a quick implementation often would. It exists only so
 * the rail-unit property tests can show they catch it (money-and-policy-core
 * task 2). Never import it outside tests. check-money skips __fixtures__.
 */
export function floatToStripeCents(amountMicros: bigint): bigint {
  const dollars = Number(amountMicros) / 1_000_000;
  return BigInt(Math.round(dollars * 100));
}
