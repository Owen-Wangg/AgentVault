import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "./canonical";

describe("CJ-1: key order", () => {
  it("CJ-1: sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}');
  });

  it("CJ-1: sorts by UTF-16 code units, not code points", () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFFF in UTF-16.
    expect(canonicalJson({ "\uffff": 1, "\u{1F600}": 2 })).toBe('{"\u{1F600}":2,"\uffff":1}');
    expect(canonicalJson({ a: 1, B: 2, "": 3 })).toBe('{"":3,"B":2,"a":1}');
  });

  it("CJ-1: encodes an own __proto__ key like any other key", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":1,"a":2}'))).toBe('{"__proto__":1,"a":2}');
  });

  it("CJ-1: accepts objects with a null prototype", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 2;
    o.a = 1;
    expect(canonicalJson(o)).toBe('{"a":1,"b":2}');
  });
});

describe("CJ-2: whitespace and strings", () => {
  it("CJ-2: emits no whitespace", () => {
    expect(canonicalJson({ a: [1, { b: "x y" }] })).toBe('{"a":[1,{"b":"x y"}]}');
  });

  it("CJ-2: escapes strings exactly as JSON.stringify does", () => {
    const s = 'q"\\\n\t\u0001\u2028\ud800é';
    expect(canonicalJson(s)).toBe(JSON.stringify(s));
  });

  it("CJ-2: does not normalize Unicode", () => {
    expect(canonicalJson("\u00e9")).not.toBe(canonicalJson("e\u0301"));
  });
});

describe("CJ-3: bigint", () => {
  it("CJ-3: encodes a bigint as a string of its digits", () => {
    expect(canonicalJson({ amount_micros: 1500n, big: 10n ** 20n })).toBe('{"amount_micros":"1500","big":"100000000000000000000"}');
  });
});

describe("CJ-4: numbers", () => {
  it("CJ-4: accepts safe integers and encodes -0 as 0", () => {
    expect(canonicalJson([0, -0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])).toBe(
      "[0,0,1,-1,9007199254740991,-9007199254740991]",
    );
  });

  it.each([1.5, 0.1, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 1e21])("CJ-4: rejects %s", (n) => {
    expect(() => canonicalJson({ amount: n })).toThrow(CanonicalJsonError);
  });

  it("CJ-4: reports where the bad number is", () => {
    expect(() => canonicalJson({ payload: { items: [1, 2.5] } })).toThrow("$.payload.items[1]");
  });
});

describe("CJ-5: undefined and non-JSON values", () => {
  it("CJ-5: omits undefined object properties", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("CJ-5: rejects undefined and holes in arrays", () => {
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, , 3])).toThrow(CanonicalJsonError);
  });

  class Thing {
    a = 1;
  }

  it.each<[string, unknown]>([
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a class instance", new Thing()],
    ["a typed array", new Uint8Array(1)],
    ["a boxed string", Object("s")],
    ["an object with a symbol key", { [Symbol("k")]: 1 }],
    ["an object with a toJSON method", { toJSON: () => "x" }],
  ])("CJ-5: rejects %s", (_name, value) => {
    expect(() => canonicalJson({ v: value })).toThrow(CanonicalJsonError);
  });

  it("CJ-5: rejects undefined as the whole value", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
  });

  it("CJ-5: rejects cycles instead of overflowing the stack", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow("cycle");
  });

  it("CJ-5: allows the same object twice when it isn't a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
});
