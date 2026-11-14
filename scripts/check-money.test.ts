import { describe, expect, it } from "vitest";
import { scanSource } from "./check-money";

const rulesFor = (code: string) => scanSource(code, "x.ts").map((f) => f.rule);

describe("check-money", () => {
  it.each([
    ["const a = parseFloat(req.body.amount);", "parseFloat"],
    ["const a = Number.parseFloat(s);", "parseFloat"],
    ["label = total.toFixed(2);", "toFixed"],
    ["const m = Number(row.amount_micros);", "Number() on an amount"],
    ["const c = Math.round(cents * 100);", "Math rounding on an amount"],
    ["const x = +body.amountMicros;", "unary + on an amount"],
    ["const amountMicros: number = 5;", "number-typed money field"],
    ["interface R { budget_micros?: number }", "number-typed money field"],
    ["type P = { amount: number };", "number-typed money field"],
  ])("flags %s", (code, rule) => {
    expect(rulesFor(code)).toContain(rule);
  });

  it.each([
    "const n = Number(row.calls_per_minute);",
    "const idx = Math.floor(items.length / 2);",
    "callsPerMinute: number;",
    "const amountMicros: Micros = micros(1500n);",
    "// parseFloat would be wrong here",
    'const msg = "never call parseFloat on an amount";',
    "/* amount.toFixed(2) is banned */",
    "const total = a + b;",
  ])("allows %s", (code) => {
    expect(rulesFor(code)).toEqual([]);
  });

  it("skips code inside multi-line block comments", () => {
    expect(rulesFor("/**\n * parseFloat(amount) is banned\n */\nconst ok = 1;")).toEqual([]);
  });

  it("honours an opt-out comment only when it gives a reason", () => {
    expect(rulesFor("const f = parseFloat(x); // money-check: ok broken fixture for the demo")).toEqual([]);
    expect(rulesFor("const f = parseFloat(x); // money-check: ok")).toContain("parseFloat");
  });

  it("reports the line number", () => {
    expect(scanSource("const a = 1;\nconst b = parseFloat(s);", "y.ts")[0]?.line).toBe(2);
  });
});
