import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { StripeMppRail } from "./adapter";
import { CONNECT_API_VERSION } from "./constants";
import { StripeConnectPayouts, transferIdempotencyKey } from "./payouts";
import { StripeApi } from "./stripe-api";

/**
 * payout-rails task 5: the Stripe Connect payout adapter against a small
 * in-process fake of Accounts v2 and v1 Transfers. The recorded exchanges
 * are replayed in payouts.contract.test.ts.
 */

const SUPPLIER = "acct_1Supplier";
const KEY = "5b0c7a52-0d55-4b53-9a43-1b1d1f0c2a11";

interface FakeTransfer {
  id: string;
  object: "transfer";
  amount: number; // money-check: ok fake Stripe JSON: whole cents, as Stripe sends them
  currency: string;
  destination: string;
  livemode: boolean;
  reversed: boolean;
  transfer_group: string | null;
  metadata: Record<string, string>;
}

type Reply = { status: number; json?: unknown; text?: string } | "abort" | "network";

/** Accounts v2 reads and v1 transfers, with Stripe's idempotency-key replay. */
class FakeConnect {
  accounts = new Map<string, Record<string, unknown>>();
  transfers: FakeTransfer[] = [];
  calls: { method: string; path: string; query: string; version: string | null; key: string | null; body: Record<string, string> }[] = [];
  /** The next request to this "METHOD path" gets this reply instead. */
  override = new Map<string, Reply>();
  /** Change each created transfer before it's returned. */
  tamper: ((t: FakeTransfer) => FakeTransfer) | null = null;
  private readonly answers = new Map<string, unknown>();

  account(id: string, over: { livemode?: boolean; status?: string; closed?: boolean } = {}) {
    this.accounts.set(id, {
      id,
      object: "v2.core.account",
      livemode: over.livemode ?? false,
      closed: over.closed ?? false,
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: over.status ?? "active", status_details: [] } } } } },
    });
  }

  readonly fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
    this.calls.push({ method, path: u.pathname, query: u.search, version: headers.get("stripe-version"), key: headers.get("idempotency-key"), body });
    const reply = this.override.get(`${method} ${u.pathname}`);
    if (reply) {
      this.override.delete(`${method} ${u.pathname}`);
      if (reply === "abort") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      if (reply === "network") throw new TypeError("fetch failed");
      return reply.text !== undefined ? new Response(reply.text, { status: reply.status }) : Response.json(reply.json, { status: reply.status });
    }
    if (method === "GET" && u.pathname.startsWith("/v2/core/accounts/")) {
      const account = this.accounts.get(decodeURIComponent(u.pathname.slice("/v2/core/accounts/".length)));
      return account ? Response.json(account) : Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such account" } }, { status: 404 });
    }
    if (method === "GET" && u.pathname === "/v1/transfers") {
      const group = u.searchParams.get("transfer_group");
      return Response.json({ object: "list", data: this.transfers.filter((t) => t.transfer_group === group), has_more: false });
    }
    if (method === "POST" && u.pathname === "/v1/transfers") {
      const key = headers.get("idempotency-key") ?? "";
      const prior = this.answers.get(key);
      if (prior) return Response.json(prior);
      let t: FakeTransfer = {
        id: `tr_fake${this.transfers.length + 1}`,
        object: "transfer",
        amount: Number(body.amount), // money-check: ok fake Stripe JSON: whole cents from a form field
        currency: body.currency ?? "",
        destination: body.destination ?? "",
        livemode: false,
        reversed: false,
        transfer_group: body.transfer_group ?? null,
        metadata: { idempotency_key: body["metadata[idempotency_key]"] ?? "" },
      };
      if (this.tamper) t = this.tamper(t);
      this.transfers.push(t);
      this.answers.set(key, t);
      return Response.json(t);
    }
    return Response.json({ error: { type: "invalid_request_error", message: "unknown path" } }, { status: 404 });
  }) as typeof fetch;

  posts() {
    return this.calls.filter((c) => c.method === "POST");
  }
}

