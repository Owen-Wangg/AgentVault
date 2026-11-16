import { createHash } from "node:crypto";
import type { PaymentPayload } from "@x402/core/types";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { type Hex, getAddress } from "viem";
import type { LocalAccount } from "viem/accounts";
import { z } from "zod";
import { fromRailUnits, toRailUnits } from "@/core/money";
import { BASE_SEPOLIA } from "../config";
import type { DestinationCheck, RailAdapter, RailContext, RailLookup, RailQuote, RailRequest, RailResult } from "../types";
import { NO_PAYMENT_URL, isPaymentUrl } from "../url";
import { BaseSepoliaReader, type ChainBlock, usdcTransferredFrom } from "./chain";
import { BASE_SEPOLIA_CHAIN_ID, MAX_LOG_BLOCKS, USDC_BASE_SEPOLIA, USDC_EIP712, explorerTxUrl } from "./constants";

/**
 * The x402 payer adapter (rail-adapters design, "x402 adapter"; RAIL-11
 * to RAIL-13, RAIL-21, RAIL-22). It pays a vendor's 402 challenge in Base
 * Sepolia USDC from the agent wallet.
 *
 * The payment is an EIP-3009 `transferWithAuthorization` that the agent
 * signs and the vendor's facilitator submits. The adapter signs it itself
 * instead of through @x402/evm's client, because that client picks a
 * random nonce and expiry, and lookup() needs both later:
 * - nonce = sha256(NONCE_DOMAIN + rail idempotency key), so lookup() can
 *   rebuild it from the reservation ID alone.
 * - validBefore <= reservedAt + AUTHORIZATION_WINDOW_SECONDS, so lookup()
 *   knows a time after which the authorization can never be used.
 *
 * The same key always gives the same nonce, and USDC accepts each nonce
 * once, so two execute() calls with one key can move money at most once
 * (RAIL-3).
 */

export const NONCE_DOMAIN = "agentvault/x402/eip3009-nonce/v1:";
/** The longest an authorization can stay usable, counted from the reservation's creation. */
export const AUTHORIZATION_WINDOW_SECONDS = 300n;
/** Don't sign an authorization with less time left than this: the facilitator needs a few seconds to settle. */
const MIN_SECONDS_LEFT = 30n;
/** Search for a settlement from this long before the reservation, in case the server's clock is behind the chain's. */
const CLOCK_MARGIN_SECONDS = 120n;
const MAX_VENDOR_BODY_BYTES = 64 * 1024;

export function authorizationNonce(idempotencyKey: string): Hex {
  return `0x${createHash("sha256").update(NONCE_DOMAIN + idempotencyKey, "utf8").digest("hex")}`;
}

const unixSeconds = (d: Date): bigint => BigInt(d.getTime()) / 1000n;

/** No authorization for this reservation is valid at or after this unix time. */
export function authorizationDeadline(reservedAt: Date): bigint {
  return unixSeconds(reservedAt) + AUTHORIZATION_WINDOW_SECONDS;
}

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Requirement = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: Address,
  amount: z.string().regex(/^\d{1,30}$/),
  payTo: Address,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).default({}),
});
const Challenge = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string() }).passthrough(),
  accepts: z.array(z.unknown()).min(1),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
const Settlement = z.object({
  success: z.literal(true),
  transaction: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  network: z.literal(BASE_SEPOLIA),
  payer: Address.optional(),
  amount: z.string().regex(/^\d+$/).optional(),
});

type Requirement = z.infer<typeof Requirement>;
type ParsedChallenge = { challenge: z.infer<typeof Challenge>; requirement: Requirement } | { failure: RailResult & { ok: false } };

