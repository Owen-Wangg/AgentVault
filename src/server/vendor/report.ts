import { createHmac } from "node:crypto";
import { Mppx } from "mppx/server/core";
import { stripe } from "mppx/stripe/server/spt";
import Stripe from "stripe";
import { type Micros, fromDecimalString } from "@/core/money";
import { RailConfigError, type StripeConfig, loadStripeConfig } from "@/rails/config";
import { stripeChargeAmount } from "@/rails/stripe-mpp/constants";

/**
 * The demo vendor's paid report endpoint (rail-adapters task 7, RAIL-14,
 * RAIL-18). An unpaid request gets HTTP 402 with an MPP challenge for
 * $0.50, payable with a card through a Shared Payment Token (SPT). A paid
 * one is verified by creating a Stripe test-mode PaymentIntent with the
 * SPT, then answered with the report and a Payment-Receipt naming the
 * PaymentIntent.
 *
 * It uses mppx's SPT-only entry points (`mppx/server/core` and
 * `mppx/stripe/server/spt`). Stripe's guide shows
 * `stripe.create(...).defaultMethods()`, which in mppx 0.19 also offers
 * Tempo stablecoin payments and needs a shared atomic store; this
 * endpoint only takes cards and keeps no state between requests.
 *
 * The report is static: nothing in it is built from request input.
 */

export const REPORT_PATH = "/vendor/api/report";

/** What one report costs: Stripe's minimum for SPT card payments. */
export const REPORT_PRICE: Micros = fromDecimalString("0.50");

export const REPORT_DESCRIPTION = "Nimbus Weather: 7-day severe-weather outlook";

export const WEATHER_OUTLOOK_REPORT = {
  vendor: "nimbus-weather",
  report: "severe-weather-outlook",
  location: { lat: "49.28", lon: "-123.12", name: "Vancouver" },
  days: Array.from({ length: 7 }, (_, day) => ({ day, risk: day === 2 ? "moderate" : "low", hazard: day === 2 ? "wind" : "none" })),
} as const;

/**
 * The PaymentIntent metadata key the payer's reference goes into. The
 * Stripe adapter sends its rail idempotency key as the credential's
 * `externalId`, and its lookup() finds the payment by this key.
 */
export const PAYER_REFERENCE_METADATA_KEY = "idempotency_key";
const PAYER_REFERENCE = /^[A-Za-z0-9:_-]{1,200}$/;

/** The metadata for the PaymentIntent: the payer's reference if it is well formed, otherwise nothing. */
export function payerReferenceMetadata(externalId: unknown): Record<string, string> {
  return typeof externalId === "string" && PAYER_REFERENCE.test(externalId) ? { [PAYER_REFERENCE_METADATA_KEY]: externalId } : {};
}

/**
 * The key that signs challenges, derived from the Stripe key as Stripe's
 * MPP guide does, so the endpoint needs no extra secret. Challenges carry
 * an HMAC over their contents, so a client can't change the price.
 */
export function challengeSigningKey(stripeSecretKey: string): string {
  return createHmac("sha256", stripeSecretKey).update("mpp-challenge-signing").digest("base64");
}

/** The part of the Stripe SDK client mppx's SPT charge calls. */
export type StripeClientLike = Parameters<typeof stripe.charge>[0] extends infer P ? (P extends { client: infer C } ? C : never) : never;

export interface ReportVendorOptions {
  client: StripeClientLike;
  profileId: string;
  challengeKey: string;
  price?: Micros;
  /**
   * The challenge's realm: the public hostname. mppx defaults it to the
   * request URL's hostname, which on Vercel is the deployment's own
   * hostname, not the production domain clients call.
   */
  realm?: string;
}

export type ReportHandler = (request: Request) => Promise<Response>;

export function createReportHandler(options: ReportVendorOptions): ReportHandler {
  const mppx = Mppx.create({
    methods: [
      stripe.charge({
        client: options.client,
        networkId: options.profileId,
        currency: "usd",
        decimals: 2,
        paymentMethodTypes: ["card", "link"],
      }),
    ],
    secretKey: options.challengeKey,
    ...(options.realm ? { realm: options.realm } : {}),
  });
  const charge = mppx.charge({
    amount: stripeChargeAmount(options.price ?? REPORT_PRICE),
    description: REPORT_DESCRIPTION,
    paymentIntentOptions: ({ credential }) => ({ metadata: payerReferenceMetadata((credential.payload as { externalId?: unknown }).externalId) }),
  });
  return async (request) => {
    const result = await charge(request);
    if (result.status === 402) return result.challenge;
    return result.withReceipt(Response.json(WEATHER_OUTLOOK_REPORT, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }));
  };
}

/** The Stripe SDK client for the vendor: test mode only, with a request timeout under the rail's 30 seconds. */
export function vendorStripeClient(config: StripeConfig): Stripe {
  return new Stripe(config.secretKey(), { maxNetworkRetries: 1, timeout: 20_000, httpClient: Stripe.createFetchHttpClient() });
}

/** The hostname of APP_ORIGIN, or undefined if it's unset or not an http(s) URL. Then mppx uses the request's hostname. */
export function realmFrom(appOrigin: string | undefined): string | undefined {
  if (!appOrigin) return undefined;
  try {
    const url = new URL(appOrigin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

let cached: ReportHandler | null = null;

/** GET /vendor/api/report. Answers 503 until the Stripe variables are set (docs/SETUP.md, section 7). */
export async function reportRoute(request: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
  if (!cached) {
    let config: StripeConfig;
    try {
      config = loadStripeConfig(env);
    } catch (error) {
      // RailConfigError messages name variables, never values.
      console.error(`vendor report: ${error instanceof RailConfigError ? error.message : "configuration failed"}`);
      return Response.json({ error: "VENDOR_NOT_CONFIGURED" }, { status: 503 });
    }
    // APP_ORIGIN is the public origin (https://owen-agentvault.vercel.app on Vercel).
    const realm = realmFrom(env.APP_ORIGIN);
    cached = createReportHandler({
      client: vendorStripeClient(config),
      profileId: config.profileId,
      challengeKey: challengeSigningKey(config.secretKey()),
      ...(realm ? { realm } : {}),
    });
  }
  return cached(request);
}