function setup() {
  const fake = new FakeConnect();
  fake.account(SUPPLIER);
  // The client's default version is the MPP preview one; Connect calls must override it.
  const api = new StripeApi({ secretKey: "sk_test_fake", fetch: fake.fetchFn });
  return { fake, payouts: new StripeConnectPayouts(api), api };
}

const payout = (amount: string, over: { destination?: string; key?: string } = {}) => ({
  destination: over.destination ?? SUPPLIER,
  amountMicros: fromDecimalString(amount),
  idempotencyKey: over.key ?? KEY,
});

describe("Stripe Connect checkDestination", () => {
  it("PO-6: an active test-mode recipient account passes, read once through Accounts v2 with the pinned version", async () => {
    const { fake, payouts } = setup();
    expect(await payouts.checkDestination(SUPPLIER)).toEqual({ ok: true });
    expect(fake.calls).toEqual([
      { method: "GET", path: `/v2/core/accounts/${SUPPLIER}`, query: "?include=configuration.recipient", version: CONNECT_API_VERSION, key: null, body: {} },
    ]);
  });

  it("PO-6: an account whose stripe_transfers capability isn't active is refused", async () => {
    const { fake, payouts } = setup();
    fake.account(SUPPLIER, { status: "pending" });
    expect(await payouts.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("pending") });
  });

  it("PO-6: a closed account is refused", async () => {
    const { fake, payouts } = setup();
    fake.account(SUPPLIER, { closed: true });
    expect(await payouts.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
  });

  it("PO-9: a live-mode account is an invalid response", async () => {
    const { fake, payouts } = setup();
    fake.account(SUPPLIER, { livemode: true });
    expect(await payouts.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });

  it("PO-6: an unknown account (404) is refused", async () => {
    const { payouts } = setup();
    expect(await payouts.checkDestination("acct_1Nobody")).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("resource_missing") });
  });

  it("PO-10: a destination that isn't an acct_ ID is refused without a call", async () => {
    const { fake, payouts } = setup();
    expect(await payouts.checkDestination("attacker@personal.example.com")).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(await payouts.checkDestination("acct_1../../v1/transfers")).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(fake.calls).toEqual([]);
  });

  it("PO-11: a 5xx or timeout is RAIL_TIMEOUT, an unreadable body INVALID_RAIL_RESPONSE", async () => {
    const { fake, payouts } = setup();
    const path = `GET /v2/core/accounts/${SUPPLIER}`;
    fake.override.set(path, { status: 503, json: { error: { type: "api_error", message: "down" } } });
    expect(await payouts.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
    fake.override.set(path, "abort");
    expect(await payouts.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "RAIL_TIMEOUT" });
    fake.override.set(path, { status: 200, text: "<html>" });
    expect(await payouts.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });
});

