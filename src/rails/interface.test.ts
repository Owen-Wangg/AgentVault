import { describe, expect, expectTypeOf, it } from "vitest";
import { MockRail } from "./mock";
import { StripeMppRail } from "./stripe-mpp/adapter";
import type { RailAdapter } from "./types";
import { X402Rail } from "./x402/adapter";

const ADAPTERS = { MockRail, StripeMppRail, X402Rail } as const;
const METHODS = ["quote", "execute", "refund", "lookup"] as const;

describe("rail adapter interface", () => {
  it("RAIL-1: every adapter class has the RailAdapter type", () => {
    expectTypeOf<InstanceType<typeof MockRail>>().toExtend<RailAdapter>();
    expectTypeOf<InstanceType<typeof StripeMppRail>>().toExtend<RailAdapter>();
    expectTypeOf<InstanceType<typeof X402Rail>>().toExtend<RailAdapter>();
  });

  it.each(Object.entries(ADAPTERS))("RAIL-1: %s exposes quote, execute, refund, and lookup", (_name, adapter) => {
    for (const method of METHODS) expect(typeof adapter.prototype[method]).toBe("function");
  });
});
