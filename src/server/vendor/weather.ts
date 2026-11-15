import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { withX402 } from "@x402/next";
import { type NextRequest, NextResponse } from "next/server";
import { type Micros, fromDecimalString, toDisplay } from "@/core/money";
import { RailConfigError, type X402VendorConfig, loadX402VendorConfig } from "@/rails/config";
import { usdcAssetAmount } from "@/rails/x402/constants";
import { cdpFacilitator } from "./cdp-facilitator";

/**
 * The demo vendor's paid weather endpoint (rail-adapters task 4, RAIL-10).
 * An unpaid request gets HTTP 402 with x402 payment requirements for Base
 * Sepolia USDC. A paid one is verified and settled by the CDP facilitator,
 * then answered with the report. withX402 settles only after the handler
 * returns a success, so a failed handler charges nothing.
 *
 * The report is static: nothing in it is built from request input.
 */

export const WEATHER_PATH = "/vendor/api/weather";

/** What one call costs. Sub-cent on purpose: rail-adapters task 4 measured that the CDP facilitator settles it. */
export const WEATHER_PRICE: Micros = fromDecimalString("0.0015");

export const WEATHER_REPORT = {
  vendor: "nimbus-weather",
  location: { lat: "49.28", lon: "-123.12", name: "Vancouver" },
  temperature_c: "11.5",
  conditions: "light rain",
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, temperature_c: "11.5", conditions: "light rain" })),
} as const;

const handler = async (): Promise<NextResponse> =>
  NextResponse.json(WEATHER_REPORT, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export interface WeatherVendorOptions {
  payTo: X402VendorConfig["payTo"];
  price?: Micros;
  /** The CDP facilitator by default. Tests pass a fake. */
  facilitator: FacilitatorClient;
}

export type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export function createWeatherHandler(options: WeatherVendorOptions): RouteHandler {
  const server = new x402ResourceServer(options.facilitator).register("eip155:84532", new ExactEvmScheme());
  return withX402(
    handler,
    {
      accepts: [{ scheme: "exact", network: "eip155:84532", payTo: options.payTo, price: usdcAssetAmount(options.price ?? WEATHER_PRICE), maxTimeoutSeconds: 120 }],
      description: "Nimbus Weather: current conditions and a 24-hour forecast",
      mimeType: "application/json",
      // Browsers get this instead of x402's paywall page, which needs a package this app doesn't install.
      customPaywallHtml: `<!doctype html><title>Payment required</title><p>This demo endpoint charges ${toDisplay(options.price ?? WEATHER_PRICE)} in Base Sepolia test USDC per call over x402. Pay it with an x402 client.</p>`,
    },
    server,
  );
}

let cached: RouteHandler | null = null;

/** GET /vendor/api/weather. Answers 503 until the vendor's x402 variables are set (docs/SETUP.md, section 6). */
export async function weatherRoute(request: NextRequest, env: Record<string, string | undefined> = process.env): Promise<Response> {
  if (!cached) {
    let config: X402VendorConfig;
    try {
      config = loadX402VendorConfig(env);
    } catch (error) {
      // RailConfigError messages name variables, never values.
      console.error(`vendor weather: ${error instanceof RailConfigError ? error.message : "configuration failed"}`);
      return NextResponse.json({ error: "VENDOR_NOT_CONFIGURED" }, { status: 503 });
    }
    cached = createWeatherHandler({
      payTo: config.payTo,
      facilitator: cdpFacilitator({ apiKeyId: config.cdpApiKeyId, apiKeySecret: config.cdpApiKeySecret }),
    });
  }
  return cached(request);
}
