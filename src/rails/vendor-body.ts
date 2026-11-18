/**
 * Reading a vendor's reply. The vendor is a third party, so its body is
 * read only up to a limit: a reply that declares more than the limit isn't
 * read at all, and one that turns out larger is abandoned mid-stream
 * instead of being held whole in memory first.
 */

export const MAX_VENDOR_BODY_BYTES = 64 * 1024;

/** The JSON body, or undefined if the reply isn't JSON, is over the limit, or doesn't parse. */
export async function readVendorJson(response: Response, maxBytes: number = MAX_VENDOR_BODY_BYTES): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return undefined;
  }
}
