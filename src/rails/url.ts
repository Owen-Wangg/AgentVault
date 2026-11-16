import type { RailResult } from "./types";

/**
 * A vendor payment URL the real adapters will contact: absolute http or
 * https. The guarded flow passes "" when the vendor has no payment URL
 * for the rail (rail-adapters RAIL-24).
 */
export function isPaymentUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:";
}

/** RAIL-24: no payment URL means a confirmed failure, before any vendor is contacted. */
export const NO_PAYMENT_URL: RailResult = { ok: false, code: "RAIL_REJECTED", detail: "the vendor has no payment URL for this rail; nothing was sent" };
