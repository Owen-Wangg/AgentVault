import { getAddress, isAddress } from "viem";
import { type LocalAccount, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { SANDBOX_RECEIVER } from "./destination";

/**
 * Rail configuration from environment variables (rail-adapters design,
 * "Config"). The test-only safety checks apply in every mode, so a live key
 * in the environment stops the app even while it uses mock rails:
 * - RAIL-7: STRIPE_SECRET_KEY must never be a live key.
 * - RAIL-8: the x402 network must be Base Sepolia.
 * Formats and presence of the real-rail credentials are checked only when
 * RAIL_MODE=real, so the placeholders from .env.example work in mock mode.
 * Messages name variables, never their values (RAIL-9).
 */

export const BASE_SEPOLIA = "eip155:84532";
/**
 * The x402 minimum when X402_MIN_UNITS is unset, in USDC atomic units.
 * Measured in rail-adapters task 4 on Base Sepolia: the CDP facilitator
 * refuses 999 units ($0.000999) with `amount_too_low` and settles 1000.
 */
export const DEFAULT_X402_MIN_UNITS = 1000n;

export interface RailConfig {
  mode: "mock" | "real";
  x402Network: typeof BASE_SEPOLIA;
  /** Facilitator minimum in USDC atomic units (rail-adapters task 4 measures it). */
  x402MinUnits: bigint;
}

type Env = Record<string, string | undefined>;

export interface VariableCheck {
  name: string;
  /** `skipped`: set, but only checked when RAIL_MODE=real. */
  status: "pass" | "fail" | "unset" | "skipped";
  problem?: string;
  note?: string;
}

interface Check {
  name: string;
  /** Required when RAIL_MODE=real. */
  requiredWhenReal: boolean;
  /** Returns a problem, or null if the value is acceptable. Checks that apply in every mode use `always`. */
  always?: (value: string) => string | null;
  real?: (value: string) => string | null;
}

const LIVE_KEY = /^(sk|rk)_live_/;

const regexCheck = (re: RegExp, problem: string) => (v: string) => (re.test(v) ? null : problem);

const CHECKS: readonly Check[] = [
  {
    name: "RAIL_MODE",
    requiredWhenReal: false,
    always: (v) => (v === "mock" || v === "real" ? null : "must be mock or real"),
  },
  {
    name: "STRIPE_SECRET_KEY",
    requiredWhenReal: true,
    always: (v) => (LIVE_KEY.test(v) ? "is a live key; only test mode (sk_test_) is allowed" : null),
    real: regexCheck(/^sk_test_\w+$/, "must be a test-mode key starting with sk_test_"),
  },
  {
    name: "STRIPE_PROFILE_ID",
    requiredWhenReal: true,
    // Stripe's MPP guide: a sandbox's profile ID starts with profile_test_. A live profile can't take test payments.
    real: regexCheck(/^profile_test_\w+$/, "must be a sandbox profile ID starting with profile_test_"),
  },
  { name: "CDP_API_KEY_ID", requiredWhenReal: true },
  { name: "CDP_API_KEY_SECRET", requiredWhenReal: true },
  {
    name: "X402_PAY_TO",
    requiredWhenReal: true,
    // isAddress checks the EIP-55 checksum of a mixed-case address, which catches a mistyped one.
    real: (v) => (!/^0x[0-9a-fA-F]{40}$/.test(v) ? "must be a 0x address" : isAddress(v) ? null : "has a wrong checksum; copy the address again"),
  },
  {
    name: "X402_NETWORK",
    requiredWhenReal: false,
    always: (v) => (v === BASE_SEPOLIA ? null : `must be ${BASE_SEPOLIA} (Base Sepolia); other networks are refused`),
  },
  { name: "X402_MIN_UNITS", requiredWhenReal: false, always: regexCheck(/^[1-9]\d{0,17}$/, "must be a positive whole number") },
  {
    name: "AGENT_WALLET_PRIVATE_KEY",
    requiredWhenReal: true,
    real: regexCheck(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
  },
  {
    // payout-rails PO-17: any other value is refused in every mode, like a live Stripe key.
    name: "PAYPAL_ENV",
    requiredWhenReal: false,
    always: (v) => (v === "sandbox" ? null : "must be sandbox; AgentVault never calls PayPal's live API"),
  },
];

const ZERO_ADDRESS = /^0x0{40}$/;

/** Real mode can't run on the .env.example placeholders. Payments to the zero address would be lost. */
function placeholderProblem(check: Check, value: string): string | null {
  if (!check.requiredWhenReal) return null;
  if (/replace/i.test(value)) return "is still the .env.example placeholder";
  if (ZERO_ADDRESS.test(value)) return "is the zero address placeholder";
  return null;
}

/** Check each rail variable on its own. Never includes a value in the result. */
export function checkRailEnv(env: Env = process.env): VariableCheck[] {
  const mode = env.RAIL_MODE === "real" ? "real" : "mock";
  return CHECKS.map((check): VariableCheck => {
    const value = env[check.name];
    if (value === undefined || value === "") {
      return check.requiredWhenReal && mode === "real"
        ? { name: check.name, status: "fail", problem: "is required when RAIL_MODE=real" }
        : { name: check.name, status: "unset" };
    }
    const problem = check.always?.(value) ?? (mode === "real" ? placeholderProblem(check, value) ?? check.real?.(value) : null) ?? null;
    if (problem) return { name: check.name, status: "fail", problem };
    const realOnly = mode === "mock" && (check.real !== undefined || check.requiredWhenReal);
    if (!realOnly) return { name: check.name, status: "pass" };
    // In mock mode only the safety check runs (for example, "not a live key"); the format is checked in real mode.
    return check.always
      ? { name: check.name, status: "pass", note: "safety check only; format checked when RAIL_MODE=real" }
      : { name: check.name, status: "skipped", note: "checked when RAIL_MODE=real" };
  });
}

export class RailConfigError extends Error {
  constructor(readonly failures: readonly VariableCheck[]) {
    super(`Unsafe or invalid rail configuration: ${failures.map((f) => `${f.name} ${f.problem}`).join("; ")}. See .env.example.`);
    this.name = "RailConfigError";
  }
}

/** The x402 variables, in the order `pnpm env:check` lists them. */
export const X402_VARIABLES = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "X402_PAY_TO", "X402_NETWORK", "X402_MIN_UNITS", "AGENT_WALLET_PRIVATE_KEY"] as const;

/** The agent wallet's address, or null if the key isn't a valid secp256k1 key. Never returns or throws the key. */
function agentAddressOf(key: string): string | null {
  try {
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    return null;
  }
}

/**
 * The x402 variables checked with the real-mode rules, whatever RAIL_MODE
 * says. The vendor endpoint and the `@live` tests use x402 in mock mode
 * too, and real mode also needs the Stripe variables (Phase 14). Adds one
 * check real mode alone can't express: the vendor and the agent must be
 * different wallets, or a "payment" would move nothing.
 */
export function checkX402Env(env: Env = process.env): VariableCheck[] {
  const names: ReadonlySet<string> = new Set(X402_VARIABLES);
  const checks = checkRailEnv({ ...env, RAIL_MODE: "real" })
    .filter((c) => names.has(c.name))
    .map((c) => (c.problem === "is required when RAIL_MODE=real" ? { ...c, problem: "is required for x402" } : c));
  const payTo = checks.find((c) => c.name === "X402_PAY_TO");
  const key = checks.find((c) => c.name === "AGENT_WALLET_PRIVATE_KEY");
  if (key?.status === "pass" && agentAddressOf(env.AGENT_WALLET_PRIVATE_KEY ?? "") === null) {
    Object.assign(key, { status: "fail", problem: "is not a valid secp256k1 private key" });
  }
  if (payTo?.status === "pass" && key?.status === "pass") {
    const agent = agentAddressOf(env.AGENT_WALLET_PRIVATE_KEY ?? "");
    if (agent && agent.toLowerCase() === (env.X402_PAY_TO ?? "").toLowerCase()) {
      Object.assign(payTo, { status: "fail", problem: "is the agent wallet's own address; the vendor needs a separate wallet" });
    }
  }
  return checks;
}

function requireX402(env: Env, needed: readonly (typeof X402_VARIABLES)[number][]): void {
  const failures = checkX402Env(env).filter((c) => (needed as readonly string[]).includes(c.name) && c.status === "fail");
  if (failures.length > 0) throw new RailConfigError(failures);
}

export interface X402VendorConfig {
  network: typeof BASE_SEPOLIA;
  payTo: `0x${string}`;
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
}

/** Configuration for the demo vendor's x402 endpoint. Throws RailConfigError, naming variables only. */
export function loadX402VendorConfig(env: Env = process.env): X402VendorConfig {
  requireX402(env, ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "X402_PAY_TO", "X402_NETWORK"]);
  return {
    network: BASE_SEPOLIA,
    payTo: getAddress(env.X402_PAY_TO ?? ""),
    cdpApiKeyId: env.CDP_API_KEY_ID ?? "",
    cdpApiKeySecret: env.CDP_API_KEY_SECRET ?? "",
  };
}