export interface X402RailOptions {
  account: LocalAccount;
  minUnits: bigint;
  /** For the vendor requests. Tests replay recorded responses through it. */
  fetch?: typeof fetch;
  chain?: BaseSepoliaReader;
  now?: () => Date;
}

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export class X402Rail implements RailAdapter {
  readonly rail = "x402" as const;
  readonly minimumUnits: bigint;
  private readonly account: LocalAccount;
  private readonly fetchFn: typeof fetch;
  private readonly chain: BaseSepoliaReader;
  private readonly now: () => Date;

  constructor(options: X402RailOptions) {
    this.account = options.account;
    this.minimumUnits = options.minUnits;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.chain = options.chain ?? new BaseSepoliaReader();
    this.now = options.now ?? (() => new Date());
  }

  get payer(): Hex {
    return this.account.address;
  }

  /** Read the vendor's price without paying. */
  async quote(req: RailRequest, ctx: RailContext = {}): Promise<RailQuote> {
    const response = await this.fetchFn(req.vendorUrl, { method: "GET", headers: { accept: "application/json" }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const parsed = parseChallenge(response);
    if ("failure" in parsed) throw new Error(`x402 quote failed: ${parsed.failure.code}`);
    const units = BigInt(parsed.requirement.amount);
    return { units, micros: fromRailUnits(units, "x402") };
  }

  async execute(req: RailRequest, ctx: RailContext = {}): Promise<RailResult> {
    const units = toRailUnits(req.approvedMicros, "x402", "debit");
    // RAIL-4: checked before contacting anyone.
    if (units < this.minimumUnits) return { ok: false, code: "BELOW_RAIL_MINIMUM", detail: `minimum is ${this.minimumUnits} units` };
    // Without the reservation time, lookup() could never prove what happened. Nothing has been sent.
    if (!ctx.reservedAt) return { ok: false, code: "RAIL_REJECTED", detail: "no reservation time was given; nothing was signed" };
    if (!isPaymentUrl(req.vendorUrl)) return NO_PAYMENT_URL;
    const init = ctx.signal ? { signal: ctx.signal } : {};

    // 1. The unpaid request. No payment exists yet, so a failure here can't have moved money.
    let unpaid: Response;
    try {
      unpaid = await this.fetchFn(req.vendorUrl, { method: "GET", headers: { accept: "application/json" }, ...init });
    } catch (error) {
      return isAbort(error) ? { ok: false, code: "RAIL_TIMEOUT" } : { ok: false, code: "RAIL_REJECTED", detail: "the vendor could not be reached; nothing was signed" };
    }
    const parsed = parseChallenge(unpaid);
    if ("failure" in parsed) return parsed.failure;
    const { challenge, requirement } = parsed;

    // 2. RAIL-13: pay exactly what the policy approved, or nothing.
    if (BigInt(requirement.amount) !== units) {
      return { ok: false, code: "CHALLENGE_MISMATCH", detail: `the vendor asked for ${requirement.amount} units; ${units} were approved` };
    }

    // 3. Sign an authorization that expires no later than the reservation's deadline.
    const nowSeconds = unixSeconds(this.now());
    const deadline = authorizationDeadline(ctx.reservedAt);
    const byVendor = nowSeconds + BigInt(requirement.maxTimeoutSeconds);
    const validBefore = byVendor < deadline ? byVendor : deadline;
    // RAIL-6: too late to pay safely. Nothing is signed; lookup() proves that once the deadline passes.
    if (validBefore - nowSeconds < MIN_SECONDS_LEFT || ctx.signal?.aborted) return { ok: false, code: "RAIL_TIMEOUT", detail: "the authorization window passed before signing" };
    const authorization = {
      from: this.account.address,
      to: getAddress(requirement.payTo),
      value: units.toString(),
      validAfter: "0",
      validBefore: validBefore.toString(),
      nonce: authorizationNonce(req.idempotencyKey),
    };
    const signature = await this.account.signTypedData({
      domain: { name: USDC_EIP712.name, version: USDC_EIP712.version, chainId: BASE_SEPOLIA_CHAIN_ID, verifyingContract: USDC_BASE_SEPOLIA },
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
      message: {
        from: authorization.from,
        to: authorization.to,
        value: units,
        validAfter: 0n,
        validBefore,
        nonce: authorization.nonce,
      },
    });
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: challenge.resource as { url: string },
      accepted: { ...requirement, network: BASE_SEPOLIA },
      payload: { authorization, signature },
      ...(challenge.extensions ? { extensions: challenge.extensions } : {}),
    };

    // 4. RAIL-11: retry with the payment. From here on, money may have moved,
    // so anything other than a confirmed settlement is an unknown outcome.
    let paid: Response;
    try {
      paid = await this.fetchFn(req.vendorUrl, {
        method: "GET",
        headers: { accept: "application/json", "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
        ...init,
      });
    } catch (error) {
      return isAbort(error) ? { ok: false, code: "RAIL_TIMEOUT" } : { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "network error after the payment was sent" };
    }
    if (!paid.ok) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: `the vendor answered ${paid.status} to the paid request` };
    const header = paid.headers.get("PAYMENT-RESPONSE");
    let settlement: z.infer<typeof Settlement>;
    try {
      settlement = Settlement.parse(decodePaymentResponseHeader(header ?? ""));
    } catch {
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "missing or malformed PAYMENT-RESPONSE header" };
    }
    if (settlement.payer && settlement.payer.toLowerCase() !== this.account.address.toLowerCase()) {
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "the settlement names another payer" };
    }
    if (settlement.amount !== undefined && BigInt(settlement.amount) !== units) {
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "the settlement amount differs from the authorization" };
    }
    // RAIL-12: the transaction hash and its explorer link.
    return {
      ok: true,
      ref: settlement.transaction,
      explorerUrl: explorerTxUrl(settlement.transaction),
      settledMicros: fromRailUnits(units, "x402"),
      vendorBody: await readJsonBody(paid),
    };
  }

  /** x402 has no refunds. Nothing is sent, so this is a confirmed failure. */
  async refund(): Promise<RailResult> {
    return { ok: false, code: "RAIL_REJECTED", detail: "x402 payments can't be refunded" };
  }

  /** payout-rails PO-1: x402 can't pay out. Nothing is signed or sent. */
  async payout(): Promise<RailResult> {
    return { ok: false, code: "RAIL_REJECTED", detail: "x402 can't pay out; nothing was signed" };
  }

  /** PO-1: x402 has no payout destinations. Nothing is sent. */
  async checkDestination(): Promise<DestinationCheck> {
    return { ok: false, code: "RAIL_REJECTED", detail: "x402 can't pay out" };
  }

  /**
   * RAIL-21: what happened to the authorization for this key. RAIL-22:
   * only reads the chain. Errors are thrown; the reconciler treats them as
   * unknown.
   * - settled: the nonce is used, and its AuthorizationUsed log and USDC
   *   Transfer were found.
   * - failed: the nonce is unused at the finalized block, and that block
   *   is at or past the deadline. Every later block is too, so the
   *   authorization can never be used.
   * - unknown: anything else, including no reservation time.
   */
  async lookup(idempotencyKey: string, ctx: RailContext = {}): Promise<RailLookup> {
    if (!ctx.reservedAt) return { status: "unknown" };
    const { signal } = ctx;
    const nonce = authorizationNonce(idempotencyKey);
    const deadline = authorizationDeadline(ctx.reservedAt);
    const payer = this.account.address;

    if (await this.chain.authorizationUsed(payer, nonce, "latest", signal)) {
      const found = await this.findSettlement(nonce, unixSeconds(ctx.reservedAt) - CLOCK_MARGIN_SECONDS, deadline, signal);
      return found ?? { status: "unknown" };
    }
    const finalized = await this.chain.block("finalized", signal);
    if (finalized.timestamp < deadline) return { status: "unknown" };
    // The proof: unused in the finalized state itself, not only at whatever block "latest" was.
    if (await this.chain.authorizationUsed(payer, nonce, finalized.number, signal)) return { status: "unknown" };
    return { status: "failed", code: "RAIL_REJECTED" };
  }

  private async findSettlement(nonce: Hex, from: bigint, to: bigint, signal?: AbortSignal): Promise<RailLookup | null> {
    const latest = await this.chain.block("latest", signal);
    const first = await this.firstBlockAtOrAfter(from, latest, signal);
    const last = latest.timestamp < to ? latest.number : await this.firstBlockAtOrAfter(to, latest, signal);
    for (let start = first; start <= last; start += MAX_LOG_BLOCKS) {
      const end = start + MAX_LOG_BLOCKS - 1n < last ? start + MAX_LOG_BLOCKS - 1n : last;
      const [log] = await this.chain.authorizationUsedLogs(this.account.address, nonce, start, end, signal);
      if (!log) continue;
      const receipt = await this.chain.receipt(log.transactionHash as Hex, signal);
      if (!receipt || receipt.status !== "0x1") return null;
      const [transfer, ...more] = usdcTransferredFrom(receipt, this.account.address);
      if (!transfer || more.length > 0) return null;
      return { status: "settled", ref: log.transactionHash, explorerUrl: explorerTxUrl(log.transactionHash), settledMicros: fromRailUnits(transfer.value, "x402") };
    }
    return null;
  }

  /** The first block with timestamp >= t. Starts from an estimate of the block rate, then gallops and bisects. */
  private async firstBlockAtOrAfter(t: bigint, latest: ChainBlock, signal?: AbortSignal): Promise<bigint> {
    if (latest.timestamp < t) return latest.number;
    const sample = latest.number > 10_000n ? await this.chain.block(latest.number - 10_000n, signal) : null;
    const span = sample ? latest.timestamp - sample.timestamp : 0n;
    const guess = sample && span > 0n ? latest.number - ((latest.timestamp - t) * 10_000n) / span : latest.number;
    // Invariant: block `lo` is before t (-1 means "before block 0"), block `hi` is at or after t.
    let lo = -1n;
    let hi = latest.number;
    const probe = guess < 0n ? 0n : guess > latest.number ? latest.number : guess;
    let step = 64n;
    if ((await this.chain.block(probe, signal)).timestamp >= t) {
      hi = probe;
      for (;;) {
        const p = hi - step;
        if (p < 0n) break;
        if ((await this.chain.block(p, signal)).timestamp < t) {
          lo = p;
          break;
        }
        hi = p;
        step *= 2n;
      }
    } else {
      lo = probe;
      for (;;) {
        const p = lo + step;
        if (p >= hi) break;
        if ((await this.chain.block(p, signal)).timestamp >= t) {
          hi = p;
          break;
        }
        lo = p;
        step *= 2n;
      }
    }
    while (hi - lo > 1n) {
      const mid = lo + (hi - lo) / 2n;
      const b = await this.chain.block(mid, signal);
      if (b.timestamp >= t) hi = mid;
      else lo = mid;
    }
    return hi;
  }
}

