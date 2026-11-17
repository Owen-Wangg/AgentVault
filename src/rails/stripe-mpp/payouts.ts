import { z } from "zod";
import { fromRailUnits, toRailUnits } from "@/core/money";
import { isDestinationFor } from "../destination";
import type { DestinationCheck, PayoutRequest, RailContext, RailLookup, RailResult } from "../types";
import { CONNECT_API_VERSION, STRIPE_TRANSFER_MINIMUM_CENTS, stripeDashboardUrl } from "./constants";
import { type StripeApi, StripeApiError, StripeResponseError } from "./stripe-api";

/**
 * Stripe Connect payouts in test mode (payout-rails design, "Stripe
 * Connect adapter"; PO-5 to PO-9). The platform sends money from its own
 * balance to a recipient account with a v1 Transfer, after reading the
 * account through Accounts v2. StripeMppRail delegates its payout(),
 * checkDestination(), and the payout part of lookup() here, since
 * railFor() returns one adapter per rail.
 *
 * - One reservation, one transfer: the Stripe idempotency key, the
 *   `transfer_group`, and `metadata.idempotency_key` all come from the
 *   reservation ID (PO-5, PO-7).
 * - Anything after the transfer request was sent that doesn't prove a
 *   result is unknown, so the reservation stays counted.
 */

export const transferIdempotencyKey = (key: string) => `agentvault-transfer-v1:${key}`;

const CONNECT = { apiVersion: CONNECT_API_VERSION };

