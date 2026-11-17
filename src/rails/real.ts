import type { Rail } from "@/core/money";
import { loadPayPalConfig, loadRailConfig, loadStripeConfig, loadX402PayerConfig } from "./config";
import { PayPalRail } from "./paypal/adapter";
import { type RailForOptions, railFor } from "./select";
import type { RailAdapter } from "./types";
import { StripeMppRail } from "./stripe-mpp/adapter";
import { StripeConnectPayouts } from "./stripe-mpp/payouts";
import { StripeApi } from "./stripe-mpp/stripe-api";
import { X402Rail } from "./x402/adapter";

type Env = Record<string, string | undefined>;

/**
 * The options every server entry point passes to railFor(). In real mode
 * they include the real adapters: x402 on Base Sepolia (Phase 13) and
 * Stripe MPP in test mode (Phase 14). The sandbox always gets the mock
 * adapters, whatever these contain (RAIL-2).
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

/**
 * The options for one workspace's request (testnet-demo TN-8). A sandbox
 * always runs on the mock adapters (RAIL-2), so it builds no real adapter
 * and doesn't need the real-rail variables: a missing or invalid one
 * can't make a sandbox request fail. The checks that apply in every mode
 * still run, so a live Stripe key, a network other than Base Sepolia, or a
 * PAYPAL_ENV other than sandbox still throws (RAIL-7, RAIL-8, PO-17).
 */
export function railOptionsFor(workspace: { isSandbox: boolean }, env: Env = process.env): RailForOptions {
  if (workspace.isSandbox) return { config: loadRailConfig({ ...env, RAIL_MODE: "mock" }) };
  return railOptions(env);
}

/** railFor() with the options for the request's workspace. What every server entry point passes as `railFor`. */
export function serverRailFor(rail: Rail, workspace: { isSandbox: boolean }): RailAdapter {
  return railFor(rail, workspace, railOptionsFor(workspace));
}

let cached: RailForOptions["real"] | null = null;

function buildReal(env: Env): NonNullable<RailForOptions["real"]> {
  const payer = loadX402PayerConfig(env);
  const stripe = loadStripeConfig(env);
  // One client for MPP payments and Connect payouts. Connect calls pin their own API version.
  const api = new StripeApi({ secretKey: stripe.secretKey() });
  return {
    x402: new X402Rail({ account: payer.account, minUnits: payer.minUnits }),
    stripe: new StripeMppRail({ api, profileId: stripe.profileId, payouts: new StripeConnectPayouts(api) }),
    // payout-rails PO-17: PayPal only when it's set up, and then every PayPal variable must pass. Without
    // it, railFor("paypal") throws RailUnavailableError, so paypal.payout fails closed.
    ...(env.PAYPAL_CLIENT_ID ? { paypal: new PayPalRail({ config: loadPayPalConfig(env) }) } : {}),
  };
}
