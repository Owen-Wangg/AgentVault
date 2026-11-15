import { Challenge, Credential, Receipt } from "mppx";
import { describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import {
  REPORT_PATH,
  WEATHER_OUTLOOK_REPORT,
  type StripeClientLike,
  challengeSigningKey,
  createReportHandler,
  payerReferenceMetadata,
  reportRoute,
} from "./report";

const PROFILE = "profile_test_61vendor";
const URL_ = `http://localhost:3000${REPORT_PATH}`;

function fakeStripe(answer: { id: string; status: string } | Error = { id: "pi_test_1", status: "succeeded" }) {
  const calls: { params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const client = {
    paymentIntents: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        calls.push({ params, options });
        if (answer instanceof Error) throw answer;
        return { ...answer, lastResponse: { headers: {} } };
      },
    },
  } as unknown as StripeClientLike;
  return { client, calls };
}

const handlerWith = (client: StripeClientLike, price = fromDecimalString("0.50")) =>
  createReportHandler({ client, profileId: PROFILE, challengeKey: challengeSigningKey("sk_test_vendor"), price });

async function challengeFrom(handler: ReturnType<typeof createReportHandler>) {
  const response = await handler(new Request(URL_));
  return { response, challenge: Challenge.fromResponse(response) };
}

const paid = (credential: string) => new Request(URL_, { headers: { authorization: credential } });

describe("MPP vendor endpoint /vendor/api/report", () => {
  it("RAIL-14: answers an unpaid request with a 402 MPP challenge for $0.50 by card", async () => {
    const { client, calls } = fakeStripe();
    const { response, challenge } = await challengeFrom(handlerWith(client));
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toMatch(/^Payment /);
    expect(challenge).toMatchObject({ method: "stripe", intent: "charge" });
    expect(challenge.request).toMatchObject({ amount: "50", currency: "usd", methodDetails: { networkId: PROFILE, paymentMethodTypes: ["card", "link"] } });
    expect(challenge.expires).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("RAIL-14, RAIL-16: charges the SPT once, tags the PaymentIntent with the payer's key, and returns a receipt", async () => {
    const { client, calls } = fakeStripe();
    const handler = handlerWith(client);
    const { challenge } = await challengeFrom(handler);
    const credential = Credential.serialize({ challenge, payload: { spt: "spt_test_1", externalId: "reservation-1" } });
    const response = await handler(paid(credential));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(WEATHER_OUTLOOK_REPORT)));
    expect(Receipt.fromResponse(response)).toMatchObject({ method: "stripe", status: "success", reference: "pi_test_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      amount: 50,
      currency: "usd",
      confirm: true,
      shared_payment_granted_token: "spt_test_1",
      metadata: { idempotency_key: "reservation-1", machine_payment: "true" },
    });
    // Stripe's own idempotency, scoped to the challenge and the SPT.
    expect(calls[0]?.options.idempotencyKey).toBe(`mpp_${challenge.id}_spt_test_1`);
  });

  it("RAIL-14: refuses a challenge whose price was changed, without charging", async () => {
    const { client, calls } = fakeStripe();
    const handler = handlerWith(client);
    const { challenge } = await challengeFrom(handler);
    const cheaper = { ...challenge, request: { ...challenge.request, amount: "1" } };
    const response = await handler(paid(Credential.serialize({ challenge: cheaper, payload: { spt: "spt_test_1" } })));
    expect(response.status).toBe(402);
    expect(calls).toHaveLength(0);
  });

  it("RAIL-14: refuses a challenge signed with another key, without charging", async () => {
    const { client, calls } = fakeStripe();
    const other = createReportHandler({ client, profileId: PROFILE, challengeKey: challengeSigningKey("sk_test_other") });
    const { challenge } = await challengeFrom(other);
    const response = await handlerWith(client)(paid(Credential.serialize({ challenge, payload: { spt: "spt_test_1" } })));
    expect(response.status).toBe(402);
    expect(calls).toHaveLength(0);
  });

  it("RAIL-14: a failed or incomplete PaymentIntent gets a new challenge, not the report", async () => {
    for (const answer of [new Error("Your card was declined."), { id: "pi_test_2", status: "requires_action" }]) {
      const { client } = fakeStripe(answer);
      const handler = handlerWith(client);
      const { challenge } = await challengeFrom(handler);
      const response = await handler(paid(Credential.serialize({ challenge, payload: { spt: "spt_test_2" } })));
      expect(response.status).toBe(402);
      expect(response.headers.get("payment-receipt")).toBeNull();
    }
  });

  it("RAIL-16: puts only a well-formed payer reference into the metadata", () => {
    expect(payerReferenceMetadata("7c0e0a52-1b7e-4f43-9d1e-1f0f5b8f2a10")).toEqual({ idempotency_key: "7c0e0a52-1b7e-4f43-9d1e-1f0f5b8f2a10" });
    for (const bad of [undefined, 42, "", "a b", "x".repeat(201), "<script>"]) expect(payerReferenceMetadata(bad)).toEqual({});
  });

  it("RAIL-7: answers 503 until the Stripe variables are set, and refuses a live key", async () => {
    for (const env of [{}, { STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PROFILE_ID: PROFILE }]) {
      const response = await reportRoute(new Request(URL_), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "VENDOR_NOT_CONFIGURED" });
    }
  });
});
