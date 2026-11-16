import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PAYPAL_SANDBOX_API,
  RailConfigError,
  checkPayPalEnv,
  checkRailEnv,
  checkStripeEnv,
  checkX402Env,
  loadPayPalConfig,
  loadRailConfig,
  loadStripeConfig,
  loadX402PayerConfig,
  loadX402VendorConfig,
} from "./config";

const realEnv = {
  RAIL_MODE: "real",
  STRIPE_SECRET_KEY: "sk_test_51abcDEF",
  STRIPE_PROFILE_ID: "profile_test_61abcDEF",
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

/** A valid key, its address, and a different vendor address. Test values only. */
const agentKey = ("0x" + "11".repeat(32)) as `0x${string}`;
const agentAddress = privateKeyToAccount(agentKey).address;
const x402Env = {
  RAIL_MODE: "mock",
  CDP_API_KEY_ID: "3f1c0f0e-0000-4000-8000-000000000000",
  CDP_API_KEY_SECRET: "c2VjcmV0LXRlc3QtdmFsdWU=",
  X402_PAY_TO: "0x" + "ab".repeat(20),
  AGENT_WALLET_PRIVATE_KEY: agentKey,
};

describe("x402 variables, checked on their own", () => {
  const status = (env: Record<string, string>) => Object.fromEntries(checkX402Env(env).map((c) => [c.name, c.status]));

  it("RAIL-8, RAIL-9: checks the x402 variables with the real-mode rules while RAIL_MODE is mock", () => {
    expect(status(x402Env)).toEqual({
      CDP_API_KEY_ID: "pass",
      CDP_API_KEY_SECRET: "pass",
      X402_PAY_TO: "pass",
      X402_NETWORK: "unset",
      X402_MIN_UNITS: "unset",
      AGENT_WALLET_PRIVATE_KEY: "pass",
    });
    expect(status(exampleEnv)).toMatchObject({ CDP_API_KEY_ID: "fail", X402_PAY_TO: "fail", AGENT_WALLET_PRIVATE_KEY: "fail" });
    expect(checkX402Env({}).find((c) => c.name === "CDP_API_KEY_ID")?.problem).toBe("is required for x402");
  });

  it("RAIL-8: refuses a mainnet network here too", () => {
    expect(status({ ...x402Env, X402_NETWORK: "eip155:8453" }).X402_NETWORK).toBe("fail");
  });

  it("refuses a vendor address that is the agent wallet's own, in any letter case", () => {
    for (const payTo of [agentAddress, agentAddress.toLowerCase()]) {
      const payToCheck = checkX402Env({ ...x402Env, X402_PAY_TO: payTo }).find((c) => c.name === "X402_PAY_TO");
      expect(payToCheck).toMatchObject({ status: "fail", problem: expect.stringContaining("agent wallet") });
    }
  });

  it("refuses a mixed-case address with a wrong checksum", () => {
    const flipped = agentAddress.replace(/[a-f]/, (c) => c.toUpperCase());
    expect(status({ ...x402Env, X402_PAY_TO: flipped }).X402_PAY_TO).toBe("fail");
  });

  it("refuses a key outside the secp256k1 range", () => {
    expect(status({ ...x402Env, AGENT_WALLET_PRIVATE_KEY: "0x" + "ff".repeat(32) }).AGENT_WALLET_PRIVATE_KEY).toBe("fail");
  });

  it("loads the vendor and payer configurations separately", () => {
    const vendor = loadX402VendorConfig({ CDP_API_KEY_ID: x402Env.CDP_API_KEY_ID, CDP_API_KEY_SECRET: x402Env.CDP_API_KEY_SECRET, X402_PAY_TO: x402Env.X402_PAY_TO });
    expect(vendor).toMatchObject({ network: "eip155:84532", payTo: getAddress(x402Env.X402_PAY_TO) });
    const payer = loadX402PayerConfig({ AGENT_WALLET_PRIVATE_KEY: agentKey, X402_MIN_UNITS: "100" });
    expect(payer.account.address).toBe(agentAddress);
    expect(payer.minUnits).toBe(100n);
    expect(loadX402PayerConfig({ AGENT_WALLET_PRIVATE_KEY: agentKey }).minUnits).toBe(1000n);
    expect(() => loadX402VendorConfig({ X402_PAY_TO: x402Env.X402_PAY_TO })).toThrow("CDP_API_KEY_ID");
    expect(() => loadX402PayerConfig({})).toThrow("AGENT_WALLET_PRIVATE_KEY");
  });
});

describe("RAIL-7: Stripe test mode only", () => {
  it.each(["sk_live_51abc", "rk_live_51abc"])("RAIL-7: refuses %s in every mode", (key) => {
    expect(() => loadRailConfig({ STRIPE_SECRET_KEY: key })).toThrow(RailConfigError);
    expect(() => loadRailConfig({ ...realEnv, STRIPE_SECRET_KEY: key })).toThrow("live key");
  });

  it("RAIL-7: real mode needs a key starting with sk_test_", () => {
    expect(() => loadRailConfig({ ...realEnv, STRIPE_SECRET_KEY: "pk_test_abc" })).toThrow("sk_test_");
  });

  it("RAIL-7: real mode needs a sandbox profile ID (profile_test_)", () => {
    expect(() => loadRailConfig({ ...realEnv, STRIPE_PROFILE_ID: "profile_61abc" })).toThrow("profile_test_");
  });
});

describe("Stripe variables, checked on their own", () => {
  const stripeEnv = { RAIL_MODE: "mock", STRIPE_SECRET_KEY: "sk_test_51abcDEF", STRIPE_PROFILE_ID: "profile_test_61abcDEF" };
  const status = (env: Record<string, string>) => Object.fromEntries(checkStripeEnv(env).map((c) => [c.name, c.status]));

  it("RAIL-7: checks the Stripe variables with the real-mode rules while RAIL_MODE is mock", () => {
    expect(status(stripeEnv)).toEqual({ STRIPE_SECRET_KEY: "pass", STRIPE_PROFILE_ID: "pass" });
    expect(status(exampleEnv)).toEqual({ STRIPE_SECRET_KEY: "fail", STRIPE_PROFILE_ID: "fail" });
    expect(checkStripeEnv({}).find((c) => c.name === "STRIPE_SECRET_KEY")?.problem).toBe("is required for Stripe");
    expect(status({ ...stripeEnv, STRIPE_SECRET_KEY: "sk_live_51abc" }).STRIPE_SECRET_KEY).toBe("fail");
  });

  it("RAIL-7: a loaded Stripe config never shows the key when logged", () => {
    const config = loadStripeConfig({ STRIPE_SECRET_KEY: "sk_test_supersecret", STRIPE_PROFILE_ID: stripeEnv.STRIPE_PROFILE_ID });
    expect(config.secretKey()).toBe("sk_test_supersecret");
    expect(config.profileId).toBe(stripeEnv.STRIPE_PROFILE_ID);
    expect(inspect(config, { depth: 10, showHidden: true })).not.toContain("supersecret");
    expect(() => loadStripeConfig({ STRIPE_SECRET_KEY: "sk_live_supersecret" })).toThrow(RailConfigError);
    try {
      loadStripeConfig({ STRIPE_SECRET_KEY: "sk_live_supersecret" });
    } catch (error) {
      expect(String(error)).not.toContain("supersecret");
    }
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
  it("RAIL-4: defaults to mock mode with the measured x402 minimum of 1000 units ($0.001)", () => {
    expect(loadRailConfig({})).toEqual({ mode: "mock", x402Network: "eip155:84532", x402MinUnits: 1000n });
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

  it("RAIL-9: x402 results and errors never contain the agent key", () => {
    const secret = "0x" + "ef".repeat(32);
    const env = { ...exampleEnv, AGENT_WALLET_PRIVATE_KEY: secret };
    expect(JSON.stringify(checkX402Env(env))).not.toContain("efefefef");
    // inspect() is what console.log prints, so a logged config can't show the key.
    expect(inspect(loadX402PayerConfig(env), { depth: 10, showHidden: true })).not.toContain("efefefef");
    expect(() => loadX402PayerConfig({ AGENT_WALLET_PRIVATE_KEY: "0x" + "ff".repeat(32) })).toThrow(RailConfigError);
    try {
      loadX402PayerConfig({ AGENT_WALLET_PRIVATE_KEY: "0x" + "ff".repeat(32) });
    } catch (error) {
      expect(String(error)).not.toContain("ffffffff");
    }
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

const paypalEnv = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "AbCdEf123_client-id",
  PAYPAL_CLIENT_SECRET: "EfGh456_client-secret",
  PAYPAL_SUPPLIER_RECEIVER: "sb-supplier1@personal.example.com",
  PAYPAL_ATTACKER_RECEIVER: "sb-attacker2@personal.example.com",
};
const statusOf = (env: Record<string, string | undefined>, name: string) => checkPayPalEnv(env).find((c) => c.name === name);

describe("PayPal sandbox variables", () => {
  it("PO-21: a complete sandbox setup passes and loads with the fixed sandbox host", () => {
    expect(checkPayPalEnv(paypalEnv).map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    const config = loadPayPalConfig(paypalEnv);
    expect(config).toMatchObject({ apiOrigin: PAYPAL_SANDBOX_API, clientId: paypalEnv.PAYPAL_CLIENT_ID, supplierReceiver: paypalEnv.PAYPAL_SUPPLIER_RECEIVER });
    expect(PAYPAL_SANDBOX_API).toBe("https://api-m.sandbox.paypal.com");
  });

  it.each(["live", "production", "Sandbox", ""])("PO-17: PAYPAL_ENV=%j is refused, so no PayPal call can run", (value) => {
    expect(statusOf({ ...paypalEnv, PAYPAL_ENV: value }, "PAYPAL_ENV")?.status).toBe("fail");
    expect(() => loadPayPalConfig({ ...paypalEnv, PAYPAL_ENV: value })).toThrow(RailConfigError);
  });

  it("PO-17: a PAYPAL_ENV other than sandbox fails the general rail check too, even in mock mode", () => {
    const check = checkRailEnv({ ...exampleEnv, PAYPAL_ENV: "live" }).find((c) => c.name === "PAYPAL_ENV");
    expect(check?.status).toBe("fail");
    expect(() => loadRailConfig({ ...exampleEnv, PAYPAL_ENV: "live" })).toThrow(RailConfigError);
    expect(checkRailEnv(exampleEnv).find((c) => c.name === "PAYPAL_ENV")?.status).toBe("unset");
  });

  it.each(["supplier@gmail.com", "sb-x@personal.example.com.evil.test", "sb-x@example.com", "not an email"])(
    "PO-21: receiver %j isn't a sandbox account, so it's refused",
    (value) => {
      expect(statusOf({ ...paypalEnv, PAYPAL_SUPPLIER_RECEIVER: value }, "PAYPAL_SUPPLIER_RECEIVER")?.status).toBe("fail");
    },
  );

  it("PO-21: the .env.example placeholders and missing values fail, naming the variable", () => {
    const placeholders = {
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: "replace-me",
      PAYPAL_CLIENT_SECRET: "replace-me",
      PAYPAL_SUPPLIER_RECEIVER: "sb-replace-me@personal.example.com",
      PAYPAL_ATTACKER_RECEIVER: "sb-replace-me-too@personal.example.com",
    };
    expect(checkPayPalEnv(placeholders).filter((c) => c.status === "fail").map((c) => c.name)).toEqual([
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_SUPPLIER_RECEIVER",
      "PAYPAL_ATTACKER_RECEIVER",
    ]);
    expect(checkPayPalEnv({}).every((c) => c.status === "fail")).toBe(true);
  });

  it("PO-23: the supplier and the attacker must be different sandbox accounts", () => {
    const same = { ...paypalEnv, PAYPAL_ATTACKER_RECEIVER: paypalEnv.PAYPAL_SUPPLIER_RECEIVER.toUpperCase() };
    expect(statusOf(same, "PAYPAL_ATTACKER_RECEIVER")).toMatchObject({ status: "fail" });
  });

  it("RAIL-9: results, errors, and the loaded config never show the client secret", () => {
    const env = { ...paypalEnv, PAYPAL_ENV: "live" };
    expect(JSON.stringify(checkPayPalEnv(env))).not.toContain(paypalEnv.PAYPAL_CLIENT_SECRET);
    expect(() => loadPayPalConfig(env)).toThrow(RailConfigError);
    try {
      loadPayPalConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain(paypalEnv.PAYPAL_CLIENT_SECRET);
    }
    expect(inspect(loadPayPalConfig(paypalEnv))).not.toContain(paypalEnv.PAYPAL_CLIENT_SECRET);
  });
});
