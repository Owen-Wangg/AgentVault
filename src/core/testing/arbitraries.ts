import fc from "fast-check";

/**
 * Upper bound for generated amounts, equal to MAX_MICROS ($1 billion) in
 * money-arithmetic.md. money-and-policy-core task 1 replaces this with the
 * real `MAX_MICROS` from `@/core/money` and returns branded `Micros`.
 */
export const MAX_MICROS_FOR_TESTS = 1_000_000_000_000_000n;

/** Edge values from testing-standards.md: zero, one micro, either side of one cent, and the maximum. */
export const MICROS_EDGE_VALUES: readonly bigint[] = [0n, 1n, 9_999n, 10_000n, MAX_MICROS_FOR_TESTS];

/** Any valid amount in micros, uniformly distributed. */
export const anyMicros = (): fc.Arbitrary<bigint> => fc.bigInt({ min: 0n, max: MAX_MICROS_FOR_TESTS });

/** Valid amounts with the edge values mixed in, so boundaries get hit in every run. */
export const microsWithEdges = (): fc.Arbitrary<bigint> =>
  fc.oneof({ arbitrary: anyMicros(), weight: 4 }, { arbitrary: fc.constantFrom(...MICROS_EDGE_VALUES), weight: 1 });
