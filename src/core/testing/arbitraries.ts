import fc from "fast-check";
import { MAX_MICROS, type Micros, micros } from "@/core/money";

/** Edge values from testing-standards.md: zero, one micro, either side of one cent, and the maximum. */
export const MICROS_EDGE_VALUES: readonly Micros[] = [0n, 1n, 9_999n, 10_000n, MAX_MICROS].map(micros);

/** Any amount from 0 to `max` (default MAX_MICROS), uniformly distributed. */
export const anyMicros = (max: Micros = MAX_MICROS): fc.Arbitrary<Micros> =>
  fc.bigInt({ min: 0n, max }).map(micros);

/** Amounts with the edge values (up to `max`) mixed in, so boundaries get hit in every run. */
export const microsWithEdges = (max: Micros = MAX_MICROS): fc.Arbitrary<Micros> => {
  const edges = MICROS_EDGE_VALUES.filter((e) => e <= max);
  return fc.oneof({ arbitrary: anyMicros(max), weight: 4 }, { arbitrary: fc.constantFrom(...edges), weight: 1 });
};
