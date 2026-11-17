import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { PayPalRail, payoutRequestId } from "./adapter";
import { type PayPalExchange, SUPPLIER, TEST_PAYPAL_CONFIG, loadPayPalRecording, noWait } from "./test-fixtures";

/**
 * Contract tests against exchanges recorded in the PayPal sandbox with
 * `pnpm paypal:probe --record` (payout-rails task 2), token and receivers
 * scrubbed. The probe's request carried an `email_subject` and a `note`
 * the adapter words differently, so payout creation matches on method and
 * path, and the test checks the fields that matter separately. Batch reads
 * answer in recorded order. Nothing here touches the network.
 */

const rec = loadPayPalRecording();
const step = (name: string) => rec.exchanges.filter((e) => e.step === name);
const [created, sameRequest, newRequest] = [step("pay $1.00")[0], step("same request id, same batch id")[0], step("new request id, same batch id")[0]];
if (!created || !sameRequest || !newRequest) throw new Error("the recording is missing the $1.00 payout and its repeats");
const createdBody = created.request.body as { sender_batch_header: { sender_batch_id: string }; items: { receiver: string; amount: { value: string; currency: string }; sender_item_id: string }[] };
const KEY = createdBody.sender_batch_header.sender_batch_id;
const BATCH = (created.response.json as { batch_header: { payout_batch_id: string } }).batch_header.payout_batch_id;
const reads = step("read $1.00 batch");

/** Answers the token request itself, then the recorded exchanges in order. */
function replay(exchanges: readonly PayPalExchange[], settleReads?: number) {
  const queue = [...exchanges];
  const sent: { method: string; path: string; requestId: string | null; body: unknown }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.pathname === "/v1/oauth2/token") return Response.json({ access_token: "replay-token", expires_in: 32_400 });
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    sent.push({ method, path: u.pathname, requestId: new Headers(init.headers).get("paypal-request-id"), body });
    const next = queue.shift();
    if (!next || next.request.method !== method || next.request.path !== `${u.pathname}${u.search}`) {
      return Response.json({ name: "NOT_RECORDED", message: `${method} ${u.pathname}` }, { status: 400 });
    }
    return Response.json(next.response.json, { status: next.response.status });
  }) as typeof fetch;
  return { rail: new PayPalRail({ config: TEST_PAYPAL_CONFIG, fetch: fetchFn, sleep: noWait, ...(settleReads ? { settleReads } : {}) }), sent };
}

describe("PayPal adapter against recorded sandbox exchanges", () => {
  it("PO-15: the recorded batch had the adapter's shape: one USD item, sender ids from the reservation, and the request id", () => {
    expect(createdBody.items).toHaveLength(1);
    expect(createdBody.items[0]).toMatchObject({ receiver: SUPPLIER, amount: { value: "1.00", currency: "USD" }, sender_item_id: KEY });
    expect(created.request.paypal_request_id).toBe(payoutRequestId(KEY));
    expect(created.response).toMatchObject({ status: 201, json: { batch_header: { batch_status: "PENDING" } } });
  });

  it("PO-15, PO-16: replays the recorded $1.00 payout: PENDING at first, SUCCESS on the fourth read, settled with the item ID", async () => {
    const { rail, sent } = replay([created, ...reads]);
    const result = await rail.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("1.00"), idempotencyKey: KEY });
    const item = (reads[3]?.response.json as { items: { payout_item_id: string }[] }).items[0]?.payout_item_id;
    expect(result).toEqual({ ok: true, ref: item, settledMicros: micros(1_000_000n) });
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    // The recorded item also had a probe `note`, which the adapter doesn't send.
    const recordedItem = Object.fromEntries(Object.entries(createdBody.items[0] ?? {}).filter(([name]) => name !== "note"));
    expect(sent[0]?.body).toMatchObject({ sender_batch_header: { sender_batch_id: KEY }, items: [recordedItem] });
    expect(sent[0]?.requestId).toBe(payoutRequestId(KEY));
  });

  it("PO-25: with fewer reads than PayPal took, the recorded payout comes back unknown with its batch ID", async () => {
    const { rail } = replay([created, ...reads.slice(0, 3)], 3);

    expect(await rail.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("1.00"), idempotencyKey: KEY })).toMatchObject({ ok: false, code: "RAIL_TIMEOUT", pendingRef: BATCH });
  });

  it("PO-5: both recorded repeats were refused as a duplicate batch with a link to it, and the adapter reads that batch instead of failing", async () => {
    for (const repeat of [sameRequest, newRequest]) {
      expect(repeat.response).toMatchObject({ status: 400, json: { name: "USER_BUSINESS_ERROR", details: [{ field: "SENDER_BATCH_ID" }] } });
    }
    const { rail, sent } = replay([sameRequest, reads[4] ?? reads[3]!]);
    expect(await rail.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("1.00"), idempotencyKey: KEY })).toMatchObject({ ok: true });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/payments/payouts", `GET /v1/payments/payouts/${BATCH}`]);
  });

  it("PO-25, RAIL-22: lookup reads the recorded batch by its stored ID: PENDING stays unknown, SUCCESS settles", async () => {
    const pending = replay([reads[0]!]);
    expect(await pending.rail.lookup(KEY, { railRef: BATCH })).toEqual({ status: "unknown" });
    const done = replay([reads[4]!]);
    expect(await done.rail.lookup(KEY, { railRef: BATCH })).toMatchObject({ status: "settled", settledMicros: micros(1_000_000n) });
    expect([...pending.sent, ...done.sent].map((s) => s.method)).toEqual(["GET", "GET"]);
  });

  it("PO-16, PO-22: the recorded $0.00 payout was accepted, then its item FAILED (ZERO_AMOUNT): the adapter refuses it before any call", async () => {
    const zeroRead = step("read $0.00 batch")[0];
    expect(zeroRead?.response.json).toMatchObject({ items: [{ transaction_status: "FAILED", errors: { name: "ZERO_AMOUNT" } }] });
    const { rail, sent } = replay([]);
    expect(await rail.payout({ destination: SUPPLIER, amountMicros: fromDecimalString("0.00"), idempotencyKey: KEY })).toMatchObject({ ok: false, code: "BELOW_RAIL_MINIMUM" });
    expect(sent).toEqual([]);
  });

  it("PO-25: the recording shows no read-only lookup by sender_batch_id, which is why the batch ID is stored", () => {
    expect(step("lookup by sender_batch_id").map((e) => e.response.status)).toEqual([404, 400]);
  });
});
