import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { CONNECT_API_VERSION } from "./constants";
import { StripeConnectPayouts, transferIdempotencyKey } from "./payouts";
import { StripeApi } from "./stripe-api";

/**
 * Contract tests against exchanges recorded in Stripe test mode with
 * `pnpm connect:probe --record` (payout-rails task 2). The probe used the
 * adapter's request shape, with two differences the replay accounts for
 * (design, "Recording limits"): the recorder kept one value of the
 * repeated `include` parameter, so account reads match on method and path
 * only, and the probe's transfers carried a `description` the adapter
 * doesn't send. Nothing here touches the network.
 */

interface Exchange {
  step: string;
  request: { method: string; path: string; params: Record<string, string>; idempotency_key: string | null };
  response: { status: number; json: unknown };
}
const rec = JSON.parse(readFileSync(new URL("../__fixtures__/stripe-connect/transfer-probe.json", import.meta.url), "utf8")) as { api_version: string; exchanges: Exchange[] };
const step = (name: string) => rec.exchanges.filter((e) => e.step === name);
const withoutDescription = ({ description: _, ...rest }: Record<string, string>) => rest;

const [firstTransfer] = step("transfer $1.00");
if (!firstTransfer) throw new Error("the recording has no $1.00 transfer");
const KEY = firstTransfer.request.params.transfer_group ?? "";
const SUPPLIER = firstTransfer.request.params.destination ?? "";
const TRANSFER = firstTransfer.response.json as { id: string };

/** Answers only requests the recording contains, in recorded order per step. */
function replay(exchanges: readonly Exchange[]) {
  const sent: { method: string; path: string; query: URLSearchParams; params: Record<string, string>; key: string | null; version: string | null }[] = [];
  const used = new Set<Exchange>();
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const params = Object.fromEntries(new URLSearchParams(init.body ? String(init.body) : u.search));
    const key = headers.get("idempotency-key");
    sent.push({ method, path: u.pathname, query: u.searchParams, params, key, version: headers.get("stripe-version") });
    const match = exchanges.find((e) => {
      if (used.has(e) || e.request.method !== method || e.request.path !== u.pathname) return false;
      if (u.pathname.startsWith("/v2/core/accounts/")) return true;
      return JSON.stringify(withoutDescription(e.request.params)) === JSON.stringify(params) && e.request.idempotency_key === key;
    });
    if (!match) return Response.json({ error: { type: "invalid_request_error", message: `not recorded: ${method} ${u.pathname}` } }, { status: 400 });
    used.add(match);
    return Response.json(match.response.json, { status: match.response.status });
  }) as typeof fetch;
  return { payouts: new StripeConnectPayouts(new StripeApi({ secretKey: "sk_test_replay", fetch: fetchFn })), sent };
}

const accountRead = rec.exchanges.find((e) => e.request.path === `/v2/core/accounts/${SUPPLIER}`);
if (!accountRead) throw new Error("the recording has no read of the supplier's account");

describe("Stripe Connect adapter against recorded test-mode exchanges", () => {
  it("PO-22: the recording used the API version the adapter pins", () => {
    expect(rec.api_version).toBe(CONNECT_API_VERSION);
  });

  it("PO-6, PO-9: the recorded supplier account is test mode with stripe_transfers active, and passes the check", async () => {
    expect(accountRead.response.json).toMatchObject({
      livemode: false,
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" } } } } },
    });
    const { payouts, sent } = replay([accountRead]);
    expect(await payouts.checkDestination(SUPPLIER)).toEqual({ ok: true });
    expect(sent[0]?.query.getAll("include")).toEqual(["configuration.recipient"]);
    expect(sent[0]?.version).toBe(CONNECT_API_VERSION);
  });

  it("PO-7: replays the recorded $1.00 transfer: same request shape, and the tr_ ID as the reference", async () => {
    const { payouts, sent } = replay([accountRead, firstTransfer]);
    const result = await payouts.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("1.00"), idempotencyKey: KEY });
    expect(result).toEqual({ ok: true, ref: TRANSFER.id, explorerUrl: `https://dashboard.stripe.com/test/connect/transfers/${TRANSFER.id}`, settledMicros: 1_000_000n });
    const post = sent.find((s) => s.method === "POST");
    expect(post?.params).toEqual(withoutDescription(firstTransfer.request.params));
    expect(post?.key).toBe(transferIdempotencyKey(KEY));
    expect(firstTransfer.request.idempotency_key).toBe(transferIdempotencyKey(KEY));
  });

  it("PO-5: the recorded repeat under the same key returned the same transfer", async () => {
    const [again] = step("same key again");
    if (!again) throw new Error("the recording has no repeat");
    expect((again.response.json as { id: string }).id).toBe(TRANSFER.id);
    const { payouts } = replay([accountRead, again]);
    expect(await payouts.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("1.00"), idempotencyKey: KEY })).toMatchObject({ ok: true, ref: TRANSFER.id });
  });

  it("PO-7: the recorded same key with $1.01 (idempotency_error) is unknown, never a confirmed failure", async () => {
    const [changed] = step("same key, $1.01");
    if (!changed) throw new Error("the recording has no changed repeat");
    expect(changed.response).toMatchObject({ status: 400, json: { error: { type: "idempotency_error" } } });
    const { payouts } = replay([accountRead, changed]);
    expect(await payouts.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("1.01"), idempotencyKey: KEY })).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });

  it("PO-8, RAIL-22: the recorded lookup by transfer_group finds the transfer; a group never used finds none", async () => {
    const [found] = step("lookup by transfer_group");
    const [none] = step("lookup unknown transfer_group");
    if (!found || !none) throw new Error("the recording has no lookups");
    const hit = replay([found]);
    expect(await hit.payouts.lookup(KEY)).toEqual({ status: "settled", ref: TRANSFER.id, explorerUrl: `https://dashboard.stripe.com/test/connect/transfers/${TRANSFER.id}`, settledMicros: 1_000_000n });
    expect(hit.sent.map((s) => s.method)).toEqual(["GET"]);
    const miss = replay([none]);
    expect(await miss.payouts.lookup(none.request.params.transfer_group ?? "")).toBeNull();
  });

  it("PO-22: Stripe refused $0.00 with parameter_invalid_integer, and the adapter refuses it before any call", async () => {
    const [zero] = step("transfer $0.00");
    expect(zero?.response).toMatchObject({ status: 400, json: { error: { code: "parameter_invalid_integer", param: "amount" } } });
    const { payouts, sent } = replay([]);
    expect(await payouts.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("0.00"), idempotencyKey: KEY })).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(sent).toEqual([]);
  });

  it("PO-22: the recorded $0.01 transfer settled, so 1 cent is the minimum", () => {
    expect(step("transfer $0.01")[0]?.response).toMatchObject({ status: 200, json: { amount: 1, livemode: false, reversed: false } });
  });
});
