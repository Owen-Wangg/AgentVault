import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { StripeApi, StripeApiError, StripeResponseError } from "./stripe-api";

const KEY = "sk_test_supersecret";

function recordingFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("StripeApi", () => {
  it("RAIL-7: sends form-encoded posts with the key, the preview version, and the idempotency key", async () => {
    const { fetch, calls } = recordingFetch(() => Response.json({ id: "spt_1" }));
    const api = new StripeApi({ secretKey: KEY, fetch });
    await expect(api.post("/v1/x", { "usage_limits[max_amount]": "50" }, { idempotencyKey: "k1" })).resolves.toEqual({ id: "spt_1" });
    const [call] = calls;
    expect(call?.url).toBe("https://api.stripe.com/v1/x");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe("usage_limits%5Bmax_amount%5D=50");
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "stripe-version": "2026-09-30.preview",
      "idempotency-key": "k1",
      "content-type": "application/x-www-form-urlencoded",
    });
  });

  it("PO-22: sends API v2 posts as JSON with the version and idempotency key", async () => {
    const { fetch, calls } = recordingFetch(() => Response.json({ id: "acct_1" }));
    const api = new StripeApi({ secretKey: KEY, fetch });
    const body = { configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } } };
    await expect(api.postJson("/v2/core/accounts", body, { idempotencyKey: "k2", apiVersion: "2026-10-28.endive" })).resolves.toEqual({ id: "acct_1" });
    const [call] = calls;
    expect(call?.url).toBe("https://api.stripe.com/v2/core/accounts");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual(body);
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "stripe-version": "2026-10-28.endive",
      "idempotency-key": "k2",
      "content-type": "application/json",
    });
  });

  it("puts GET parameters in the query string", async () => {
    const { fetch, calls } = recordingFetch(() => Response.json({ data: [] }));
    await new StripeApi({ secretKey: KEY, fetch }).get("/v1/refunds", { "created[gte]": "1", limit: "100" });
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/refunds?created%5Bgte%5D=1&limit=100");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("turns Stripe errors into StripeApiError with the type and code", async () => {
    const { fetch } = recordingFetch(() =>
      Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent" } }, { status: 404 }),
    );
    const error = await new StripeApi({ secretKey: KEY, fetch }).get("/v1/payment_intents/pi_x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({ status: 404, type: "invalid_request_error", code: "resource_missing" });
  });

  it("RAIL-5: an unreadable answer is a StripeResponseError", async () => {
    const { fetch } = recordingFetch(() => new Response("<html>", { status: 502 }));
    await expect(new StripeApi({ secretKey: KEY, fetch }).get("/v1/x")).rejects.toBeInstanceOf(StripeResponseError);
  });

  it("RAIL-7: an inspected client doesn't show the key", () => {
    expect(inspect(new StripeApi({ secretKey: KEY }), { depth: 5, showHidden: true })).not.toContain("supersecret");
  });
});
