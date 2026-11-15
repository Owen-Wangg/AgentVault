/**
 * Base Sepolia facts the x402 adapter and the demo vendor rely on
 * (rail-adapters design, "x402 adapter"). Testnet only (RAIL-8): nothing
 * here can point at a mainnet.
 */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Circle's test USDC on Base Sepolia. 6 decimals, so 1 atomic unit = 1 micro (MON-9). */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** The token's EIP-712 domain name and version, which every EIP-3009 authorization signs over. */
export const USDC_EIP712 = { name: "USDC", version: "2" } as const;

/** Base's public Base Sepolia RPC endpoint. Rate limited, which is enough for lookups and the status script. */
export const BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org";

/** Base Sepolia's block time. Used only to estimate where to search for a settlement; the estimate is checked. */
export const BLOCK_TIME_SECONDS = 2n;

export function explorerTxUrl(hash: string): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://sepolia.basescan.org/address/${address}`;
}
