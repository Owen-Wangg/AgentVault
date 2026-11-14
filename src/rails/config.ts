import { z } from "zod";

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
  { name: "STRIPE_PROFILE_ID", requiredWhenReal: true, real: regexCheck(/^profile_\w+$/, "must start with profile_") },
  { name: "CDP_API_KEY_ID", requiredWhenReal: true },
  { name: "CDP_API_KEY_SECRET", requiredWhenReal: true },
  { name: "X402_PAY_TO", requiredWhenReal: true, real: regexCheck(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address") },
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

const MinUnits = z.string().regex(/^[1-9]\d{0,17}$/).transform(BigInt);

/** Validated rail configuration. Throws RailConfigError, which stops startup (RAIL-7, RAIL-8). */
export function loadRailConfig(env: Env = process.env): RailConfig {
  const failures = checkRailEnv(env).filter((c) => c.status === "fail");
  if (failures.length > 0) throw new RailConfigError(failures);
  return {
    mode: env.RAIL_MODE === "real" ? "real" : "mock",
    x402Network: BASE_SEPOLIA,
    x402MinUnits: env.X402_MIN_UNITS ? MinUnits.parse(env.X402_MIN_UNITS) : 1n,
  };
}
