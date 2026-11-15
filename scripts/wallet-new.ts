// `pnpm wallet:new`: print a new Base Sepolia test wallet (docs/SETUP.md,
// "x402 test payments"). This is the one command that prints a private
// key, on purpose, so you can copy it into .env.local. It runs only on
// your machine and sends nothing over the network.
import { newTestWallet } from "./lib/test-wallet";

const wallet = newTestWallet();
console.log("New test wallet. Testnet only: never send real funds to it.");
console.log("");
console.log(`Address:      ${wallet.address}`);
console.log(`Private key:  ${wallet.privateKey}`);
console.log("");
console.log("Copy what you need now, then run Clear-Host to clear the terminal.");
console.log("The address is public. The private key is a secret: anyone who has it can move this wallet's funds.");
