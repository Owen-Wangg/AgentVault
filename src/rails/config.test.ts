import { describe, expect, it } from "vitest";
import { RailConfigError, checkRailEnv, loadRailConfig } from "./config";

const realEnv = {
  RAIL_MODE: "real",
  STRIPE_SECRET_KEY: "sk_test_51abcDEF",
  STRIPE_PROFILE_ID: "profile_123",
  CDP_API_KEY_ID: "id",
  CDP_API_KEY_SECRET: "secret",
  X402_PAY_TO: "0x" + "ab".repeat(20),
  X402_NETWORK: "eip155:84532",
  X402_MIN_UNITS: "1",
  AGENT_WALLET_PRIVATE_KEY: "0x" + "cd".repeat(32),
};

/** The placeholders from .env.example. */
const exampleEnv = {
  RAIL_MODE: "mock",
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_PROFILE_ID: "profile_replace_me",
  CDP_API_KEY_ID: "replace-me",
  CDP_API_KEY_SECRET: "replace-me",
  X402_PAY_TO: "0x0000000000000000000000000000000000000000",
  X402_NETWORK: "eip155:84532",
  X402_MIN_UNITS: "1",
  AGENT_WALLET_PRIVATE_KEY: "0xreplace_with_testnet_only_key",
};

describe("RAIL-7: Stripe test mode only", () => {
  it.each(["sk_live_51abc", "rk_live_51abc"])("RAIL-7: refuses %s in every mode", (key) => {
    expect(() => loadRailConfig({ STRIPE_SECRET_KEY: key })).toThrow(RailConfigError);
    expect(() => loadRailConfig({ ...realEnv, STRIPE_SECRET_KEY: key })).toThrow("live key");
  });

  it("RAIL-7: real mode needs a key starting with sk_test_", () => {
    expect(() => loadRailConfig({ ...realEnv, STRIPE_SECRET_KEY: "pk_test_abc" })).toThrow("sk_test_");
  });
});

describe("RAIL-8: Base Sepolia only", () => {
  it.each(["eip155:8453", "eip155:1", "base"])("RAIL-8: refuses network %j in every mode", (network) => {
    expect(() => loadRailConfig({ X402_NETWORK: network })).toThrow("Base Sepolia");
    expect(() => loadRailConfig({ ...realEnv, X402_NETWORK: network })).toThrow("Base Sepolia");
  });

  it("RAIL-8: an unset network defaults to Base Sepolia", () => {
    expect(loadRailConfig({}).x402Network).toBe("eip155:84532");
    expect(loadRailConfig({ X402_NETWORK: "" }).x402Network).toBe("eip155:84532");
  });
});

describe("rail configuration", () => {
  it("defaults to mock mode with a minimum of 1 unit", () => {
    expect(loadRailConfig({})).toEqual({ mode: "mock", x402Network: "eip155:84532", x402MinUnits: 1n });
  });

  it("accepts the .env.example placeholders in mock mode", () => {
    expect(loadRailConfig(exampleEnv).mode).toBe("mock");
  });

  it("accepts a complete real configuration", () => {
    expect(loadRailConfig(realEnv)).toEqual({ mode: "real", x402Network: "eip155:84532", x402MinUnits: 1n });
  });

  it("real mode reports every missing, placeholder, or malformed credential", () => {
    const failed = checkRailEnv({ ...exampleEnv, RAIL_MODE: "real", CDP_API_KEY_ID: "" })
      .filter((c) => c.status === "fail")
      .map((c) => c.name);
    expect(failed).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_PROFILE_ID",
      "CDP_API_KEY_ID",
      "CDP_API_KEY_SECRET",
      "X402_PAY_TO",
      "AGENT_WALLET_PRIVATE_KEY",
    ]);
  });

  it("in mock mode, says which variables were only safety-checked or not checked", () => {
    const byName = Object.fromEntries(checkRailEnv(exampleEnv).map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({
      RAIL_MODE: "pass",
      STRIPE_SECRET_KEY: "pass",
      STRIPE_PROFILE_ID: "skipped",
      AGENT_WALLET_PRIVATE_KEY: "skipped",
      X402_NETWORK: "pass",
    });
    expect(checkRailEnv({}).find((c) => c.name === "STRIPE_SECRET_KEY")?.status).toBe("unset");
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects X402_MIN_UNITS %j", (v) => {
    expect(() => loadRailConfig({ X402_MIN_UNITS: v })).toThrow("X402_MIN_UNITS");
  });

  it("reads X402_MIN_UNITS as a bigint", () => {
    expect(loadRailConfig({ X402_MIN_UNITS: "10000" }).x402MinUnits).toBe(10_000n);
  });

  it("RAIL-9: results and errors never contain values", () => {
    const secret = "0x" + "ef".repeat(31);
    const env = { ...realEnv, AGENT_WALLET_PRIVATE_KEY: secret, STRIPE_SECRET_KEY: "sk_live_supersecret" };
    expect(JSON.stringify(checkRailEnv(env))).not.toContain(secret);
    try {
      loadRailConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("supersecret");
    }
  });
});
