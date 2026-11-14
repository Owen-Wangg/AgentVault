import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "./canonical";

const RUNS = { numRuns: 1000 };

/** JSON-safe values under the CJ rules: no floats, any strings (including lone surrogates). */
const { value: canonicalValue } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    fc.string({ unit: "binary" }),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(fc.string({ unit: "binary", maxLength: 6 }), tie("value"), { maxKeys: 5 }),
  ),
}));

/** Rebuild every object with its keys in reverse insertion order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)]),
    );
  }
  return v;
}

class Instance {
  x = 1;
}

/** Values that CJ-4 and CJ-5 reject wherever they appear. */
const rejected = fc.oneof(
  fc.double({ noInteger: true }),
  fc.constantFrom(NaN, Infinity, -Infinity, 2 ** 53),
  fc.constantFrom<unknown>(new Date(0), new Map(), new Set(), new Instance(), () => 1, Symbol("s")),
);

/** A JSON-safe value with one rejected value buried somewhere inside it. */
const { value: withRejected } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    rejected,
    fc
      .tuple(fc.array(canonicalValue, { maxLength: 3 }), tie("value"), fc.array(canonicalValue, { maxLength: 3 }))
      .map(([before, bad, after]) => [...before, bad, ...after]),
    fc
      .tuple(fc.dictionary(fc.string({ maxLength: 4 }), canonicalValue, { maxKeys: 3 }), fc.string({ maxLength: 4 }), tie("value"))
      .map(([obj, k, bad]) => ({ ...obj, [k]: bad })),
  ),
}));

describe("canonical JSON properties", () => {
  // Property 7, canonical encoding (CJ-1 to CJ-5): for any JSON-safe value,
  // canonicalJson is unchanged by reordering object keys, ...
  it("CJ-1: reordering object keys doesn't change the encoding", () => {
    fc.assert(
      fc.property(canonicalValue, (v) => {
        expect(canonicalJson(reverseKeys(v))).toBe(canonicalJson(v));
      }),
      RUNS,
    );
  });

  // ... JSON.parse(canonicalJson(v)) re-encodes to the same string, ...
  it("CJ-2: the encoding round-trips through JSON.parse", () => {
    fc.assert(
      fc.property(canonicalValue, (v) => {
        const encoded = canonicalJson(v);
        expect(canonicalJson(JSON.parse(encoded))).toBe(encoded);
      }),
      RUNS,
    );
  });

  // ... and values with floats, NaN, Date, or undefined array elements throw.
  it("CJ-4, CJ-5: a float, NaN, Date, or other non-JSON value anywhere throws", () => {
    fc.assert(
      fc.property(withRejected, (v) => {
        expect(() => canonicalJson(v)).toThrow(CanonicalJsonError);
      }),
      RUNS,
    );
  });

  it("CJ-5: an undefined array element anywhere throws", () => {
    fc.assert(
      fc.property(fc.array(canonicalValue, { maxLength: 4 }), fc.nat({ max: 4 }), canonicalValue, (items, at, wrapper) => {
        const arr: unknown[] = [...items];
        arr.splice(Math.min(at, arr.length), 0, undefined);
        expect(() => canonicalJson({ wrapper, arr })).toThrow(CanonicalJsonError);
      }),
      RUNS,
    );
  });

  it("CJ-2: the encoding has no whitespace outside strings and matches JSON.stringify on sorted input", () => {
    fc.assert(
      fc.property(canonicalValue, (v) => {
        const sortKeys = (x: unknown): unknown =>
          Array.isArray(x)
            ? x.map(sortKeys)
            : x !== null && typeof x === "object"
              ? Object.fromEntries(
                  Object.keys(x)
                    .sort()
                    .map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]),
                )
              : x;
        // Object.fromEntries keeps insertion order for string keys, except
        // integer-like keys, which JSON.stringify always lists first.
        const hasIntegerKey = (x: unknown): boolean =>
          Array.isArray(x)
            ? x.some(hasIntegerKey)
            : x !== null && typeof x === "object"
              ? Object.keys(x).some((k) => /^(0|[1-9]\d*)$/.test(k)) || Object.values(x).some(hasIntegerKey)
              : false;
        fc.pre(!hasIntegerKey(v));
        expect(canonicalJson(v)).toBe(JSON.stringify(sortKeys(v)));
      }),
      RUNS,
    );
  });
});
