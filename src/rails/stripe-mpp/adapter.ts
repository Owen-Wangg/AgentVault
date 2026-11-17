import { Challenge, Credential, Receipt } from "mppx";
import { z } from "zod";
import { fromRailUnits, toRailUnits } from "@/core/money";
import type { DestinationCheck, PayoutRequest, RailAdapter, RailContext, RailLookup, RailQuote, RailRequest, RailResult, RefundRequest } from "../types";
import { NO_PAYMENT_URL, isPaymentUrl } from "../url";
import { STRIPE_SPT_MINIMUM_CENTS, stripeDashboardUrl } from "./constants";
import type { StripeConnectPayouts } from "./payouts";
import { type StripeApi, StripeApiError, StripeResponseError } from "./stripe-api";

/**
 * The Stripe MPP payer adapter (rail-adapters design, "Stripe MPP
 * adapter"; RAIL-15 to RAIL-17, RAIL-21, RAIL-22). It pays a vendor's MPP
 * challenge with a card through a Shared Payment Token (SPT), and refunds
 * through Stripe's Refunds API. Test mode only: the SPT comes from
 * Stripe's test helper, backed by the test Visa card, and is granted to
 * this account's own Stripe profile, so the vendor must be this account.
 *
 * - The SPT is created with a Stripe idempotency key derived from the
 *   rail idempotency key, and with parameters derived only from the key,
 *   the approved amount, and the reservation time. A second execute()
 *   with the same key gets the same SPT back, and an SPT is single-use
 *   up to `max_amount`, so one key can pay at most once (RAIL-3).
 * - The credential's `externalId` is the rail idempotency key. The demo
 *   vendor copies it into the PaymentIntent's `metadata.idempotency_key`,
 *   which is how lookup() finds the payment. Refunds carry the same
 *   metadata, set by this adapter.
 */

const SPT_PATH = "/v1/test_helpers/shared_payment/granted_tokens";
/** Stripe's test card, as a PaymentMethod. */
export const TEST_PAYMENT_METHOD = "pm_card_visa";
/** How long an SPT stays usable, counted from the reservation's creation. */
export const SPT_WINDOW_SECONDS = 600n;
/** Don't create an SPT with less time left than this. */
const MIN_SECONDS_LEFT = 60n;
/** Search for payments and refunds from this long before the reservation, in case the clocks differ. */
const CLOCK_MARGIN_SECONDS = 120n;
/** Pages of 100 lookup() reads before giving up as unknown. */
const MAX_LIST_PAGES = 10;
const MAX_VENDOR_BODY_BYTES = 64 * 1024;

export const sptIdempotencyKey = (key: string) => `agentvault-spt-v1:${key}`;
export const refundIdempotencyKey = (key: string) => `agentvault-refund-v1:${key}`;

const unixSeconds = (d: Date): bigint => BigInt(d.getTime()) / 1000n;

/** The SPT for this reservation expires at this unix time. Derived from the reservation, so retries send identical parameters. */
export function sptExpiresAt(reservedAt: Date): bigint {
  return unixSeconds(reservedAt) + SPT_WINDOW_SECONDS;
}

const ChargeRequest = z.object({
  amount: z.string().regex(/^\d{1,18}$/),
  currency: z.string(),
  methodDetails: z.object({ networkId: z.string(), paymentMethodTypes: z.array(z.string()) }),
});
const Spt = z.object({
  id: z.string().regex(/^spt_\w+$/),
  livemode: z.literal(false),
  usage_limits: z.object({ currency: z.string(), max_amount: z.number().int() }),
});
const PaymentReceipt = z.object({ method: z.literal("stripe"), status: z.literal("success"), reference: z.string().regex(/^pi_\w+$/) });
const Refund = z.object({
  id: z.string().regex(/^re_\w+$/),
  object: z.literal("refund"),
  amount: z.number().int().nonnegative(),
  status: z.string().nullable(),
  payment_intent: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable().default({}),
});
const PaymentIntent = z.object({
  id: z.string().regex(/^pi_\w+$/),
  object: z.literal("payment_intent"),
  status: z.string(),
  amount_received: z.number().int().nonnegative(),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()).nullable().default({}),
});
const List = <T extends z.ZodTypeAny>(item: T) => z.object({ object: z.literal("list"), data: z.array(item), has_more: z.boolean() });

type ParsedChallenge = { challenge: Challenge.Challenge; units: bigint } | { failure: RailResult & { ok: false } };