describe("Stripe Connect payout", () => {
  it("PO-7: checks the account, then sends one USD transfer with the derived key, transfer_group, and metadata", async () => {
    const { fake, payouts } = setup();
    const result = await payouts.payout(payout("900"));
    expect(result).toEqual({ ok: true, ref: "tr_fake1", explorerUrl: "https://dashboard.stripe.com/test/connect/transfers/tr_fake1", settledMicros: micros(900_000_000n) });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v2/core/accounts/${SUPPLIER}`, "POST /v1/transfers"]);
    expect(fake.posts()[0]).toMatchObject({
      version: CONNECT_API_VERSION,
      key: transferIdempotencyKey(KEY),
      body: { amount: "90000", currency: "usd", destination: SUPPLIER, transfer_group: KEY, "metadata[idempotency_key]": KEY },
    });
    expect(transferIdempotencyKey(KEY)).toBe(`agentvault-transfer-v1:${KEY}`);
  });

  it("PO-3: rounds down to the cent for the payee", async () => {
    const { fake, payouts } = setup();
    expect(await payouts.payout(payout("0.019999"))).toMatchObject({ ok: true, settledMicros: micros(10_000n) });
    expect(fake.posts()[0]?.body.amount).toBe("1");
  });

  it("PO-22: an amount that rounds to 0 cents is BELOW_RAIL_MINIMUM without a call", async () => {
    const { fake, payouts } = setup();
    expect(await payouts.payout(payout("0.009999"))).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(fake.calls).toEqual([]);
  });

  it("PO-5: a second payout with the same key gets the same transfer back from Stripe: one transfer", async () => {
    const { fake, payouts } = setup();
    const first = await payouts.payout(payout("1"));
    expect(await payouts.payout(payout("1"))).toEqual(first);
    expect(fake.transfers).toHaveLength(1);
    expect(new Set(fake.posts().map((p) => p.key))).toEqual(new Set([transferIdempotencyKey(KEY)]));
  });

  it("PO-6: no transfer is sent when the account check fails, and the result proves nothing moved", async () => {
    for (const status of ["pending", "inactive"]) {
      const { fake, payouts } = setup();
      fake.account(SUPPLIER, { status });
      expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("nothing was sent") });
      expect(fake.posts()).toEqual([]);
    }
    const { fake, payouts } = setup();
    fake.account(SUPPLIER, { livemode: true });
    expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    fake.override.set(`GET /v2/core/accounts/${SUPPLIER}`, "abort");
    expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("nothing was sent") });
    expect(fake.posts()).toEqual([]);
  });

  it("PO-6: a signal that aborted after the account check stops the transfer before it's sent", async () => {
    const { fake } = setup();
    const controller = new AbortController();
    const abortingFetch = (async (url: string, init?: RequestInit) => {
      const response = await fake.fetchFn(url, init);
      controller.abort();
      return response;
    }) as typeof fetch;
    const p = new StripeConnectPayouts(new StripeApi({ secretKey: "sk_test_fake", fetch: abortingFetch }));
    expect(await p.payout(payout("1"), { signal: controller.signal })).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(fake.posts()).toEqual([]);
  });

  it("PO-7: a 4xx refusal (balance_insufficient, as recorded) proves nothing moved", async () => {
    const { fake, payouts } = setup();
    fake.override.set("POST /v1/transfers", {
      status: 400,
      json: { error: { code: "balance_insufficient", type: "invalid_request_error", message: "You have insufficient available funds in your Stripe account." } },
    });
    expect(await payouts.payout(payout("10000"))).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("balance_insufficient") });
  });

  it("PO-7: idempotency_error and 409 mean a request under this key exists, so they're unknown", async () => {
    const { fake, payouts } = setup();
    fake.override.set("POST /v1/transfers", { status: 400, json: { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" } } });
    expect(await payouts.payout(payout("1.01"))).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    fake.override.set("POST /v1/transfers", { status: 409, json: { error: { type: "invalid_request_error", message: "concurrent request with this key" } } });
    expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });

  it("PO-7: a 5xx, an unreadable body, or a network error after sending is unknown; a timeout is RAIL_TIMEOUT", async () => {
    const replies: [Reply, string][] = [
      [{ status: 500, json: { error: { type: "api_error", message: "oops" } } }, "INVALID_RAIL_RESPONSE"],
      [{ status: 200, text: "not json" }, "INVALID_RAIL_RESPONSE"],
      [{ status: 200, json: { id: "nope" } }, "INVALID_RAIL_RESPONSE"],
      ["network", "INVALID_RAIL_RESPONSE"],
      ["abort", "RAIL_TIMEOUT"],
    ];
    for (const [reply, code] of replies) {
      const { fake, payouts } = setup();
      fake.override.set("POST /v1/transfers", reply);
      expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code });
    }
  });

  it("PO-9: a live-mode transfer is an invalid response, never settled", async () => {
    const { fake, payouts } = setup();
    fake.tamper = (t) => ({ ...t, livemode: true });
    expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE", detail: expect.stringContaining("live-mode") });
  });

  it("PO-7: a transfer that differs from the request (amount, currency, destination, group) is unknown, not settled", async () => {
    const changes: ((t: FakeTransfer) => FakeTransfer)[] = [
      (t) => ({ ...t, amount: t.amount + 1 }),
      (t) => ({ ...t, currency: "cad" }),
      (t) => ({ ...t, destination: "acct_1Attacker" }),
      (t) => ({ ...t, transfer_group: "other" }),
    ];
    for (const change of changes) {
      const { fake, payouts } = setup();
      fake.tamper = change;
      expect(await payouts.payout(payout("1"))).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
    }
  });
});

describe("Stripe Connect lookup", () => {
  it("PO-8, RAIL-22: finds the payout by transfer_group with one GET", async () => {
    const { fake, payouts } = setup();
    const paid = await payouts.payout(payout("1"));
    fake.calls = [];
    expect(await payouts.lookup(KEY)).toEqual({ status: "settled", ref: paid.ok ? paid.ref : "", explorerUrl: paid.ok ? paid.explorerUrl : "", settledMicros: micros(1_000_000n) });
    expect(fake.calls).toEqual([{ method: "GET", path: "/v1/transfers", query: `?transfer_group=${KEY}&limit=10`, version: CONNECT_API_VERSION, key: null, body: {} }]);
  });

  it("PO-8: no transfer in the group returns null, so the caller looks further", async () => {
    const { payouts } = setup();
    expect(await payouts.lookup("never-paid")).toBeNull();
  });

  it("PO-8, PO-9: a reversed, live-mode, or duplicated transfer is unknown", async () => {
    const base = { object: "transfer" as const, amount: 100, currency: "usd", destination: SUPPLIER, transfer_group: KEY, metadata: {} };
    const cases: FakeTransfer[][] = [
      [{ ...base, id: "tr_a", livemode: false, reversed: true }],
      [{ ...base, id: "tr_a", livemode: true, reversed: false }],
      [
        { ...base, id: "tr_a", livemode: false, reversed: false },
        { ...base, id: "tr_b", livemode: false, reversed: false },
      ],
    ];
    for (const transfers of cases) {
      const { fake, payouts } = setup();
      fake.transfers = transfers;
      expect(await payouts.lookup(KEY)).toEqual({ status: "unknown" });
    }
  });

  it("RAIL-21: a list error is thrown, for the reconciler to treat as unknown", async () => {
    const { fake, payouts } = setup();
    fake.override.set("GET /v1/transfers", { status: 500, json: { error: { type: "api_error", message: "down" } } });
    await expect(payouts.lookup(KEY)).rejects.toThrow();
  });
});

describe("StripeMppRail with Connect payouts", () => {
  const rail = () => {
    const s = setup();
    return { ...s, rail: new StripeMppRail({ api: s.api, profileId: "profile_test_x", fetch: s.fake.fetchFn, payouts: s.payouts }) };
  };

  it("PO-2, PO-7: payout() and checkDestination() go to Connect", async () => {
    const { fake, rail: r } = rail();
    expect(await r.checkDestination(SUPPLIER)).toEqual({ ok: true });
    expect(await r.payout(payout("1"))).toMatchObject({ ok: true, ref: "tr_fake1" });
    expect(fake.transfers).toHaveLength(1);
  });

  it("PO-8: lookup() finds a payout by its group first, without a reservation time", async () => {
    const { rail: r } = rail();
    await r.payout(payout("1"));
    expect(await r.lookup(KEY)).toMatchObject({ status: "settled", ref: "tr_fake1" });
  });

  it("PO-8, RAIL-21: a key with no transfer falls through to the payment lookup, which stays unknown without a reservation time", async () => {
    const { fake, rail: r } = rail();
    expect(await r.lookup("never-paid")).toEqual({ status: "unknown" });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/transfers"]);
  });
});
