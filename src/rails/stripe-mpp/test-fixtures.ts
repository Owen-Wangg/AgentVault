import { readFileSync } from "node:fs";
// eslint-disable-next-line no-restricted-imports -- mppx's own server package, not src/server: the synthetic vendor needs it.
import { Mppx } from "mppx/server/core";
// eslint-disable-next-line no-restricted-imports -- mppx's own server package, not src/server.
import { stripe } from "mppx/stripe/server/spt";
import { StripeApi } from "./stripe-api";

// ---------------------------------------------------------------------------
// A fake Stripe test-mode account, for unit, property, and flow tests
// ---------------------------------------------------------------------------

export const PROFILE = "profile_test_61fakeProfile";
export const VENDOR_URL = "https://vendor.example/vendor/api/report";

interface FakePaymentIntent {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number; // money-check: ok fake Stripe JSON: whole cents, as Stripe sends them
  amount_received: number;
  currency: string;
  livemode: false;
  created: number;
  metadata: Record<string, string>;
  spt: string;
}
interface FakeRefund {
  id: string;
  object: "refund";
  amount: number; // money-check: ok fake Stripe JSON: whole cents, as Stripe sends them
  status: string;
  payment_intent: string;
  created: number;
  metadata: Record<string, string>;
}
interface FakeSpt {
  id: string;
  maxAmount: number; // money-check: ok fake Stripe JSON: whole cents, as Stripe sends them
  expiresAt: number;
  used: boolean;
}

/**
 * One Stripe account seen from both sides: the payer's REST calls (SPT
 * test helper, refunds, lists) through `payerFetch`, and the vendor's SDK
 * client through `vendorClient`. It enforces what the adapter relies on:
 * idempotency keys replay the first answer, and an SPT pays once, up to
 * its max_amount, before it expires.
 */
export class FakeStripeAccount {
  readonly spts = new Map<string, FakeSpt>();
  readonly paymentIntents: FakePaymentIntent[] = [];
  readonly refunds: FakeRefund[] = [];
  /** Every payer request, as "METHOD /path". */
  readonly payerCalls: string[] = [];
  private readonly answers = new Map<string, { status: number; json: unknown }>();
  private n = 0;
  /** Set to make the next payer POST to this path fail with this status and error. */
  failNext: { path: string; status: number; code?: string } | null = null;
  /** Set to make list endpoints return pages of this size. */
  pageSize = 100;
  /** Status the vendor's PaymentIntents get. */
  piStatus = "succeeded";
  /** Status new refunds get. */
  refundStatus = "succeeded";