export interface StripeMppRailOptions {
  /** Stripe test mode, through the account's sk_test_ key. */
  api: StripeApi;
  /** The account's own Stripe profile. The test helper's SPTs can only pay this profile. */
  profileId: string;
  /** For the vendor requests. Tests replay recorded responses through it. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Stripe Connect payouts (payout-rails task 5). Without it, payout() and checkDestination() refuse without a call. */
  payouts?: StripeConnectPayouts;
}

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

export class StripeMppRail implements RailAdapter {
  readonly rail = "stripe" as const;
  readonly minimumUnits = STRIPE_SPT_MINIMUM_CENTS;
  private readonly api: StripeApi;
  private readonly profileId: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly payouts: StripeConnectPayouts | undefined;

  constructor(options: StripeMppRailOptions) {
    this.payouts = options.payouts;
    this.api = options.api;
    this.profileId = options.profileId;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** Read the vendor's price without paying. */
  async quote(req: RailRequest, ctx: RailContext = {}): Promise<RailQuote> {
    const response = await this.fetchFn(req.vendorUrl, { method: "GET", headers: { accept: "application/json" }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const parsed = this.parseChallenge(response);
    if ("failure" in parsed) throw new Error(`MPP quote failed: ${parsed.failure.code}`);
    return { units: parsed.units, micros: fromRailUnits(parsed.units, "stripe") };
  }

  async execute(req: RailRequest, ctx: RailContext = {}): Promise<RailResult> {
    // Debits round up to the cent (MON-8). RAIL-4: the minimum is checked before contacting anyone.
    const units = toRailUnits(req.approvedMicros, "stripe", "debit");
    if (units < this.minimumUnits) return { ok: false, code: "BELOW_RAIL_MINIMUM", detail: `minimum is ${this.minimumUnits} cents` };
    // The SPT's expiry comes from the reservation time, so retries send identical parameters. Nothing has been sent.
    if (!ctx.reservedAt) return { ok: false, code: "RAIL_REJECTED", detail: "no reservation time was given; nothing was sent" };
    if (!isPaymentUrl(req.vendorUrl)) return NO_PAYMENT_URL;
    const init = ctx.signal ? { signal: ctx.signal } : {};

    // 1. The unpaid request. No SPT exists yet, so a failure here can't have moved money.
    let unpaid: Response;
    try {
      unpaid = await this.fetchFn(req.vendorUrl, { method: "GET", headers: { accept: "application/json" }, ...init });
    } catch (error) {
      return isAbort(error) ? { ok: false, code: "RAIL_TIMEOUT" } : { ok: false, code: "RAIL_REJECTED", detail: "the vendor could not be reached; nothing was sent" };
    }
    const parsed = this.parseChallenge(unpaid);
    if ("failure" in parsed) return parsed.failure;
    const { challenge } = parsed;

    // 2. Pay exactly what the policy approved, or nothing (the RAIL-13 rule, applied to MPP).
    if (parsed.units !== units) return { ok: false, code: "CHALLENGE_MISMATCH", detail: `the vendor asked for ${parsed.units} cents; ${units} were approved` };

    // 3. RAIL-15: a test SPT scoped to the approved amount, for this reservation only.
    const expiresAt = sptExpiresAt(ctx.reservedAt);
    if (expiresAt - unixSeconds(this.now()) < MIN_SECONDS_LEFT || ctx.signal?.aborted) {
      return { ok: false, code: "RAIL_TIMEOUT", detail: "the SPT window passed before an SPT was created" };
    }
    let spt: string;
    try {
      const token = Spt.parse(
        await this.api.post(
          SPT_PATH,
          {
            payment_method: TEST_PAYMENT_METHOD,
            "usage_limits[currency]": "usd",
            "usage_limits[max_amount]": units.toString(),
            "usage_limits[expires_at]": expiresAt.toString(),
          },
          { idempotencyKey: sptIdempotencyKey(req.idempotencyKey), ...init },
        ),
      );
      if (BigInt(token.usage_limits.max_amount) !== units || token.usage_limits.currency !== "usd") {
        return { ok: false, code: "RAIL_REJECTED", detail: "the SPT's limits differ from the approved amount; it was not presented" };
      }
      spt = token.id;
    } catch (error) {
      // The SPT never left this process, so no payment can have happened.
      if (isAbort(error)) return { ok: false, code: "RAIL_TIMEOUT", detail: "timed out creating the SPT; nothing was presented" };
      return { ok: false, code: "RAIL_REJECTED", detail: `the SPT could not be created${error instanceof StripeApiError ? ` (${error.code ?? error.type ?? error.status})` : ""}; nothing was presented` };
    }

    // 4. Present the SPT. From here on, money may have moved, so anything
    // short of a well-formed success receipt is an unknown outcome.
    const credential = Credential.serialize({ challenge, payload: { spt, externalId: req.idempotencyKey } });
    let paid: Response;
    try {
      paid = await this.fetchFn(req.vendorUrl, { method: "GET", headers: { accept: "application/json", [Challenge.credentialHeader(challenge)]: credential }, ...init });
    } catch (error) {
      return isAbort(error) ? { ok: false, code: "RAIL_TIMEOUT" } : { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "network error after the SPT was presented" };
    }
    if (!paid.ok) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: `the vendor answered ${paid.status} to the paid request` };
    let receipt: z.infer<typeof PaymentReceipt>;
    try {
      receipt = PaymentReceipt.parse(Receipt.fromResponse(paid));
    } catch {
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "missing or malformed Payment-Receipt header" };
    }
    // RAIL-16: the PaymentIntent ID.
    return {
      ok: true,
      ref: receipt.reference,
      explorerUrl: stripeDashboardUrl(receipt.reference),
      settledMicros: fromRailUnits(units, "stripe"),
      vendorBody: await readJsonBody(paid),
    };
  }

  /**
   * RAIL-17: a test-mode refund through the Refunds API, with a Stripe
   * idempotency key and `metadata.idempotency_key`, both from the rail
   * idempotency key. Credits round down to the cent (MON-8).
   */
  async refund(req: RefundRequest, ctx: RailContext = {}): Promise<RailResult> {
    if (!/^pi_\w+$/.test(req.paymentRef)) return { ok: false, code: "RAIL_REJECTED", detail: "the payment reference is not a Stripe PaymentIntent; nothing was sent" };
    const cents = toRailUnits(req.amountMicros, "stripe", "credit");
    if (cents < 1n) return { ok: false, code: "BELOW_RAIL_MINIMUM", detail: "a refund must be at least 1 cent" };
    let refund: z.infer<typeof Refund>;
    try {
      refund = Refund.parse(
        await this.api.post(
          "/v1/refunds",
          { payment_intent: req.paymentRef, amount: cents.toString(), "metadata[idempotency_key]": req.idempotencyKey },
          { idempotencyKey: refundIdempotencyKey(req.idempotencyKey), ...(ctx.signal ? { signal: ctx.signal } : {}) },
        ),
      );
    } catch (error) {
      if (isAbort(error)) return { ok: false, code: "RAIL_TIMEOUT" };
      // Stripe documents that a 4xx changed nothing. A 409 is a concurrent request with the same key, which may succeed.
      if (error instanceof StripeApiError && error.status >= 400 && error.status < 500 && error.status !== 409) {
        return { ok: false, code: "RAIL_REJECTED", detail: `Stripe refused the refund (${error.code ?? error.type ?? error.status})` };
      }
      if (error instanceof StripeApiError || error instanceof StripeResponseError || error instanceof z.ZodError) {
        return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "Stripe's answer to the refund didn't prove an outcome" };
      }
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "network error after the refund was sent" };
    }
    return refundResult(refund);
  }

  /**
   * payout-rails PO-5 to PO-7: a Stripe Connect transfer, through the
   * `payouts` option. Without it this refuses without contacting Stripe,
   * so a payout fails closed.
   */
  async payout(req: PayoutRequest, ctx: RailContext = {}): Promise<RailResult> {
    if (!this.payouts) return { ok: false, code: "RAIL_REJECTED", detail: "Stripe Connect payouts aren't configured; nothing was sent" };
    return this.payouts.payout(req, ctx);
  }

  /** PO-6, PO-11: the Accounts v2 capability check, or a refusal without a call when payouts aren't configured. */
  async checkDestination(destination: string, ctx: RailContext = {}): Promise<DestinationCheck> {
    if (!this.payouts) return { ok: false, code: "RAIL_REJECTED", detail: "Stripe Connect payouts aren't configured" };
    return this.payouts.checkDestination(destination, ctx);
  }

  /**
   * RAIL-21: what happened to the payout, payment, or refund for this key.
   * RAIL-22: only lists objects. Errors are thrown; the reconciler treats
   * them as unknown.
   * - With Connect payouts configured, transfers in the key's
   *   transfer_group come first (PO-8).
   * - Refunds and PaymentIntents created around the reservation are
   *   listed, and matched on `metadata.idempotency_key`. List endpoints,
   *   unlike search, reflect writes at once.
   * - settled: a succeeded PaymentIntent, or a succeeded or pending refund.
   * - failed: only a refund Stripe marked failed or canceled.
   * - unknown: anything else, including nothing found. Absence proves
   *   nothing: the vendor writes the PaymentIntent's metadata, and a
   *   vendor that didn't could still have charged the SPT.
   */
  async lookup(idempotencyKey: string, ctx: RailContext = {}): Promise<RailLookup> {
    // PO-8: a payout is found by its transfer_group, with no time window. No transfer means the key isn't a payout.
    if (this.payouts) {
      const transfer = await this.payouts.lookup(idempotencyKey, ctx);
      if (transfer) return transfer;
    }
    if (!ctx.reservedAt) return { status: "unknown" };
    const from = unixSeconds(ctx.reservedAt) - CLOCK_MARGIN_SECONDS;
    const to = sptExpiresAt(ctx.reservedAt) + CLOCK_MARGIN_SECONDS;
    const ours = (o: { metadata: Record<string, string> | null }) => o.metadata?.idempotency_key === idempotencyKey;

    const refunds = await this.listAll("/v1/refunds", Refund, from, to, ctx.signal);
    if (refunds === null) return { status: "unknown" };
    const refund = refunds.filter(ours);
    if (refund.length > 1) return { status: "unknown" };
    if (refund[0]) {
      const result = refundResult(refund[0]);
      if (result.ok) return { status: "settled", ref: result.ref, explorerUrl: stripeDashboardUrl(result.ref), settledMicros: result.settledMicros };
      return result.code === "RAIL_REJECTED" ? { status: "failed", code: "RAIL_REJECTED" } : { status: "unknown" };
    }

    const intents = await this.listAll("/v1/payment_intents", PaymentIntent, from, to, ctx.signal);
    if (intents === null) return { status: "unknown" };
    const matching = intents.filter(ours);
    const succeeded = matching.filter((pi) => pi.status === "succeeded" && !pi.livemode);
    if (succeeded.length !== 1 || !succeeded[0]) return { status: "unknown" };
    const pi = succeeded[0];
    return { status: "settled", ref: pi.id, explorerUrl: stripeDashboardUrl(pi.id), settledMicros: fromRailUnits(BigInt(pi.amount_received), "stripe") };
  }

  /** Every object created in [from, to], or null if there are more than MAX_LIST_PAGES pages. */
  private async listAll<T extends z.ZodTypeAny>(path: string, item: T, from: bigint, to: bigint, signal?: AbortSignal): Promise<z.infer<T>[] | null> {
    const out: z.infer<T>[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params: Record<string, string> = { "created[gte]": from.toString(), "created[lte]": to.toString(), limit: "100" };
      if (after) params.starting_after = after;
      const list = List(item).parse(await this.api.get(path, params, signal ? { signal } : {}));
      out.push(...(list.data as z.infer<T>[]));
      if (!list.has_more) return out;
      after = (list.data.at(-1) as { id: string } | undefined)?.id;
      if (!after) return null;
    }
    return null;
  }

  /** The vendor's MPP challenge, or a typed failure. Called before anything is created. */
  private parseChallenge(response: Response): ParsedChallenge {
    if (response.status !== 402) return { failure: { ok: false, code: "RAIL_REJECTED", detail: `the vendor answered ${response.status} instead of 402; nothing was sent` } };
    let challenges: Challenge.Challenge[];
    try {
      challenges = Challenge.fromResponseList(response);
    } catch {
      return { failure: { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "missing or malformed WWW-Authenticate: Payment challenge" } };
    }
    const offers = challenges.filter((c) => c.method === "stripe" && c.intent === "charge");
    const [challenge] = offers;
    if (!challenge || offers.length > 1) return { failure: { ok: false, code: "CHALLENGE_MISMATCH", detail: "the vendor offers no single Stripe card charge" } };
    const request = ChargeRequest.safeParse(challenge.request);
    if (!request.success) return { failure: { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "the Stripe challenge's request is malformed" } };
    const { currency, methodDetails } = request.data;
    if (currency !== "usd" || methodDetails.networkId !== this.profileId || !methodDetails.paymentMethodTypes.includes("card")) {
      return { failure: { ok: false, code: "CHALLENGE_MISMATCH", detail: "the challenge isn't a USD card charge to this account's Stripe profile" } };
    }
    return { challenge, units: BigInt(request.data.amount) };
  }
}

function refundResult(refund: z.infer<typeof Refund>): RailResult {
  if (refund.status === "succeeded" || refund.status === "pending") {
    // Pending counts as settled: the money stays counted, and Stripe completes or fails it on its own.
    return { ok: true, ref: refund.id, explorerUrl: stripeDashboardUrl(refund.id), settledMicros: fromRailUnits(BigInt(refund.amount), "stripe") };
  }
  if (refund.status === "failed" || refund.status === "canceled") return { ok: false, code: "RAIL_REJECTED", detail: `the refund ${refund.status}` };
  return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: `the refund is ${refund.status ?? "in an unknown state"}` };
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