/** RAIL-5, RAIL-10: the vendor's 402 challenge, or a typed failure. Called before anything is signed. */
function parseChallenge(response: Response): ParsedChallenge {
  if (response.status !== 402) return { failure: { ok: false, code: "RAIL_REJECTED", detail: `the vendor answered ${response.status} instead of 402; nothing was signed` } };
  const header = response.headers.get("PAYMENT-REQUIRED");
  let challenge: z.infer<typeof Challenge>;
  try {
    challenge = Challenge.parse(decodePaymentRequiredHeader(header ?? ""));
  } catch {
    return { failure: { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "missing or malformed PAYMENT-REQUIRED header" } };
  }
  const options = challenge.accepts.map((a) => Requirement.safeParse(a)).flatMap((r) => (r.success ? [r.data] : []));
  const requirement = options.find((r) => r.scheme === "exact" && r.network === BASE_SEPOLIA && r.asset.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase());
  if (!requirement) return { failure: { ok: false, code: "CHALLENGE_MISMATCH", detail: "the vendor offers no exact Base Sepolia USDC payment" } };
  const { name, version, assetTransferMethod } = requirement.extra as { name?: unknown; version?: unknown; assetTransferMethod?: unknown };
  if (name !== USDC_EIP712.name || version !== USDC_EIP712.version || (assetTransferMethod !== undefined && assetTransferMethod !== "eip3009")) {
    return { failure: { ok: false, code: "CHALLENGE_MISMATCH", detail: "the challenge's token details don't match Base Sepolia USDC" } };
  }
  return { challenge, requirement };
}

async function readJsonBody(response: Response): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  try {
    const text = await response.text();
    return text.length > MAX_VENDOR_BODY_BYTES ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}