  constructor(readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)) {}

  private id(prefix: string) {
    this.n += 1;
    return `${prefix}_fake${this.n.toString().padStart(6, "0")}`;
  }

  /** The payer side: what StripeApi sends to api.stripe.com. */
  readonly payerFetch = (async (url: string, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const u = new URL(url);
    const method = init.method ?? "GET";
    this.payerCalls.push(`${method} ${u.pathname}`);
    const headers = new Headers(init.headers);
    if (!headers.get("authorization")?.startsWith("Bearer sk_test_")) return Response.json({ error: { type: "invalid_request_error", message: "bad key" } }, { status: 401 });
    if (method === "GET") return this.list(u);
    const params = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
    if (this.failNext && this.failNext.path === u.pathname) {
      const { status, code } = this.failNext;
      this.failNext = null;
      return Response.json({ error: { type: "invalid_request_error", ...(code ? { code } : {}), message: "refused" } }, { status });
    }
    const key = headers.get("idempotency-key");
    const cacheKey = `${u.pathname} ${key}`;
    if (key) {
      const prior = this.answers.get(cacheKey);
      if (prior) return Response.json(prior.json, { status: prior.status });
    }
    const answer = this.post(u.pathname, params);
    if (key) this.answers.set(cacheKey, answer);
    return Response.json(answer.json, { status: answer.status });
  }) as typeof fetch;

  private post(path: string, p: Record<string, string>): { status: number; json: unknown } {
    if (path === "/v1/test_helpers/shared_payment/granted_tokens") {
      const spt: FakeSpt = { id: this.id("spt"), maxAmount: Number(p["usage_limits[max_amount]"]), expiresAt: Number(p["usage_limits[expires_at]"]), used: false };
      this.spts.set(spt.id, spt);
      return {
        status: 200,
        json: { id: spt.id, object: "shared_payment.granted_token", livemode: false, usage_limits: { currency: p["usage_limits[currency]"], max_amount: spt.maxAmount, expires_at: spt.expiresAt } },
      };
    }
    if (path === "/v1/refunds") {
      const pi = this.paymentIntents.find((x) => x.id === p.payment_intent);
      if (!pi) return { status: 404, json: { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent" } } };
      const refund: FakeRefund = {
        id: this.id("re"),
        object: "refund",
        amount: Number(p.amount), // money-check: ok fake Stripe JSON: whole cents from a form field
        status: this.refundStatus,
        payment_intent: pi.id,
        created: this.nowSeconds(),
        metadata: p["metadata[idempotency_key]"] ? { idempotency_key: p["metadata[idempotency_key]"] } : {},
      };
      this.refunds.push(refund);
      return { status: 200, json: refund };
    }
    return { status: 404, json: { error: { type: "invalid_request_error", message: `unknown path ${path}` } } };
  }

  private list(u: URL): Response {
    const items: { id: string; created: number }[] = u.pathname === "/v1/refunds" ? this.refunds : u.pathname === "/v1/payment_intents" ? this.paymentIntents : [];
    const gte = Number(u.searchParams.get("created[gte]") ?? "0");
    const lte = Number(u.searchParams.get("created[lte]") ?? "9999999999");
    // Stripe lists newest first.
    let inRange = items.filter((i) => i.created >= gte && i.created <= lte).reverse();
    const after = u.searchParams.get("starting_after");
    if (after) inRange = inRange.slice(inRange.findIndex((i) => i.id === after) + 1);
    const page = inRange.slice(0, this.pageSize);
    // The SPT a PaymentIntent used is internal to the fake; Stripe's list doesn't show it.
    const shown = page.map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== "spt")));
    return Response.json({ object: "list", data: shown, has_more: inRange.length > page.length });
  }

  /** The vendor side: the part of the Stripe SDK client mppx's SPT charge calls. */
  readonly vendorClient = {
    paymentIntents: {
      create: async (params: Record<string, unknown>) => {
        const spt = this.spts.get(String(params.shared_payment_granted_token));
        if (!spt) throw new Error("No such shared payment token");
        const cents = Number(params.amount); // money-check: ok fake Stripe: whole cents, as mppx passes them to the SDK
        if (spt.used || spt.expiresAt <= this.nowSeconds() || cents > spt.maxAmount) throw new Error("The shared payment token can't be used");
        spt.used = true;
        const pi: FakePaymentIntent = {
          id: this.id("pi"),
          object: "payment_intent",
          status: this.piStatus,
          amount: cents,
          amount_received: this.piStatus === "succeeded" ? cents : 0,
          currency: String(params.currency),
          livemode: false,
          created: this.nowSeconds(),
          metadata: (params.metadata ?? {}) as Record<string, string>,
          spt: spt.id,
        };
        this.paymentIntents.push(pi);
        return { id: pi.id, status: pi.status, lastResponse: { headers: {} } };
      },
    },
  };

  api(): StripeApi {
    return new StripeApi({ secretKey: "sk_test_fake", fetch: this.payerFetch });
  }

  /** The SPTs that paid something. */
  usedSpts(): number {
    return [...this.spts.values()].filter((s) => s.used).length;
  }
}

export interface FakeVendorOptions {
  /** Price in cents. Default 50. */
  cents?: bigint;
  profileId?: string;
  currency?: string;
  /** Override the vendor's response to the unpaid or the paid request. */
  unpaid?: () => Response;
  paid?: () => Response;
}

/**
 * A synthetic MPP vendor built with mppx's own server, charging through
 * the fake account's SDK client. The real vendor lives in src/server,
 * which src/rails may not import.
 */
