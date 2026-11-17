import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, RailConfigError } from "./config";
import { MockRail } from "./mock";
import { railOptionsFor } from "./real";
import { railFor } from "./select";

/**
 * The variables the every-mode checks read, and the real-rail variables a
 * sandbox must not need. Values mix valid, placeholder, malformed, and
 * dangerous ones.
 */
const value = (...options: string[]) => fc.option(fc.constantFrom(...options), { nil: undefined });
const envArb = fc.record(
  {
    RAIL_MODE: value("mock", "real", "Real", "bogus", ""),
    STRIPE_SECRET_KEY: value("sk_test_51abc", "sk_live_51abc", "rk_live_51abc", "sk_test_replace_me", "garbage", ""),
    STRIPE_PROFILE_ID: value("profile_test_61abc", "profile_live_61abc", "", "x"),
    CDP_API_KEY_ID: value("id", "", "replace-me"),
    CDP_API_KEY_SECRET: value("secret", ""),
    X402_PAY_TO: value(`0x${"ab".repeat(20)}`, `0x${"0".repeat(40)}`, "not-an-address", ""),
    X402_NETWORK: value(BASE_SEPOLIA, "eip155:8453", "eip155:1", ""),
    X402_MIN_UNITS: value("1000", "0", "-5", "1.5", ""),
    AGENT_WALLET_PRIVATE_KEY: value(`0x${"11".repeat(32)}`, "0x12", "replace-me", ""),
    PAYPAL_ENV: value("sandbox", "live", "production", ""),
    PAYPAL_CLIENT_ID: value("client", ""),
  },
  { requiredKeys: [] },
);

/**
 * What the every-mode checks refuse, written out on its own so the
 * property doesn't just restate the implementation. An empty value counts
 * as unset, as in checkRailEnv.
 */
function failsEveryModeCheck(env: Record<string, string | undefined>): boolean {
  const set = (name: string) => (env[name] ? env[name] : undefined);
  const stripe = set("STRIPE_SECRET_KEY");
  if (stripe && /^(sk|rk)_live_/.test(stripe)) return true;
  const network = set("X402_NETWORK");
  if (network && network !== BASE_SEPOLIA) return true;
  const minUnits = set("X402_MIN_UNITS");
  if (minUnits && !/^[1-9]\d{0,17}$/.test(minUnits)) return true;
  const paypal = set("PAYPAL_ENV");
  if (paypal && paypal !== "sandbox") return true;
  return false;
}

describe("railOptionsFor", () => {
  // testnet-demo property 3, Sandbox stays mock (TN-8): for any environment whose every-mode safety
  // checks pass, railOptionsFor({ isSandbox: true }) builds no real adapter and never throws, whatever
  // the real-rail variables hold; for any environment that fails them, it throws.
  it("TN-8: property 3, a sandbox builds no real adapter and needs no real-rail variable, but the safety checks still run", () => {
    fc.assert(
      fc.property(envArb, (env) => {
        if (failsEveryModeCheck(env)) {
          expect(() => railOptionsFor({ isSandbox: true }, env)).toThrow(RailConfigError);
          return;
        }
        const options = railOptionsFor({ isSandbox: true }, env);
        expect(options.real).toBeUndefined();
        expect(options.config.mode).toBe("mock");
        for (const rail of ["x402", "stripe", "paypal", "mock"] as const) expect(railFor(rail, { isSandbox: true }, options)).toBeInstanceOf(MockRail);
      }),
      { numRuns: 1_000 },
    );
  });

  it("TN-8: in real mode with no real-rail variables, a sandbox request still works and anything else fails closed", () => {
    const env = { RAIL_MODE: "real" };
    expect(railFor("x402", { isSandbox: true }, railOptionsFor({ isSandbox: true }, env))).toBeInstanceOf(MockRail);
    expect(() => railOptionsFor({ isSandbox: false }, env)).toThrow(RailConfigError);
  });

  it("TN-8: a live Stripe key stops sandbox requests too", () => {
    expect(() => railOptionsFor({ isSandbox: true }, { RAIL_MODE: "mock", STRIPE_SECRET_KEY: "sk_live_51abc" })).toThrow(RailConfigError);
  });
});
