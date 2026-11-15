import { loadRailConfig, loadX402PayerConfig } from "./config";
import type { RailForOptions } from "./select";
import { X402Rail } from "./x402/adapter";

type Env = Record<string, string | undefined>;

/**
 * The options every server entry point passes to railFor(). In real mode
 * they include the real adapters built so far: x402 (Phase 13). Stripe
 * arrives in Phase 14; until then railFor() throws RailUnavailableError
 * for it outside the sandbox, and the request fails closed. The sandbox
 * always gets the mock adapters, whatever these contain (RAIL-2).
 *
 * Throws RailConfigError on an unsafe configuration (RAIL-7, RAIL-8).
 */
export function railOptions(env: Env = process.env): RailForOptions {
  const config = loadRailConfig(env);
  if (config.mode !== "real") return { config };
  if (env !== process.env) return { config, real: buildReal(env) };
  // One set per process, so the chain ID is checked once rather than on every request.
  cached ??= buildReal(env);
  return { config, real: cached };
}

let cached: RailForOptions["real"] | null = null;

function buildReal(env: Env): NonNullable<RailForOptions["real"]> {
  const payer = loadX402PayerConfig(env);
  return { x402: new X402Rail({ account: payer.account, minUnits: payer.minUnits }) };
}