export interface X402PayerConfig {
  network: typeof BASE_SEPOLIA;
  minUnits: bigint;
  /**
   * The agent wallet. A viem account signs without exposing its key, so
   * the key string is not kept anywhere after this returns (RAIL-9).
   */
  account: LocalAccount;
}

/** Configuration for the x402 payer adapter. Throws RailConfigError, naming variables only. */
export function loadX402PayerConfig(env: Env = process.env): X402PayerConfig {
  requireX402(env, ["AGENT_WALLET_PRIVATE_KEY", "X402_NETWORK", "X402_MIN_UNITS"]);
  return {
    network: BASE_SEPOLIA,
    minUnits: env.X402_MIN_UNITS ? MinUnits.parse(env.X402_MIN_UNITS) : DEFAULT_X402_MIN_UNITS,
    account: privateKeyToAccount(env.AGENT_WALLET_PRIVATE_KEY as `0x${string}`),
  };
}

/** The Stripe variables, in the order `pnpm env:check` lists them. */
export const STRIPE_VARIABLES = ["STRIPE_SECRET_KEY", "STRIPE_PROFILE_ID"] as const;

/**
 * The Stripe variables checked with the real-mode rules, whatever
 * RAIL_MODE says, like checkX402Env. The MPP vendor endpoint, the Stripe
 * scripts, and the `@live` tests use Stripe test mode in mock mode too.
 */