export function fakeMppVendor(account: FakeStripeAccount, options: FakeVendorOptions = {}) {
  const cents = options.cents ?? 50n;
  const mppx = Mppx.create({
    methods: [
      stripe.charge({
        client: account.vendorClient as never,
        networkId: options.profileId ?? PROFILE,
        currency: options.currency ?? "usd",
        decimals: 2,
        paymentMethodTypes: ["card", "link"],
      }),
    ],
    secretKey: "fake-vendor-challenge-signing-key-32-bytes!",
  });
  const charge = mppx.charge({
    amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
    paymentIntentOptions: ({ credential }) => {
      const id = (credential.payload as { externalId?: unknown }).externalId;
      return { metadata: typeof id === "string" ? { idempotency_key: id } : {} };
    },
  });
  const requests: { paid: boolean }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const paid = new Headers(init.headers).has("authorization");
    requests.push({ paid });
    if (!paid && options.unpaid) return options.unpaid();
    if (paid && options.paid) return options.paid();
    const result = await charge(new Request(url, init));
    if (result.status === 402) return result.challenge;
    return result.withReceipt(Response.json({ report: "ok" }));
  }) as typeof fetch;
  return { fetchFn, requests };
}

// ---------------------------------------------------------------------------
// Recorded exchanges
// ---------------------------------------------------------------------------

/**
 * Replays what `pnpm stripe:probe --record` captured in Stripe test mode
 * (src/rails/__fixtures__/stripe-mpp/), so contract tests run the adapter
 * against what Stripe and the mppx vendor really answered, without the
 * network. The recording holds test-mode object IDs and the vendor's
 * challenges; no key and no client_secret.
 */

export interface RecordedStripe {
  request: { method: string; path: string; params: Record<string, string> };
  response: { status: number; json: unknown };
}
export interface RecordedVendor {
  request: { url: string; credential: string | null };
  response: { status: number; content_type: string | null; www_authenticate: string | null; payment_receipt: string | null; body: string };
}
export interface StripeRecording {
  profile_id: string;
  payment: { key: string; reserved_at: string; result: { ok: boolean; ref?: string }; lookup: unknown; replay: { ok: boolean; code?: string } };
  refund: { key: string; reserved_at: string; result: { ok: boolean; ref?: string }; lookup: unknown } | null;
  http: RecordedVendor[];
  stripe: { pay: RecordedStripe[]; lookup_payment: RecordedStripe[]; replay: RecordedStripe[]; refund: RecordedStripe[] };
}

export function loadStripeRecording(name = "paid-and-refunded-50-cents.json"): StripeRecording {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/stripe-mpp/${name}`, import.meta.url), "utf8")) as StripeRecording;
}

/** Answers only requests the recording contains: same method, path, and parameters. */
export function replayStripe(exchanges: readonly RecordedStripe[]) {
  const seen: (RecordedStripe["request"] & { idempotencyKey: string | null })[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const params = Object.fromEntries(new URLSearchParams(init.body ? String(init.body) : u.search));
    seen.push({ method, path: u.pathname, params, idempotencyKey: new Headers(init.headers).get("idempotency-key") });
    const match = exchanges.find((e) => e.request.method === method && e.request.path === u.pathname && JSON.stringify(e.request.params) === JSON.stringify(params));
    if (!match) return Response.json({ error: { type: "invalid_request_error", message: `not recorded: ${method} ${u.pathname}` } }, { status: 400 });
    return Response.json(match.response.json, { status: match.response.status });
  }) as typeof fetch;
  return { fetchFn, seen };
}

/** A vendor that answers each request with the next recorded response. */
export function replayVendor(http: readonly RecordedVendor[]) {
  const sent: { url: string; credential: string | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const recorded = http[sent.length];
    sent.push({ url, credential: new Headers(init.headers).get("authorization") });
    if (!recorded) throw new Error("no more recorded vendor responses");
    const headers = new Headers();
    if (recorded.response.content_type) headers.set("content-type", recorded.response.content_type);
    if (recorded.response.www_authenticate) headers.set("www-authenticate", recorded.response.www_authenticate);
    if (recorded.response.payment_receipt) headers.set("payment-receipt", recorded.response.payment_receipt);
    return new Response(recorded.response.body, { status: recorded.response.status, headers });
  }) as typeof fetch;
  return { fetchFn, sent };
}
