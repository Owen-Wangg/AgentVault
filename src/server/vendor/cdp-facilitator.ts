import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";

/**
 * The CDP-hosted x402 facilitator (rail-adapters design, "Vendor side").
 * This is what `createCdpFacilitatorClient` in `@coinbase/cdp-sdk/x402`
 * does, built from `@coinbase/cdp-sdk/auth` instead: that entry point
 * imports the SDK's Solana and extension modules, which this app doesn't
 * use or install. Each call signs a short-lived JWT bound to the
 * facilitator's host and one operation's path.
 */
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

export function cdpFacilitator(credentials: { apiKeyId: string; apiKeySecret: string }): HTTPFacilitatorClient {
  const { host, pathname } = new URL(CDP_FACILITATOR_URL);
  const headers = async (path: string, method: "GET" | "POST") => ({
    Authorization: `Bearer ${await generateJwt({ ...credentials, requestMethod: method, requestHost: host, requestPath: `${pathname}/${path}` })}`,
  });
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([headers("verify", "POST"), headers("settle", "POST"), headers("supported", "GET")]);
      return { verify, settle, supported };
    },
  });
}
