import { describe, expect, it } from "vitest";
import { AmountOutOfRangeError, InvalidAmountError } from "./errors";
import {
  MAX_MICROS,
  MicrosSchema,
  add,
  cmp,
  fromDecimalString,
  fromMicrosString,
  micros,
  sub,
  sum,
  toDecimalString,
  toDisplay,
  toMicrosString,
} from "./micros";

const m = micros;

describe("MON-1: amounts are non-negative bigint micros", () => {
  it("MON-1: 1 USD is 1,000,000 micros", () => {
    expect(fromDecimalString("1")).toBe(1_000_000n);
  });

  it("MON-1: MAX_MICROS is $1 billion", () => {
    expect(MAX_MICROS).toBe(1_000_000_000_000_000n);
  });
});

describe("MON-2: exact parsing of decimal strings", () => {
  it.each([
    ["0", 0n],
    ["0.000001", 1n],
    ["0.0015", 1_500n],
    ["0.01", 10_000n],
    ["1.5", 1_500_000n],
    ["480", 480_000_000n],
    ["480.00", 480_000_000n],
    ["999999999.999999", 999_999_999_999_999n],
    ["1000000000", 1_000_000_000_000_000n],
  ])("MON-2: parses %s exactly", (input, expected) => {
    expect(fromDecimalString(input)).toBe(expected);
  });
});

describe("MON-3: malformed strings are rejected with INVALID_AMOUNT", () => {
  it.each(["1.", ".5", "1e3", "-1", "0.0000001", "", " 1", "1 ", "01", "+1", "1,000", "1.2.3", "Infinity", "NaN", "0x10", "١"])(
    "MON-3: rejects %j",
    (input) => {
      expect(() => fromDecimalString(input)).toThrow(InvalidAmountError);
      try {
        fromDecimalString(input);
      } catch (e) {
        expect((e as InvalidAmountError).code).toBe("INVALID_AMOUNT");
      }
    },
  );

  it("MON-3: rejects malformed micros strings", () => {
    for (const input of ["", "-1", "1.5", "01", "1e3", " 1"]) expect(() => fromMicrosString(input)).toThrow(InvalidAmountError);
  });

  it("MON-5: a well-formed string above MAX_MICROS is out of range", () => {
    expect(() => fromDecimalString("1000000000.000001")).toThrow(AmountOutOfRangeError);
    expect(() => fromMicrosString("1000000000000001")).toThrow(AmountOutOfRangeError);
  });
});

describe("MON-4: numbers are rejected", () => {
  it("MON-4: rejects a number at compile time", () => {
    // @ts-expect-error: a number is not Micros
    expect(() => add(1, m(1n))).toThrow(InvalidAmountError);
    // @ts-expect-error: a plain bigint is not Micros either
    const plain: Parameters<typeof add>[0] = 5n;
    expect(plain).toBe(5n);
  });

  it("MON-4: rejects numbers at runtime with INVALID_AMOUNT", () => {
    const asAny = (v: unknown) => v as never;
    expect(() => micros(asAny(1.5))).toThrow(InvalidAmountError);
    expect(() => fromDecimalString(asAny(0.5))).toThrow(InvalidAmountError);
    expect(() => fromMicrosString(asAny(1500))).toThrow(InvalidAmountError);
    expect(() => sub(m(5n), asAny(1))).toThrow(InvalidAmountError);
    expect(() => cmp(asAny(1), m(1n))).toThrow(InvalidAmountError);
  });
});

describe("MON-5: arithmetic never leaves the valid range", () => {
  it("MON-5: add throws AMOUNT_OUT_OF_RANGE above MAX_MICROS", () => {
    expect(() => add(MAX_MICROS, m(1n))).toThrow(AmountOutOfRangeError);
    expect(add(m(MAX_MICROS - 1n), m(1n))).toBe(MAX_MICROS);
  });

  it("MON-5: sub throws AMOUNT_OUT_OF_RANGE below zero", () => {
    expect(() => sub(m(1n), m(2n))).toThrow(AmountOutOfRangeError);
    expect(sub(m(2n), m(2n))).toBe(0n);
  });

  it("MON-5: micros() rejects negative values and values above the maximum", () => {
    expect(() => micros(-1n)).toThrow(AmountOutOfRangeError);
    expect(() => micros(MAX_MICROS + 1n)).toThrow(AmountOutOfRangeError);
  });

  it("MON-5: sum applies the same guard and sums nothing to 0", () => {
    expect(sum([])).toBe(0n);
    expect(sum([m(1n), m(2n), m(3n)])).toBe(6n);
    expect(() => sum([MAX_MICROS, m(1n)])).toThrow(AmountOutOfRangeError);
  });

  it("orders amounts with cmp", () => {
    expect(cmp(m(1n), m(2n))).toBe(-1);
    expect(cmp(m(2n), m(2n))).toBe(0);
    expect(cmp(m(3n), m(2n))).toBe(1);
  });
});

describe("MON-6: display shows 2 to 6 decimals with no rounding", () => {
  it.each([
    [0n, "$0.00"],
    [1n, "$0.000001"],
    [1_500n, "$0.0015"],
    [10_000n, "$0.01"],
    [123_456n, "$0.123456"],
    [1_000_000n, "$1.00"],
    [1_500_000n, "$1.50"],
    [480_000_000n, "$480.00"],
    [1_000_000_000_000_000n, "$1000000000.00"],
  ])("MON-6: %s micros displays as %s", (value, text) => {
    expect(toDisplay(m(value))).toBe(text);
  });

  it.each([
    [0n, "0"],
    [1_500n, "0.0015"],
    [1_000_000n, "1"],
    [1_500_000n, "1.5"],
  ])("formats %s micros as the decimal string %s", (value, text) => {
    expect(toDecimalString(m(value))).toBe(text);
  });
});

describe("wire format", () => {
  it("round-trips through the micros string", () => {
    expect(toMicrosString(m(1_500n))).toBe("1500");
    expect(fromMicrosString("1500")).toBe(1_500n);
  });

  it("MicrosSchema parses valid strings and rejects the rest with a ZodError", () => {
    expect(MicrosSchema.parse("1500")).toBe(1_500n);
    for (const bad of ["1.5", "-1", "1000000000000001", 1500]) expect(MicrosSchema.safeParse(bad).success).toBe(false);
  });
});
