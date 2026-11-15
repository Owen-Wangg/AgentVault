import { readFileSync } from "node:fs";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import type { BaseSepoliaReader, ChainBlock } from "./chain";
import { USDC_BASE_SEPOLIA } from "./constants";

// ---------------------------------------------------------------------------
// A synthetic vendor, for unit and property tests
// ---------------------------------------------------------------------------

export const PAY_TO = "0xd745eC24ec60c187Ae5e37be344BB8215eC2cb8b";
export const VENDOR_URL = "https://vendor.example/vendor/api/weather";
export const TX = `0x${"ab".repeat(32)}`;

/** A 402 challenge in the shape the recorded CDP-backed vendor sends, for `amount` units. */
export function challenge(amount: bigint, over: Partial<PaymentRequired["accepts"][number]> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: VENDOR_URL },
    accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC_BASE_SEPOLIA, amount: amount.toString(), payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" }, ...over }],
  };
}

interface VendorScript {
  unpaid?: () => Response;
  paid?: (signatureHeader: string) => Response;
}

/** A vendor that charges `amount` and settles every paid request, unless the script says otherwise. */
export function fakeVendor(amount: bigint, script: VendorScript = {}) {
  const requests: { paid: boolean; signature: string | null }[] = [];
  const fetchFn = (async (_url: string, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const signature = new Headers(init.headers).get("PAYMENT-SIGNATURE");
    requests.push({ paid: signature !== null, signature });
    if (signature === null) return script.unpaid?.() ?? new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(amount)) } });
    if (script.paid) return script.paid(signature);
    const payer = (decodePaymentSignatureHeader(signature).payload as { authorization: { from: string } }).authorization.from;
    return Response.json({ ok: true }, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: TX, network: "eip155:84532", payer }) } });
  }) as typeof fetch;
  return { fetchFn, requests };
}

export interface FakeChainState {
  payer: string;
  latestTs: bigint;
  finalizedTs: bigint;
  /** When the authorization was used, if it was. */
  usedAt?: bigint;
  /** The nonce that was used. Unset: any nonce counts as that one. */
  nonce?: string;
  /** false: the nonce is used but its AuthorizationUsed log can't be found. */
  logs?: boolean;
  transfer?: bigint;
}

/**
 * A chain where blocks come every 0.2 s, like Base Sepolia, and the
 * authorization is used (or not) at `usedAt`. The state is read on every
 * call, so a test can move the chain forward by changing it.
 */
export function fakeChain(opts: FakeChainState) {
  const t0 = 1_700_000_000n;
  const blockAt = (n: bigint): ChainBlock => ({ number: n, timestamp: t0 + n / 5n, hash: `0x${"00".repeat(32)}` });
  const numberAt = (ts: bigint) => (ts - t0) * 5n;
  const latestBlock = () => blockAt(numberAt(opts.latestTs));
  const finalizedBlock = () => blockAt(numberAt(opts.finalizedTs));
  const usedBlockOf = () => (opts.usedAt === undefined ? null : numberAt(opts.usedAt));
  // Only the payer's authorization with the used nonce reads as used, so a wrong nonce or authorizer shows up.
  const isOurs = (authorizer: string, nonce: string) => authorizer.toLowerCase() === opts.payer.toLowerCase() && (opts.nonce === undefined || nonce === opts.nonce);
  const calls: string[] = [];
  const chain = {
    async block(at: "latest" | "finalized" | bigint) {
      calls.push("block");
      return at === "latest" ? latestBlock() : at === "finalized" ? finalizedBlock() : blockAt(at);
    },
    async authorizationUsed(a: string, nonce: string, at: "latest" | "finalized" | bigint) {
      calls.push("authorizationUsed");
      const n = at === "latest" ? latestBlock().number : at === "finalized" ? finalizedBlock().number : at;
      const usedBlock = usedBlockOf();
      return usedBlock !== null && n >= usedBlock && isOurs(a, nonce);
    },
    async authorizationUsedLogs(a: string, nonce: string, from: bigint, to: bigint) {
      calls.push("logs");
      if (to - from + 1n > 200n) throw new Error("range too large");
      const usedBlock = usedBlockOf();
      return usedBlock !== null && opts.logs !== false && isOurs(a, nonce) && usedBlock >= from && usedBlock <= to
        ? [{ address: USDC_BASE_SEPOLIA, topics: [], data: "0x", blockNumber: usedBlock, transactionHash: TX }]
        : [];
    },
    async receipt() {
      calls.push("receipt");
      const usedBlock = usedBlockOf();
      const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
      return {
        status: "0x1" as const,
        transactionHash: TX,
        blockNumber: usedBlock ?? 0n,
        logs: [
          {
            address: USDC_BASE_SEPOLIA,
            topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(opts.payer), pad(PAY_TO)],
            data: `0x${(opts.transfer ?? 1500n).toString(16).padStart(64, "0")}`,
            blockNumber: usedBlock ?? 0n,
            transactionHash: TX,
          },
        ],
      };
    },
  };
  return { chain: chain as unknown as BaseSepoliaReader, calls };
}


