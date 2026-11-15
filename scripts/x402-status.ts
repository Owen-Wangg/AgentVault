// `pnpm x402:status`: show the two x402 test wallets and their Base
// Sepolia balances (docs/SETUP.md, "x402 test payments"). It prints
// addresses, which are public, and never the private key (RAIL-9). It only
// reads from the chain.
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromRailUnits, toDisplay } from "@/core/money";
import { checkX402Env } from "@/rails/config";
import { BaseSepoliaReader } from "@/rails/x402/chain";
import { explorerAddressUrl } from "@/rails/x402/constants";
import { loadLocalEnv } from "./lib/load-env";

async function main() {
  loadLocalEnv();
  const checks = checkX402Env();
  const ok = (name: string) => checks.find((c) => c.name === name)?.status === "pass";
  const wallets: { label: string; address: `0x${string}` }[] = [];
  if (ok("AGENT_WALLET_PRIVATE_KEY")) {
    wallets.push({ label: "Agent wallet (pays)", address: privateKeyToAccount(process.env.AGENT_WALLET_PRIVATE_KEY as `0x${string}`).address });
  } else console.log("AGENT_WALLET_PRIVATE_KEY is not set up yet; run pnpm env:check.");
  if (ok("X402_PAY_TO")) wallets.push({ label: "Vendor wallet (X402_PAY_TO)", address: process.env.X402_PAY_TO as `0x${string}` });
  else console.log("X402_PAY_TO is not set up yet; run pnpm env:check.");

  const chain = new BaseSepoliaReader();
  for (const w of wallets) {
    try {
      const [usdc, eth] = await Promise.all([chain.usdcBalance(w.address), chain.ethBalance(w.address)]);
      console.log(`${w.label}\n  ${w.address}\n  USDC ${toDisplay(fromRailUnits(usdc, "x402"))}, ETH ${formatEther(eth)}\n  ${explorerAddressUrl(w.address)}`);
    } catch (error) {
      console.log(`${w.label}\n  ${w.address}\n  balance unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}

void main();
