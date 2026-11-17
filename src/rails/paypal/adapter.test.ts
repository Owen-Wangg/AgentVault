import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { PAYPAL_SANDBOX_API } from "../config";
import { PayPalRail, payoutRequestId } from "./adapter";
import { FakePayPal, SUPPLIER, TEST_PAYPAL_CONFIG, noWait } from "./test-fixtures";

/** payout-rails task 6: the PayPal sandbox adapter against an in-process fake of the Payouts API. */

const KEY = "0c6f5a3e-7d1b-4f3e-9a52-6b8c4d2e1f00";

function setup(options: { statuses?: string[]; now?: () => Date } = {}) {
  const fake = new FakePayPal();
  if (options.statuses) fake.statuses = options.statuses;
  const rail = new PayPalRail({ config: TEST_PAYPAL_CONFIG, fetch: fake.fetchFn, sleep: noWait, ...(options.now ? { now: options.now } : {}) });
  return { fake, rail };
}
const payout = (amount: string, over: { destination?: string; key?: string } = {}) => ({
  destination: over.destination ?? SUPPLIER,
  amountMicros: fromDecimalString(amount),
  idempotencyKey: over.key ?? KEY,
});

describe("PayPal sandbox only", () => {
  it("PO-17: a configuration that isn't the sandbox refuses every call without contacting anyone", async () => {
    const fake = new FakePayPal();
    const configs = [
      { ...TEST_PAYPAL_CONFIG, environment: "live" as unknown as "sandbox" },
      { ...TEST_PAYPAL_CONFIG, apiOrigin: "https://api-m.paypal.com" as unknown as typeof PAYPAL_SANDBOX_API },
    ];
    for (const config of configs) {
      const rail = new PayPalRail({ config, fetch: fake.fetchFn, sleep: noWait });
      expect(await rail.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
      expect(await rail.checkDestination(SUPPLIER)).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
      expect(await rail.lookup(KEY, { railRef: "FAKEBATCH1" })).toEqual({ status: "unknown" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("PO-17, security-standards §7: only sandbox account addresses are payout destinations", async () => {
    const { rail, fake } = setup();
    expect(await rail.checkDestination(SUPPLIER)).toEqual({ ok: true });
    expect(await rail.checkDestination("acme@business.example.com")).toEqual({ ok: true });
    for (const bad of ["someone@gmail.com", "acct_1Supplier", "x@personal.example.com.evil.com"]) {
      expect(await rail.checkDestination(bad)).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
      expect(await rail.payout(payout("1", { destination: bad }))).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("PO-2: PayPal only pays out: execute() and refund() refuse without a call", async () => {
    const { rail, fake } = setup();
    expect(await rail.execute()).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(await rail.refund()).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    expect(fake.calls).toEqual([]);
  });
});

describe("PayPal payout", () => {
  it("PO-15: one batch with one USD item to the receiver, sender_batch_id and sender_item_id from the reservation", async () => {
    const { rail, fake } = setup();
    await rail.payout(payout("900"));
    expect(fake.calls[0]).toMatchObject({ method: "POST", path: "/v1/oauth2/token" });
    expect(fake.calls[0]?.auth).toBe(`Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`);
    const [create] = fake.creates();
    expect(create?.requestId).toBe(payoutRequestId(KEY));
    expect(create?.body).toEqual({
      sender_batch_header: { sender_batch_id: KEY, email_subject: "AgentVault sandbox payout" },
      items: [{ recipient_type: "EMAIL", receiver: SUPPLIER, amount: { value: "900.00", currency: "USD" }, sender_item_id: KEY }],
    });
  });

  it("PO-3: rounds down to the cent for the payee, and refuses what rounds to 0 cents without a call", async () => {
    const { rail, fake } = setup();
    expect(await rail.payout(payout("0.019999"))).toMatchObject({ ok: true, settledMicros: micros(10_000n) });
    expect((fake.creates()[0]?.body as { items: { amount: { value: string } }[] }).items[0]?.amount.value).toBe("0.01");
    const other = setup();
    expect(await other.rail.payout(payout("0.009999"))).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(other.fake.calls).toEqual([]);
  });

  it("PO-16: reads the batch until the item reaches SUCCESS, and settles with the payout item ID", async () => {
    const { rail, fake } = setup({ statuses: ["PENDING", "PENDING", "SUCCESS"] });
    expect(await rail.payout(payout("1"))).toEqual({ ok: true, ref: "ITEMFAKEBATCH1", settledMicros: micros(1_000_000n) });
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("PO-16: a FAILED item is a confirmed failure", async () => {
    const { rail } = setup({ statuses: ["FAILED"] });
    expect(await rail.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("FAILED") });
  });

  it("PO-16, PO-25: still PENDING after the reads is unknown, with the batch ID for a later lookup", async () => {
    const { rail, fake } = setup({ statuses: ["PENDING"] });
    expect(await rail.payout(payout("1"))).toEqual({ ok: false, code: "RAIL_TIMEOUT", detail: "PayPal still reports the payout PENDING", pendingRef: "FAKEBATCH1" });
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(5);
  });

  it("PO-16, PO-25: UNCLAIMED is unknown, never a failure", async () => {
    const { rail } = setup({ statuses: ["UNCLAIMED"] });
    expect(await rail.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_TIMEOUT", pendingRef: "FAKEBATCH1" });
  });

  it("PO-25: the rail signal ends the wait, and the batch ID still comes back", async () => {
    const fake = new FakePayPal();
    fake.statuses = ["PENDING"];
    const controller = new AbortController();
    const rail = new PayPalRail({ config: TEST_PAYPAL_CONFIG, fetch: fake.fetchFn, sleep: async () => controller.abort() });
    expect(await rail.payout(payout("1"), { signal: controller.signal })).toMatchObject({ ok: false, code: "RAIL_TIMEOUT", pendingRef: "FAKEBATCH1" });
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("PO-25: a failed batch read during the wait keeps reading, then keeps the batch ID", async () => {
    const { rail, fake } = setup({ statuses: ["PENDING", "SUCCESS"] });
    fake.override.set("GET /v1/payments/payouts/FAKEBATCH1", { status: 503, json: { name: "INTERNAL_SERVICE_ERROR" } });
    expect(await rail.payout(payout("1"))).toMatchObject({ ok: true, ref: "ITEMFAKEBATCH1" });
  });

  it("PO-5: a second payout for the same reservation is refused by PayPal, and the adapter reads the earlier batch instead: one batch", async () => {
    const { rail, fake } = setup({ statuses: ["PENDING"] });
    const first = await rail.payout(payout("1"));
    expect(first).toMatchObject({ ok: false, code: "RAIL_TIMEOUT", pendingRef: "FAKEBATCH1" });
    const batch = fake.batches.get("FAKEBATCH1");
    if (batch) batch.statuses = ["SUCCESS"];
    expect(await rail.payout(payout("1"))).toEqual({ ok: true, ref: "ITEMFAKEBATCH1", settledMicros: micros(1_000_000n) });
    expect(fake.batches.size).toBe(1);
    expect(fake.creates()).toHaveLength(2);
  });

  it("PO-5: a duplicate refusal that doesn't name the batch is unknown", async () => {
    const { rail, fake } = setup();
    fake.override.set("POST /v1/payments/payouts", { status: 400, json: { name: "USER_BUSINESS_ERROR", details: [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }] } });
    expect(await rail.payout(payout("1"))).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });

  it("PO-15: a failed token request means nothing was sent", async () => {
    for (const reply of [{ status: 401, json: { error: "invalid_client" } }, { status: 200, text: "<html>" }, "abort" as const]) {
      const { rail, fake } = setup();
      fake.override.set("POST /v1/oauth2/token", reply);
      expect(await rail.payout(payout("1"))).toMatchObject({ ok: false, code: "RAIL_REJECTED", detail: expect.stringContaining("nothing was sent") });
      expect(fake.creates()).toEqual([]);
    }
  });

  it("PO-15: the token is cached until a minute before it expires, and a 401 drops it", async () => {
    let nowMs = Date.parse("2026-11-17T00:00:00Z");
    const { rail, fake } = setup({ now: () => new Date(nowMs) });
    fake.tokenLifetimeSeconds = 600;
    await rail.payout(payout("1", { key: "a" }));
    await rail.payout(payout("1", { key: "b" }));
    expect(fake.tokensIssued).toBe(1);
    nowMs += 541_000;
    await rail.payout(payout("1", { key: "c" }));
    expect(fake.tokensIssued).toBe(2);
    fake.override.set("POST /v1/payments/payouts", { status: 401, json: { name: "AUTHENTICATION_FAILURE" } });
    expect(await rail.payout(payout("1", { key: "d" }))).toMatchObject({ ok: false, code: "RAIL_REJECTED" });
    await rail.payout(payout("1", { key: "e" }));
    expect(fake.tokensIssued).toBe(3);
  });

  it("PO-16: other 4xx refusals are confirmed failures; 409, 5xx, unreadable answers, and network errors are unknown; a timeout is RAIL_TIMEOUT", async () => {
    const cases: [Parameters<FakePayPal["override"]["set"]>[1], string][] = [
      [{ status: 422, json: { name: "INSUFFICIENT_FUNDS" } }, "RAIL_REJECTED"],
      [{ status: 400, json: { name: "VALIDATION_ERROR", details: [{ field: "items[0].amount.value" }] } }, "RAIL_REJECTED"],
      [{ status: 409, json: { name: "CONFLICT" } }, "INVALID_RAIL_RESPONSE"],
      [{ status: 500, json: { name: "INTERNAL_SERVICE_ERROR" } }, "INVALID_RAIL_RESPONSE"],
      [{ status: 201, text: "not json" }, "INVALID_RAIL_RESPONSE"],
      [{ status: 201, json: { batch_header: { payout_batch_id: "../../x", batch_status: "PENDING" } } }, "INVALID_RAIL_RESPONSE"],
      ["network", "INVALID_RAIL_RESPONSE"],
      ["abort", "RAIL_TIMEOUT"],
    ];
    for (const [reply, code] of cases) {
      const { rail, fake } = setup();
      fake.override.set("POST /v1/payments/payouts", reply);
      expect(await rail.payout(payout("1"))).toMatchObject({ ok: false, code });
    }
  });

  it("PO-16: an item that differs from the request is unknown, with the batch ID kept", async () => {
    const { fake } = setup({ statuses: ["SUCCESS"] });
    const original = fake.fetchFn;
    // Rewrite the receiver PayPal reports, as if the batch paid someone else.
    const tampered = (async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      if ((init?.method ?? "GET") !== "GET") return response;
      const json = (await response.json()) as { items: { payout_item: { receiver: string } }[] };
      for (const item of json.items) item.payout_item.receiver = "attacker@personal.example.com";
      return Response.json(json);
    }) as typeof fetch;
    const r = new PayPalRail({ config: TEST_PAYPAL_CONFIG, fetch: tampered, sleep: noWait });
    expect(await r.payout(payout("1"))).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE", pendingRef: "FAKEBATCH1" });
  });

  it("security-standards §6: the access token never appears in a result", async () => {
    for (const statuses of [["SUCCESS"], ["PENDING"], ["FAILED"]]) {
      const { rail } = setup({ statuses });
      const result = await rail.payout(payout("1"));
      expect(JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("fake-token");
    }
  });
});

describe("PayPal lookup", () => {
  it("PO-25, RAIL-22: without a stored batch ID it is unknown and makes no call", async () => {
    const { rail, fake } = setup();
    expect(await rail.lookup(KEY)).toEqual({ status: "unknown" });
    expect(await rail.lookup(KEY, { railRef: "not/a/batch" })).toEqual({ status: "unknown" });
    expect(fake.calls).toEqual([]);
  });

  it("PO-25, PO-16, RAIL-22: reads the stored batch: SUCCESS settles, FAILED fails, PENDING stays unknown, with GETs only after the token", async () => {
    for (const [status, expected] of [
      ["SUCCESS", { status: "settled", ref: "ITEMFAKEBATCH1", settledMicros: micros(1_000_000n) }],
      ["FAILED", { status: "failed", code: "RAIL_REJECTED" }],
      ["PENDING", { status: "unknown" }],
    ] as const) {
      const { rail, fake } = setup({ statuses: ["PENDING"] });
      await rail.payout(payout("1"));
      const batch = fake.batches.get("FAKEBATCH1");
      if (batch) batch.statuses = [status];
      fake.calls = [];
      expect(await rail.lookup(KEY, { railRef: "FAKEBATCH1" })).toEqual(expected);
      expect(fake.calls.filter((c) => c.path !== "/v1/oauth2/token").map((c) => c.method)).toEqual(["GET"]);
      expect(fake.creates()).toEqual([]);
    }
  });

  it("PO-25: a batch that belongs to another reservation is unknown", async () => {
    const { rail } = setup({ statuses: ["SUCCESS"] });
    await rail.payout(payout("1", { key: "someone-else" }));
    expect(await rail.lookup(KEY, { railRef: "FAKEBATCH1" })).toEqual({ status: "unknown" });
  });

  it("RAIL-21: a read error is thrown, for the reconciler to treat as unknown", async () => {
    const { rail } = setup();
    await expect(rail.lookup(KEY, { railRef: "MISSING1" })).rejects.toThrow();
  });
});
