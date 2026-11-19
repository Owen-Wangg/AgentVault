// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("zod in the browser", () => {
  it("security A8: client code never calls Function(), which the page CSP blocks", async () => {
    await import("./ThemeProvider");
    expect(z.config().jitless).toBe(true);
    // Parsing an object, which is what triggers zod's Function("") check, now runs without it.
    const original = globalThis.Function;
    let called = false;
    globalThis.Function = new Proxy(original, {
      apply: (target, self, args) => ((called = true), Reflect.apply(target, self, args)),
      construct: (target, args) => ((called = true), Reflect.construct(target, args)),
    });
    try {
      expect(z.object({ a: z.string(), b: z.number() }).parse({ a: "x", b: 1 })).toEqual({ a: "x", b: 1 });
    } finally {
      globalThis.Function = original;
    }
    expect(called).toBe(false);
  });
});
