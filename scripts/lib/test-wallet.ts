import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * A fresh Base Sepolia test wallet for `pnpm wallet:new` (rail-adapters
 * task 3). The key comes from viem's generatePrivateKey, which uses the
 * platform's cryptographic random source. Nothing is sent anywhere.
 */
export interface TestWallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export function newTestWallet(): TestWallet {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}
