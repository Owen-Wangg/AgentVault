import { z } from "zod";
import { AmountOutOfRangeError, InvalidAmountError } from "./errors";

/**
 * An amount of money as an integer count of micros: 1 USD = 1,000,000 micros
 * (MON-1). The brand stops a plain `bigint` or a `number` from being passed
 * where an amount is expected (MON-4). Create values only with the functions
 * in this file.
 */
export type Micros = bigint & { readonly __brand: "Micros" };

/** $1 billion. Postgres bigint holds about 9.2 × 10^18, so sums have headroom. */
export const MAX_MICROS = 1_000_000_000_000_000n as Micros;

const MICROS_PER_UNIT = 1_000_000n;
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const INTEGER = /^(0|[1-9]\d*)$/;

/** Wrap a bigint as Micros. Throws if it isn't a bigint (MON-4) or is out of range (MON-5). */
export function micros(value: bigint): Micros {
  if (typeof value !== "bigint") throw new InvalidAmountError(value, "expected a bigint");
  if (value < 0n || value > MAX_MICROS) throw new AmountOutOfRangeError(value);
  return value as Micros;
}

/** Parse a decimal dollar string such as "0.0015" exactly (MON-2, MON-3). No `number` is involved. */
export function fromDecimalString(s: string): Micros {
  if (typeof s !== "string") throw new InvalidAmountError(s, "expected a string");
  const match = DECIMAL.exec(s);
  if (!match) throw new InvalidAmountError(s, "use digits with at most 6 decimal places, like 12.5 or 0.0015");
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  return micros(whole * MICROS_PER_UNIT + fraction);
}

/** Parse the wire format: a string of integer micros such as "1500". */
export function fromMicrosString(s: string): Micros {
  if (typeof s !== "string") throw new InvalidAmountError(s, "expected a string");
  if (!INTEGER.test(s)) throw new InvalidAmountError(s, "use a whole number of micros with no sign or leading zeros");
  return micros(BigInt(s));
}

/** The wire format: integer micros as a decimal string. */
export function toMicrosString(m: Micros): string {
  return m.toString();
}

function split(m: Micros): { whole: string; fraction: string } {
  return { whole: (m / MICROS_PER_UNIT).toString(), fraction: (m % MICROS_PER_UNIT).toString().padStart(6, "0") };
}

/** Shortest exact decimal dollar string: 1500n -> "0.0015", 1_000_000n -> "1". */
export function toDecimalString(m: Micros): string {
  const { whole, fraction } = split(m);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? whole : `${whole}.${trimmed}`;
}

/**
 * Dollar display with 2 to 6 decimals and no rounding (MON-6):
 * 1500n -> "$0.0015", 1_000_000n -> "$1.00", 480_000_000n -> "$480.00".
 * No thousands separators, so the text parses back to the same value.
 */
export function toDisplay(m: Micros): string {
  const { whole, fraction } = split(m);
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${trimmed}`;
}

/** Throws AMOUNT_OUT_OF_RANGE if the result exceeds MAX_MICROS (MON-5). */
export function add(a: Micros, b: Micros): Micros {
  return micros(micros(a) + micros(b));
}

/** Throws AMOUNT_OUT_OF_RANGE if the result is negative (MON-5). */
export function sub(a: Micros, b: Micros): Micros {
  return micros(micros(a) - micros(b));
}

/** Sum with the same range guard as `add`. The sum of no amounts is 0. */
export function sum(xs: readonly Micros[]): Micros {
  let total = micros(0n);
  for (const x of xs) total = add(total, x);
  return total;
}

export function cmp(a: Micros, b: Micros): -1 | 0 | 1 {
  const x = micros(a);
  const y = micros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Zod schema for amounts on the wire: a string of integer micros, parsed to Micros. */
export const MicrosSchema = z
  .string()
  .regex(INTEGER, "Amount must be a whole number of micros as a string, like \"1500\"")
  // Zod 4 runs this even when the regex fails, so only convert well-formed strings.
  .refine((s) => !INTEGER.test(s) || BigInt(s) <= MAX_MICROS, "Amount must not exceed MAX_MICROS")
  .transform((s) => fromMicrosString(s));