export function checkStripeEnv(env: Env = process.env): VariableCheck[] {
  const names: ReadonlySet<string> = new Set(STRIPE_VARIABLES);
  return checkRailEnv({ ...env, RAIL_MODE: "real" })
    .filter((c) => names.has(c.name))
    .map((c) => (c.problem === "is required when RAIL_MODE=real" ? { ...c, problem: "is required for Stripe" } : c));
}

export interface StripeConfig {
  /**
   * The test-mode key (sk_test_). A function, so a logged or inspected
   * config shows `[Function]` instead of the key. Pass its result only to
   * StripeApi or the Stripe SDK.
   */
  secretKey: () => string;
  /** The sandbox's Stripe profile, the MPP `networkId` (profile_test_…). */
  profileId: string;
}

/** Configuration for Stripe test mode. Throws RailConfigError, naming variables only. */
export function loadStripeConfig(env: Env = process.env): StripeConfig {
  const failures = checkStripeEnv(env).filter((c) => c.status === "fail");
  if (failures.length > 0) throw new RailConfigError(failures);
  const key = env.STRIPE_SECRET_KEY ?? "";
  return { secretKey: () => key, profileId: env.STRIPE_PROFILE_ID ?? "" };
}

/** The only PayPal API host AgentVault talks to (payout-rails PO-17). There is no setting for another one. */
export const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";

