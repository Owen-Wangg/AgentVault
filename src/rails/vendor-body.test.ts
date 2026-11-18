import { describe, expect, it } from "vitest";
import { readVendorJson } from "./vendor-body";

const json = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "application/json", ...headers } });

/** A body that yields `chunks` of `size` bytes, and counts how many it was asked for. */
function streamOf(chunks: number, size: number) {
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close();
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return { state, response: new Response(body, { headers: { "content-type": "application/json" } }) };
}

describe("RAIL-12: readVendorJson", () => {
  it("RAIL-12: parses a JSON body under the limit", async () => {
    expect(await readVendorJson(json('{"ok":true}'))).toEqual({ ok: true });
  });

  it("RAIL-12: reads multi-byte text across the body", async () => {
    expect(await readVendorJson(json('{"name":"café ☕"}'))).toEqual({ name: "café ☕" });
  });

  it("RAIL-12: returns undefined for a body that isn't JSON or doesn't parse", async () => {
    expect(await readVendorJson(new Response("{}", { headers: { "content-type": "text/plain" } }))).toBeUndefined();
    expect(await readVendorJson(json("not json"))).toBeUndefined();
    expect(await readVendorJson(new Response(null, { headers: { "content-type": "application/json" } }))).toBeUndefined();
  });

  it("RAIL-12: doesn't read a body whose declared length is over the limit", async () => {
    const { state, response } = streamOf(10, 100);
    const declared = new Response(response.body, { headers: { "content-type": "application/json", "content-length": "1000" } });
    expect(await readVendorJson(declared, 500)).toBeUndefined();
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("RAIL-12: stops reading a body that turns out larger than the limit", async () => {
    const { state, response } = streamOf(1000, 100);
    expect(await readVendorJson(response, 450)).toBeUndefined();
    // It read just past the limit and quit, not the 100 KB the vendor was willing to send.
    expect(state.pulled).toBeLessThan(20);
  });
});
