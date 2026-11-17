import { readFileSync } from "node:fs";
import type { PayPalConfig } from "../config";
import { PAYPAL_SANDBOX_API } from "../config";

/** A sandbox configuration with throwaway credentials, for tests. */
export const TEST_PAYPAL_CONFIG: Pick<PayPalConfig, "environment" | "apiOrigin" | "clientId" | "clientSecret"> = {
  environment: "sandbox",
  apiOrigin: PAYPAL_SANDBOX_API,
  clientId: "test-client-id",
  clientSecret: () => "test-client-secret",
};

export const SUPPLIER = "supplier@personal.example.com";

interface FakeItem {
  status: string;
  receiver: string;
  value: string;
  currency: string;
  senderItemId: string;
}
interface FakeBatch {
  id: string;
  senderBatchId: string;
  item: FakeItem;
  /** Item statuses the next reads report, in order; the last one repeats. */
  statuses: string[];
}

export type Reply = { status: number; json?: unknown; text?: string } | "abort" | "network";

/**
 * The parts of the PayPal sandbox the adapter uses: client-credential
 * tokens, payout batches with sender_batch_id uniqueness, and batch reads.
 * New batches report the statuses in `statuses`, one per read.
 */
export class FakePayPal {
  readonly batches = new Map<string, FakeBatch>();
  calls: { method: string; path: string; auth: string | null; requestId: string | null; body: unknown }[] = [];
  /** The next request to "METHOD path" gets this reply instead. */
  readonly override = new Map<string, Reply>();
  /** Item statuses for each new batch's reads. */
  statuses: string[] = ["PENDING", "SUCCESS"];
  tokensIssued = 0;
  tokenLifetimeSeconds = 32_400;
  private n = 0;

  readonly fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.origin !== PAYPAL_SANDBOX_API) throw new Error(`called ${u.origin}, not the sandbox`);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
    this.calls.push({ method, path: u.pathname, auth: headers.get("authorization"), requestId: headers.get("paypal-request-id"), body });
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const reply = this.override.get(`${method} ${u.pathname}`);
    if (reply) {
      this.override.delete(`${method} ${u.pathname}`);
      if (reply === "abort") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      if (reply === "network") throw new TypeError("fetch failed");
      return reply.text !== undefined ? new Response(reply.text, { status: reply.status }) : Response.json(reply.json ?? null, { status: reply.status });
    }
    if (method === "POST" && u.pathname === "/v1/oauth2/token") {
      this.tokensIssued += 1;
      return Response.json({ access_token: `fake-token-${this.tokensIssued}`, token_type: "Bearer", expires_in: this.tokenLifetimeSeconds });
    }
    if (!headers.get("authorization")?.startsWith("Bearer fake-token-")) return Response.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 });
    if (method === "POST" && u.pathname === "/v1/payments/payouts") return this.create(body as CreateBody);
    const read = /^\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/.exec(u.pathname);
    if (method === "GET" && read?.[1]) {
      const batch = this.batches.get(read[1]);
      return batch ? Response.json(this.show(batch)) : Response.json({ name: "INVALID_RESOURCE_ID" }, { status: 404 });
    }
    return Response.json({ name: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;

  private create(body: CreateBody): Response {
    const senderBatchId = body.sender_batch_header.sender_batch_id;
    const existing = [...this.batches.values()].find((b) => b.senderBatchId === senderBatchId);
    if (existing) {
      return Response.json(
        {
          name: "USER_BUSINESS_ERROR",
          message: "User business error.",
          details: [
            {
              field: "SENDER_BATCH_ID",
              location: "body",
              issue: "Batch with given sender_batch_id already exists",
              link: [{ href: `https://api.sandbox.paypal.com/v1/payments/payouts/${existing.id}`, rel: "self", method: "GET" }],
            },
          ],
        },
        { status: 400 },
      );
    }
    const [item] = body.items;
    this.n += 1;
    const batch: FakeBatch = {
      id: `FAKEBATCH${this.n}`,
      senderBatchId,
      item: { status: "PENDING", receiver: item?.receiver ?? "", value: item?.amount.value ?? "", currency: item?.amount.currency ?? "", senderItemId: item?.sender_item_id ?? "" },
      statuses: [...this.statuses],
    };
    this.batches.set(batch.id, batch);
    return Response.json({ batch_header: { payout_batch_id: batch.id, batch_status: "PENDING", sender_batch_header: { sender_batch_id: senderBatchId } } }, { status: 201 });
  }

  private show(batch: FakeBatch) {
    const next = batch.statuses.length > 1 ? batch.statuses.shift() : batch.statuses[0];
    batch.item.status = next ?? batch.item.status;
    return {
      batch_header: { payout_batch_id: batch.id, batch_status: batch.item.status === "SUCCESS" ? "SUCCESS" : "PROCESSING", sender_batch_header: { sender_batch_id: batch.senderBatchId } },
      items: [
        {
          payout_item_id: `ITEM${batch.id}`,
          transaction_status: batch.item.status,
          payout_batch_id: batch.id,
          payout_item: { recipient_type: "EMAIL", receiver: batch.item.receiver, sender_item_id: batch.item.senderItemId, amount: { currency: batch.item.currency, value: batch.item.value } },
        },
      ],
    };
  }

  /** Payout creation requests, the ones that could pay. */
  creates() {
    return this.calls.filter((c) => c.method === "POST" && c.path === "/v1/payments/payouts");
  }
}

interface CreateBody {
  sender_batch_header: { sender_batch_id: string };
  items: { receiver: string; amount: { value: string; currency: string }; sender_item_id: string }[];
}

/** Waits that return at once, for the adapter's batch reads. */
export const noWait = async () => {};

export interface PayPalExchange {
  step: string;
  request: { method: string; path: string; paypal_request_id: string | null; body: unknown };
  response: { status: number; json: unknown };
}

/** What `pnpm paypal:probe --record` captured in the sandbox, token and receivers scrubbed. */
export function loadPayPalRecording(): { recorded_at: string; exchanges: PayPalExchange[] } {
  return JSON.parse(readFileSync(new URL("../__fixtures__/paypal/payout-probe.json", import.meta.url), "utf8")) as { recorded_at: string; exchanges: PayPalExchange[] };
}