// ---------------------------------------------------------------------------
// Recorded exchanges
// ---------------------------------------------------------------------------

/**
 * Replays the exchanges `pnpm x402:probe --record` captured on Base Sepolia
 * (src/rails/__fixtures__/x402/), so contract tests run the adapter
 * against what the CDP facilitator and the public RPC really answered,
 * without the network. The recordings hold public on-chain data only:
 * addresses, a signature, and transaction hashes.
 */

interface RecordedHttp {
  request: { url: string; payment_signature: Record<string, unknown> | null };
  response: { status: number; content_type: string | null; payment_required: PaymentRequired | null; payment_response: SettleResponse | null; body: string };
}
interface RecordedRpc {
  request: { method: string; params: unknown[] };
  response: { status: number; json: { result?: unknown; error?: unknown } };
}
export interface Recording {
  key: string;
  reserved_at: string;
  price_units: string;
  payer: `0x${string}`;
  pay_to: `0x${string}`;
  http: RecordedHttp[];
  rpc: RecordedRpc[];
}
export interface LookupRecording {
  key: string;
  reserved_at: string;
  payer: `0x${string}`;
  result: unknown;
  rpc: RecordedRpc[];
}

export function loadRecording<T = Recording>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/x402/${name}`, import.meta.url), "utf8")) as T;
}

/**
 * A vendor that answers each request with the next recorded response.
 * `payer` replaces the payer in the recorded settlement, for tests that
 * sign with a test key instead of the recorded wallet's.
 */
export function replayVendor(recording: Recording, options: { payer?: string } = {}) {
  const sent: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const recorded = recording.http[sent.length];
    sent.push({ url, headers: new Headers(init.headers) });
    if (!recorded) throw new Error("no more recorded vendor responses");
    const headers = new Headers();
    if (recorded.response.content_type) headers.set("content-type", recorded.response.content_type);
    if (recorded.response.payment_required) headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(recorded.response.payment_required));
    if (recorded.response.payment_response) {
      const settled = options.payer ? { ...recorded.response.payment_response, payer: options.payer } : recorded.response.payment_response;
      headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled));
    }
    return new Response(recorded.response.body, { status: recorded.response.status, headers });
  }) as typeof fetch;
  return { fetchFn, sent };
}

/** A JSON-RPC endpoint that answers only requests the recording contains (same method and params). */
export function replayRpc(exchanges: readonly RecordedRpc[]) {
  const methods: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    methods.push(body.method);
    const match = exchanges.find((e) => e.request.method === body.method && JSON.stringify(e.request.params) === JSON.stringify(body.params));
    if (!match) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: `not recorded: ${body.method}` } });
    return Response.json({ ...match.response.json, jsonrpc: "2.0", id: body.id }, { status: match.response.status });
  }) as typeof fetch;
  return { fetchFn, methods };
}
