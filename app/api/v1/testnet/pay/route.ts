import { handleTestnetPay } from "@/server/testnet/handler";

// One real x402 payment on Base Sepolia through the guarded flow
// (testnet-demo TN-2). The logic lives in src/server/testnet.
export const dynamic = "force-dynamic";
// The payment and its settlement take a few seconds; the rail timeout is 30 s.
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleTestnetPay(request);
}