/** The PayPal variables, in the order `pnpm env:check` lists them. */
export const PAYPAL_VARIABLES = ["PAYPAL_ENV", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_SUPPLIER_RECEIVER", "PAYPAL_ATTACKER_RECEIVER"] as const;

/** True for a PayPal sandbox account address (SANDBOX_RECEIVER in destination.ts). The PayPal adapter's destination check uses the same rule. */
export function isSandboxReceiver(address: string): boolean {
  return SANDBOX_RECEIVER.test(address);
}

/**
 * The PayPal sandbox variables (payout-rails PO-17, PO-21), all required
 * for PayPal payouts, whatever RAIL_MODE says. Messages name variables,
 * never values. The two receivers must be different sandbox accounts,
 * or the payee-hijack demo would redirect money to the same place.
 */
export function checkPayPalEnv(env: Env = process.env): VariableCheck[] {
  const presence = (name: string, value: string | undefined): VariableCheck | null => {
    if (value === undefined || value === "") return { name, status: "fail", problem: "is required for PayPal" };
    if (/replace/i.test(value)) return { name, status: "fail", problem: "is still the .env.example placeholder" };
    return null;
  };
  const receiver = (name: string): VariableCheck => {
    const value = env[name];
    const missing = presence(name, value);
    if (missing) return missing;
    return SANDBOX_RECEIVER.test(value ?? "")
      ? { name, status: "pass" }
      : { name, status: "fail", problem: "must be a sandbox account address ending in @personal.example.com or @business.example.com" };
  };
  const mode = env.PAYPAL_ENV;
  const checks: VariableCheck[] = [
    mode === undefined || mode === ""
      ? { name: "PAYPAL_ENV", status: "fail", problem: "is required for PayPal and must be sandbox" }
      : mode === "sandbox"
        ? { name: "PAYPAL_ENV", status: "pass" }
        : { name: "PAYPAL_ENV", status: "fail", problem: "must be sandbox; AgentVault never calls PayPal's live API" },
    presence("PAYPAL_CLIENT_ID", env.PAYPAL_CLIENT_ID) ?? { name: "PAYPAL_CLIENT_ID", status: "pass" },
    presence("PAYPAL_CLIENT_SECRET", env.PAYPAL_CLIENT_SECRET) ?? { name: "PAYPAL_CLIENT_SECRET", status: "pass" },
    receiver("PAYPAL_SUPPLIER_RECEIVER"),
    receiver("PAYPAL_ATTACKER_RECEIVER"),
  ];
  const [, , , supplier, attacker] = checks;
  if (supplier?.status === "pass" && attacker?.status === "pass" && env.PAYPAL_SUPPLIER_RECEIVER?.toLowerCase() === env.PAYPAL_ATTACKER_RECEIVER?.toLowerCase()) {
    Object.assign(attacker, { status: "fail", problem: "is the same account as PAYPAL_SUPPLIER_RECEIVER; the demo needs two" });
  }
  return checks;
}

export interface PayPalConfig {
  /** Always sandbox: the loader refuses anything else, and the adapter checks again on every call (PO-17). */
  environment: "sandbox";
  apiOrigin: typeof PAYPAL_SANDBOX_API;
  clientId: string;
  /** A function, like StripeConfig.secretKey, so a logged config shows `[Function]`. */
  clientSecret: () => string;
  supplierReceiver: string;
  attackerReceiver: string;
}

/** Configuration for the PayPal sandbox. Throws RailConfigError, naming variables only. */
export function loadPayPalConfig(env: Env = process.env): PayPalConfig {
  const failures = checkPayPalEnv(env).filter((c) => c.status === "fail");
  if (failures.length > 0) throw new RailConfigError(failures);
  const secret = env.PAYPAL_CLIENT_SECRET ?? "";
  return {
    environment: "sandbox",
    apiOrigin: PAYPAL_SANDBOX_API,
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: () => secret,
    supplierReceiver: env.PAYPAL_SUPPLIER_RECEIVER ?? "",
    attackerReceiver: env.PAYPAL_ATTACKER_RECEIVER ?? "",
  };
}

const MinUnits = z.string().regex(/^[1-9]\d{0,17}$/).transform(BigInt);

/** Validated rail configuration. Throws RailConfigError, which stops startup (RAIL-7, RAIL-8). */
export function loadRailConfig(env: Env = process.env): RailConfig {
  const failures = checkRailEnv(env).filter((c) => c.status === "fail");
  if (failures.length > 0) throw new RailConfigError(failures);
  return {
    mode: env.RAIL_MODE === "real" ? "real" : "mock",
    x402Network: BASE_SEPOLIA,
    x402MinUnits: env.X402_MIN_UNITS ? MinUnits.parse(env.X402_MIN_UNITS) : DEFAULT_X402_MIN_UNITS,
  };
}
