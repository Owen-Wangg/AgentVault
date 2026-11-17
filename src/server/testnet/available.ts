import { loadRailConfig, loadX402PayerConfig, loadX402VendorConfig } from "@/rails/config";

type Env = Record<string, string | undefined>;

/**
 * Whether this deployment can make a real testnet payment (testnet-demo
 * TN-1): RAIL_MODE=real, and the x402 variables both sides need (the
 * agent wallet for the payer, the CDP keys and pay-to address for the
 * hosted vendor) pass their checks. The workspace itself is checked
 * separately, because that needs the database. Never throws and never
 * reveals which variable failed: the caller only gets yes or no.
 */
export function testnetRailReady(env: Env = process.env): boolean {
  try {
    if (loadRailConfig(env).mode !== "real") return false;
    loadX402PayerConfig(env);
    loadX402VendorConfig(env);
    return true;
  } catch {
    return false;
  }
}
