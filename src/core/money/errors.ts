/** Shorten untrusted input before putting it in an error message. */
function describe(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : typeof value === "bigint" ? `${value}n` : String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** The input isn't a valid amount: wrong type or malformed string (MON-3, MON-4). */
export class InvalidAmountError extends Error {
  readonly code = "INVALID_AMOUNT";

  constructor(value: unknown, reason: string) {
    super(`Invalid amount ${describe(value)}: ${reason}`);
    this.name = "InvalidAmountError";
  }
}

/** The amount or arithmetic result is negative or above MAX_MICROS (MON-5). */
export class AmountOutOfRangeError extends Error {
  readonly code = "AMOUNT_OUT_OF_RANGE";

  constructor(value: bigint) {
    super(`Amount out of range: ${describe(value)} micros must be between 0 and 10^15`);
    this.name = "AmountOutOfRangeError";
  }
}
