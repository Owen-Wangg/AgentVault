import { describe, expect, it } from "vitest";
import { MockRail } from "./mock";
import { railOptions } from "./real";
import { RailUnavailableError, railFor } from "./select";
import { StripeMppRail } from "./stripe-mpp/adapter";
import { X402Rail } from "./x402/adapter";

const realEnv = {
  RAIL_MODE: "real",
  STRIPE_SECRET_KEY: "sk_test_51abcDEF",
  STRIPE_PROFILE_ID: "profile_test_61abcDEF",
  CDP_API_KEY_ID: "id",
  CDP_API_KEY_SECRET: "secret",
  X402_PAY_TO: "0x" + "ab".repeat(20),
  AGENT_WALLET_PRIVATE_KEY: "0x" + "11".repeat(32),
};

describe("railOptions", () => {
  it("RAIL-2: mock mode has no real adapters", () => {
    expect(railOptions({ RAIL_MODE: "mock" }).real).toBeUndefined();
  });

  it("RAIL-11: real mode routes x402 outside the sandbox to the x402 adapter, with the configured minimum", () => {
    const options = railOptions({ ...realEnv, X402_MIN_UNITS: "1000" });
    const adapter = railFor("x402", { isSandbox: false }, options);
    expect(adapter).toBeInstanceOf(X402Rail);
    expect(adapter.minimumUnits).toBe(1000n);
  });

  it("RAIL-2: the sandbox gets the mock adapter even in real mode", () => {
    expect(railFor("x402", { isSandbox: true }, railOptions(realEnv))).toBeInstanceOf(MockRail);
  });

  it("RAIL-15: real mode routes Stripe outside the sandbox to the Stripe MPP adapter, with the 50-cent minimum", () => {
    const adapter = railFor("stripe", { isSandbox: false }, railOptions(realEnv));
    expect(adapter).toBeInstanceOf(StripeMppRail);
    expect(adapter.minimumUnits).toBe(50n);
    expect(railFor("stripe", { isSandbox: true }, railOptions(realEnv))).toBeInstanceOf(MockRail);
  });

  it("an adapter that isn't configured still fails closed", () => {
    expect(() => railFor("stripe", { isSandbox: false }, { config: railOptions(realEnv).config, real: {} })).toThrow(RailUnavailableError);
  });
});
