import { decodePaymentSignatureHeader } from "@x402/core/http";
import { verifyTypedData } from "viem";
import { type LocalAccount, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { micros } from "@/core/money";
import { X402Rail, authorizationNonce } from "./adapter";
import { BaseSepoliaReader } from "./chain";
import { BASE_SEPOLIA_CHAIN_ID, USDC_BASE_SEPOLIA } from "./constants";
import { type LookupRecording, loadRecording, replayRpc, replayVendor } from "./test-fixtures";

/**
 * Contract tests against exchanges recorded on Base Sepolia with
 * `pnpm x402:probe --record` (rail-adapters task 5). The vendor endpoint
 * ran in-process with the real CDP facilitator; the RPC was Base's public
 * endpoint. Nothing here touches the network.
 */

const settled = loadRecording("settled-1500-units.json");
const tooLow = loadRecording("amount-too-low-1-unit.json");
const testAccount = privateKeyToAccount(`0x${"42".repeat(32)}`);
const VENDOR_URL = "http://localhost:3000/vendor/api/weather";

type Authorization = { from: `0x${string}`; to: `0x${string}`; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` };
const recordedPayload = (r: typeof settled) => r.http[1]?.request.payment_signature as { accepted: unknown; resource: unknown; payload: { authorization: Authorization; signature: `0x${string}` } };

/** The clock the recording signed at: its validBefore is that time plus the challenge's 120 s timeout. */
const signingClock = (r: typeof settled) => () => new Date((Number(recordedPayload(r).payload.authorization.validBefore) - 120) * 1000);

/** Signs nothing: lookup() only needs the address. */
const viewOnly = (address: `0x${string}`) => ({ address }) as unknown as LocalAccount;

describe("x402 adapter against recorded Base Sepolia exchanges", () => {
  it("RAIL-12: the authorization the facilitator settled is signed over the typed data this adapter signs", async () => {
    const { authorization, signature } = recordedPayload(settled).payload;
    const valid = await verifyTypedData({
      address: settled.payer,
      domain: { name: "USDC", version: "2", chainId: BASE_SEPOLIA_CHAIN_ID, verifyingContract: USDC_BASE_SEPOLIA },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    expect(valid).toBe(true);
    // The settled nonce is the one lookup() rebuilds from the key.
    expect(authorization.nonce).toBe(authorizationNonce(settled.key));
  });

  it("RAIL-10, RAIL-11, RAIL-12: pays the recorded $0.0015 challenge, retries, and returns the transaction hash and explorer link", async () => {
    const vendor = replayVendor(settled, { payer: testAccount.address });
    const rail = new X402Rail({ account: testAccount, minUnits: 1000n, fetch: vendor.fetchFn, now: signingClock(settled) });
    const result = await rail.execute(
      { vendorUrl: VENDOR_URL, approvedMicros: micros(1500n), idempotencyKey: settled.key },
      { reservedAt: new Date(settled.reserved_at) },
    );
    const tx = settled.http[1]?.response.payment_response?.transaction;
    expect(result).toMatchObject({ ok: true, ref: tx, explorerUrl: `https://sepolia.basescan.org/tx/${tx}`, settledMicros: 1500n });
    expect(result.ok && result.vendorBody).toMatchObject({ vendor: "nimbus-weather", conditions: "light rain" });

    // One unpaid request, then one paid retry whose payload matches the recording except for who signed it.
    expect(vendor.sent.map((s) => s.headers.has("PAYMENT-SIGNATURE"))).toEqual([false, true]);
    const sent = decodePaymentSignatureHeader(vendor.sent[1]?.headers.get("PAYMENT-SIGNATURE") ?? "") as unknown as ReturnType<typeof recordedPayload>;
    const recorded = recordedPayload(settled);
    expect(sent.accepted).toEqual(recorded.accepted);
    expect(sent.resource).toEqual(recorded.resource);
    expect({ ...sent.payload.authorization, from: settled.payer }).toEqual(recorded.payload.authorization);
    expect(sent.payload.authorization.from).toBe(testAccount.address);
  });

  it("RAIL-5, RAIL-6: the facilitator's amount_too_low on the paid retry is an unknown outcome, not a confirmed failure", async () => {
    // The paid request was sent, so only lookup() can say whether money moved.
    const vendor = replayVendor(tooLow);
    const rail = new X402Rail({ account: testAccount, minUnits: 1n, fetch: vendor.fetchFn, now: signingClock(tooLow) });
    const result = await rail.execute({ vendorUrl: VENDOR_URL, approvedMicros: micros(1n), idempotencyKey: tooLow.key }, { reservedAt: new Date(tooLow.reserved_at) });
    expect(result).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    expect(tooLow.http[1]?.response.body).toContain("amount_too_low");
  });

  it("RAIL-21: looks up the recorded payment by its key and finds the transaction and the amount", async () => {
    const rpc = replayRpc(settled.rpc);
    const rail = new X402Rail({ account: viewOnly(settled.payer), minUnits: 1000n, chain: new BaseSepoliaReader({ fetch: rpc.fetchFn }), fetch: () => Promise.reject(new Error("lookup must not call the vendor")) });
    const found = await rail.lookup(settled.key, { reservedAt: new Date(settled.reserved_at) });
    const tx = settled.http[1]?.response.payment_response?.transaction;
    expect(found).toEqual({ status: "settled", ref: tx, explorerUrl: `https://sepolia.basescan.org/tx/${tx}`, settledMicros: 1500n });
  });

  it("RAIL-21: the authorization the facilitator refused is failed once the finalized chain passes its deadline unused", async () => {
    // Recorded 32 minutes after the refusal, when Base Sepolia's finalized block had passed the deadline.
    const recorded = loadRecording<LookupRecording>("amount-too-low-1-unit.lookup.json");
    expect(recorded.key).toBe(tooLow.key);
    const rpc = replayRpc(recorded.rpc);
    const rail = new X402Rail({ account: viewOnly(recorded.payer), minUnits: 1n, chain: new BaseSepoliaReader({ fetch: rpc.fetchFn }) });
    expect(await rail.lookup(recorded.key, { reservedAt: new Date(recorded.reserved_at) })).toEqual({ status: "failed", code: "RAIL_REJECTED" });
    expect(recorded.result).toEqual({ status: "failed", code: "RAIL_REJECTED" });
  });

  it("RAIL-22: the lookup only reads: no transaction is sent and the vendor is never called", async () => {
    const rpc = replayRpc(settled.rpc);
    let vendorCalls = 0;
    const rail = new X402Rail({
      account: viewOnly(settled.payer),
      minUnits: 1000n,
      chain: new BaseSepoliaReader({ fetch: rpc.fetchFn }),
      fetch: (() => {
        vendorCalls += 1;
        return Promise.reject(new Error("no"));
      }) as typeof fetch,
    });
    await rail.lookup(settled.key, { reservedAt: new Date(settled.reserved_at) });
    expect(vendorCalls).toBe(0);
    expect(new Set(rpc.methods)).toEqual(new Set(["eth_chainId", "eth_call", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionReceipt"]));
  });
});