const Account = z.object({
  id: z.string().regex(/^acct_\w+$/),
  object: z.literal("v2.core.account"),
  livemode: z.boolean(),
  closed: z.boolean().nullish(),
  configuration: z
    .object({
      recipient: z
        .object({
          capabilities: z
            .object({ stripe_balance: z.object({ stripe_transfers: z.object({ status: z.string() }).nullish() }).nullish() })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const Transfer = z.object({
  id: z.string().regex(/^tr_\w+$/),
  object: z.literal("transfer"),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  destination: z.string().nullable(),
  livemode: z.boolean(),
  reversed: z.boolean(),
  transfer_group: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable().default({}),
});
type Transfer = z.infer<typeof Transfer>;
const TransferList = z.object({ object: z.literal("list"), data: z.array(Transfer), has_more: z.boolean() });

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
const errorLabel = (error: StripeApiError) => error.code ?? error.type ?? String(error.status);

export class StripeConnectPayouts {
  readonly minimumUnits = STRIPE_TRANSFER_MINIMUM_CENTS;

  constructor(private readonly api: StripeApi) {}

  /**
   * PO-6, PO-9, PO-11: the account exists in test mode, isn't closed, and
   * can receive transfers. Read-only: one GET.
   */
  async checkDestination(destination: string, ctx: RailContext = {}): Promise<DestinationCheck> {
    if (!isDestinationFor("stripe", destination)) return { ok: false, code: "RAIL_REJECTED", detail: "not a Stripe account ID; nothing was sent" };
    let account: z.infer<typeof Account>;
    try {
      // API v2 repeats list parameters rather than indexing them; this one has a single value.
      account = Account.parse(
        await this.api.get(`/v2/core/accounts/${encodeURIComponent(destination)}`, { include: "configuration.recipient" }, { ...CONNECT, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
      );
    } catch (error) {
      if (isAbort(error)) return { ok: false, code: "RAIL_TIMEOUT", detail: "timed out reading the account" };
      if (error instanceof StripeApiError) {
        if (error.status >= 500) return { ok: false, code: "RAIL_TIMEOUT", detail: `Stripe answered ${error.status} reading the account` };
        return { ok: false, code: "RAIL_REJECTED", detail: `Stripe refused the account read (${errorLabel(error)})` };
      }
      if (error instanceof StripeResponseError || error instanceof z.ZodError) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "the account read was unreadable" };
      return { ok: false, code: "RAIL_TIMEOUT", detail: "network error reading the account" };
    }
    // PO-9 and security-standards §7: a live-mode object is an invalid response.
    if (account.livemode) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "Stripe returned a live-mode account" };
    if (account.id !== destination) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "Stripe returned a different account" };
    if (account.closed) return { ok: false, code: "RAIL_REJECTED", detail: "the account is closed" };
    const status = account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
    if (status !== "active") return { ok: false, code: "RAIL_REJECTED", detail: `the account's stripe_transfers capability is ${status ?? "not requested"}` };
    return { ok: true };
  }

  /**
   * PO-5 to PO-7, PO-9: check the account, then one USD Transfer, rounded
   * down to the cent for the payee (PO-3), under an idempotency key
   * derived from the reservation.
   */
  async payout(req: PayoutRequest, ctx: RailContext = {}): Promise<RailResult> {
    const cents = toRailUnits(req.amountMicros, "stripe", "credit");
    if (cents < this.minimumUnits) return { ok: false, code: "BELOW_RAIL_MINIMUM", detail: `a transfer must be at least ${this.minimumUnits} cent` };

    // PO-6: only a GET has run if this fails, so no money can have moved.
    const check = await this.checkDestination(req.destination, ctx);
    if (!check.ok) return { ok: false, code: "RAIL_REJECTED", detail: `${check.detail ?? check.code}; nothing was sent` };
    if (ctx.signal?.aborted) return { ok: false, code: "RAIL_REJECTED", detail: "the rail timeout passed before the transfer was sent; nothing was sent" };

    let transfer: Transfer;
    try {
      transfer = Transfer.parse(
        await this.api.post(
          "/v1/transfers",
          {
            amount: cents.toString(),
            currency: "usd",
            destination: req.destination,
            transfer_group: req.idempotencyKey,
            "metadata[idempotency_key]": req.idempotencyKey,
          },
          { ...CONNECT, idempotencyKey: transferIdempotencyKey(req.idempotencyKey), ...(ctx.signal ? { signal: ctx.signal } : {}) },
        ),
      );
    } catch (error) {
      if (isAbort(error)) return { ok: false, code: "RAIL_TIMEOUT" };
      if (error instanceof StripeApiError) {
        // idempotency_error (400, measured) and 409 mean a request under this key already exists, which may have paid.
        const keyInUse = error.type === "idempotency_error" || error.status === 409;
        // Stripe documents that any other 4xx changed nothing.
        if (error.status >= 400 && error.status < 500 && !keyInUse) return { ok: false, code: "RAIL_REJECTED", detail: `Stripe refused the transfer (${errorLabel(error)})` };
        return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: `Stripe's answer to the transfer didn't prove an outcome (${errorLabel(error)})` };
      }
      if (error instanceof StripeResponseError || error instanceof z.ZodError) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "Stripe's answer to the transfer was unreadable" };
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "network error after the transfer was sent" };
    }

    if (transfer.livemode) return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "Stripe returned a live-mode transfer" };
    if (BigInt(transfer.amount) !== cents || transfer.currency !== "usd" || transfer.destination !== req.destination || transfer.transfer_group !== req.idempotencyKey) {
      return { ok: false, code: "INVALID_RAIL_RESPONSE", detail: "the transfer Stripe returned differs from the one requested" };
    }
    return { ok: true, ref: transfer.id, explorerUrl: stripeDashboardUrl(transfer.id), settledMicros: fromRailUnits(cents, "stripe") };
  }

  /**
   * PO-8, RAIL-21, RAIL-22: the transfer for this key, found by its
   * `transfer_group` with one list request. Returns null when the group
   * has no transfer, so the caller can look for a payment or refund
   * instead. Errors are thrown; the reconciler treats them as unknown.
   */
  async lookup(idempotencyKey: string, ctx: RailContext = {}): Promise<RailLookup | null> {
    const list = TransferList.parse(await this.api.get("/v1/transfers", { transfer_group: idempotencyKey, limit: "10" }, { ...CONNECT, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
    const ours = list.data.filter((t) => t.transfer_group === idempotencyKey);
    if (ours.length === 0 && !list.has_more) return null;
    const [transfer] = ours;
    // More than one, a reversal, or a live-mode object needs a person, not a guess.
    if (!transfer || ours.length > 1 || list.has_more || transfer.reversed || transfer.livemode) return { status: "unknown" };
    return { status: "settled", ref: transfer.id, explorerUrl: stripeDashboardUrl(transfer.id), settledMicros: fromRailUnits(BigInt(transfer.amount), "stripe") };
  }
}
