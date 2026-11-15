import { generateProxy } from "mppx/discovery";
import { stripeChargeCents } from "@/rails/stripe-mpp/constants";
import { REPORT_DESCRIPTION, REPORT_PATH, REPORT_PRICE } from "./report";

/**
 * The MPP discovery document served at /openapi.json (rail-adapters task
 * 7, RAIL-18). `mppx validate` reads it to find the paid endpoints. It's
 * at the site root because the validator resolves each path against the
 * URL it is given, so `mppx validate <origin>` reaches /vendor/api/report.
 *
 * Static: it names the price and needs no Stripe variables. The x402
 * weather endpoint isn't listed, because it isn't an MPP endpoint.
 */
export function discoveryDocument(): Record<string, unknown> {
  return generateProxy({
    info: { title: "AgentVault demo vendor", version: "1.0.0" },
    routes: [
      {
        method: "get",
        path: REPORT_PATH,
        summary: REPORT_DESCRIPTION,
        payment: {
          method: "stripe",
          intent: "charge",
          // Stripe's smallest unit, as the challenge's own amount.
          amount: stripeChargeCents(REPORT_PRICE),
          currency: "usd",
          description: REPORT_DESCRIPTION,
        },
      },
    ],
  }) as Record<string, unknown>;
}
