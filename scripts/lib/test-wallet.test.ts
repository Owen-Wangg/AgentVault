import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { newTestWallet } from "./test-wallet";

describe("pnpm wallet:new", () => {
  it("RAIL-9: makes a 32-byte key in the format AGENT_WALLET_PRIVATE_KEY expects, with its address", () => {
    const wallet = newTestWallet();
    expect(wallet.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.address).toBe(privateKeyToAccount(wallet.privateKey).address);
  });

  it("makes a different wallet each time", () => {
    const keys = new Set(Array.from({ length: 20 }, () => newTestWallet().privateKey));
    expect(keys.size).toBe(20);
  });
});
