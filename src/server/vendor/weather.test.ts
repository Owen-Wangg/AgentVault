import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { X402Rail } from "@/rails/x402/adapter";
import { WEATHER_PRICE, createWeatherHandler, weatherRoute } from "./weather";

const PAY_TO = "0xd745eC24ec60c187Ae5e37be344BB8215eC2cb8b";
const URL_ = "http://localhost:3000/vendor/api/weather";
const TX = `0x${"cd".repeat(32)}`;

/** A facilitator that accepts every payment, and records what it was asked to settle. */
function fakeFacilitator(over: Partial<FacilitatorClient> = {}) {
  const settled: unknown[] = [];
  const facilitator: FacilitatorClient = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }),
    verify: async (payload) => ({ isValid: true, payer: (payload.payload as { authorization: { from: string } }).authorization.from }),
    settle: async (payload) => {
      settled.push(payload);
      return { success: true, transaction: TX, network: "eip155:84532", payer: (payload.payload as { authorization: { from: string } }).authorization.from };
    },
    ...over,
  };
  return { facilitator, settled };
}

const asFetch = (handler: (r: NextRequest) => Promise<Response>) =>
  (async (url: string, init?: RequestInit) => handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]))) as typeof fetch;

describe("GET /vendor/api/weather", () => {
  it("RAIL-10: an unpaid request gets 402 with exact-scheme requirements for Base Sepolia USDC at $0.0015", async () => {
    const handler = createWeatherHandler({ payTo: PAY_TO, facilitator: fakeFacilitator().facilitator });
    const response = await handler(new NextRequest(URL_));
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
    expect(required.accepts).toEqual([
      { scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "1500", payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } },
    ]);
    expect(WEATHER_PRICE).toBe(fromDecimalString("0.0015"));
  });

  it("RAIL-10, RAIL-11: the x402 adapter pays it, the facilitator settles, and the report comes back", async () => {
    const { facilitator, settled } = fakeFacilitator();
    const handler = createWeatherHandler({ payTo: PAY_TO, facilitator });
    const rail = new X402Rail({ account: privateKeyToAccount(`0x${"42".repeat(32)}`), minUnits: 1000n, fetch: asFetch(handler) });
    const result = await rail.execute({ vendorUrl: URL_, approvedMicros: micros(1500n), idempotencyKey: "res-1" }, { reservedAt: new Date() });
    expect(result).toMatchObject({ ok: true, ref: TX, settledMicros: 1500n, vendorBody: { vendor: "nimbus-weather", temperature_c: "11.5" } });
    expect(settled).toHaveLength(1);
  });

  it("RAIL-10: a payment the facilitator rejects gets 402 and no report", async () => {
    const { facilitator } = fakeFacilitator({ verify: async () => ({ isValid: false, invalidReason: "amount_too_low" }) });
    const handler = createWeatherHandler({ payTo: PAY_TO, facilitator });
    const rail = new X402Rail({ account: privateKeyToAccount(`0x${"42".repeat(32)}`), minUnits: 1000n, fetch: asFetch(handler) });
    const result = await rail.execute({ vendorUrl: URL_, approvedMicros: micros(1500n), idempotencyKey: "res-2" }, { reservedAt: new Date() });
    expect(result).toMatchObject({ ok: false, code: "INVALID_RAIL_RESPONSE" });
  });

  it("RAIL-12: a settled response carries the transaction in PAYMENT-RESPONSE", async () => {
    const { facilitator } = fakeFacilitator();
    const handler = createWeatherHandler({ payTo: PAY_TO, facilitator });
    let header: string | null = null;
    const recording = (async (url: string, init?: RequestInit) => {
      const response = await asFetch(handler)(url, init);
      header = response.headers.get("PAYMENT-RESPONSE") ?? header;
      return response;
    }) as typeof fetch;
    const rail = new X402Rail({ account: privateKeyToAccount(`0x${"42".repeat(32)}`), minUnits: 1000n, fetch: recording });
    await rail.execute({ vendorUrl: URL_, approvedMicros: micros(1500n), idempotencyKey: "res-3" }, { reservedAt: new Date() });
    expect(decodePaymentResponseHeader(header ?? "")).toMatchObject({ success: true, transaction: TX, network: "eip155:84532" });
  });

  it("RAIL-9: without the vendor's x402 variables it answers 503 and names nothing secret", async () => {
    const response = await weatherRoute(new NextRequest(URL_), { CDP_API_KEY_SECRET: "top-secret-value" });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "VENDOR_NOT_CONFIGURED" });
    expect(text).not.toContain("top-secret-value");
  });
});
