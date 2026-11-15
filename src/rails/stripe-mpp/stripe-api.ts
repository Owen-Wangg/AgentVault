/**
 * A small Stripe REST client over an injected fetch (rail-adapters design,
 * "Stripe MPP adapter"). The payer adapter and the Stripe scripts use it
 * instead of the Stripe SDK so that every call takes an AbortSignal, and
 * so that tests can replay recorded exchanges through the same fetch.
 *
 * It never logs, and its errors carry Stripe's error type, code, and
 * message, never the request (which holds the secret key).
 */

export const STRIPE_API_ORIGIN = "https://api.stripe.com";
/**
 * The preview API version the SPT test helper needs. From Stripe's
 * "Shared payment tokens" guide for sellers ("Generate an SPT in a
 * sandbox"), checked during rail-adapters task 8.
 */
export const SPT_API_VERSION = "2026-09-30.preview";
/** The version Stripe's MPP guide uses for `GET /v2/network/business_profiles/me`. */
export const PROFILE_API_VERSION = "2026-07-29.preview";

export type StripeParams = Readonly<Record<string, string>>;

export interface StripeRequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  apiVersion?: string;
}

/** Stripe answered with an error. `status` is the HTTP status. */
export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/** Stripe's answer couldn't be read, so what happened is unknown. */
export class StripeResponseError extends Error {
  constructor(readonly status: number) {
    super(`Stripe answered ${status} with a body that isn't JSON`);
    this.name = "StripeResponseError";
  }
}

export interface StripeApiOptions {
  secretKey: string;
  fetch?: typeof fetch;
  apiVersion?: string;
}

export class StripeApi {
  readonly #secretKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiVersion: string;

  constructor(options: StripeApiOptions) {
    // A private field, so the key doesn't show when the client is logged or inspected.
    this.#secretKey = options.secretKey;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.apiVersion = options.apiVersion ?? SPT_API_VERSION;
  }

  get(path: string, params: StripeParams = {}, options: StripeRequestOptions = {}): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    return this.send("GET", query ? `${path}?${query}` : path, undefined, options);
  }

  post(path: string, params: StripeParams, options: StripeRequestOptions = {}): Promise<unknown> {
    return this.send("POST", path, new URLSearchParams(params).toString(), options);
  }

  private async send(method: "GET" | "POST", path: string, body: string | undefined, options: StripeRequestOptions): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#secretKey}`,
      "stripe-version": options.apiVersion ?? this.apiVersion,
    };
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await this.fetchFn(`${STRIPE_API_ORIGIN}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new StripeResponseError(response.status);
    }
    if (!response.ok) {
      const error = (json as { error?: { type?: unknown; code?: unknown; message?: unknown } } | null)?.error;
      throw new StripeApiError(
        response.status,
        typeof error?.type === "string" ? error.type : undefined,
        typeof error?.code === "string" ? error.code : undefined,
        typeof error?.message === "string" ? error.message : `Stripe answered ${response.status}`,
      );
    }
    return json;
  }
}
