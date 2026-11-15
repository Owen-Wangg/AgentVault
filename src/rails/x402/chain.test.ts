import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { BaseSepoliaReader, ChainReadError } from "./chain";

type Handler = (method: string, params: unknown[]) => unknown;

/** A JSON-RPC endpoint that answers from `handler`, and records each method called. */
function fakeRpc(handler: Handler, chainId = "0x14a34") {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    calls.push(body.method);
    const result = body.method === "eth_chainId" ? chainId : handler(body.method, body.params);
    return Response.json(result instanceof Error ? { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: result.message } } : { jsonrpc: "2.0", id: body.id, result });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const agent = "0x1111111111111111111111111111111111111111" as const;
const nonce = `0x${"ab".repeat(32)}` as const;

describe("Base Sepolia reader", () => {
  it("RAIL-8: refuses to read from an endpoint on another chain", async () => {
    const { fetchFn, calls } = fakeRpc(() => "0x0", "0x2105"); // 8453, Base mainnet
    await expect(new BaseSepoliaReader({ fetch: fetchFn }).ethBalance(agent)).rejects.toThrow("not Base Sepolia");
    expect(calls).toEqual(["eth_chainId"]);
  });

  it("RAIL-21: reads authorizationState from the USDC contract", async () => {
    const seen: unknown[] = [];
    const { fetchFn } = fakeRpc((method, params) => {
      seen.push(params);
      return encodeAbiParameters([{ type: "bool" }], [true]);
    });
    expect(await new BaseSepoliaReader({ fetch: fetchFn }).authorizationUsed(agent, nonce, "finalized")).toBe(true);
    const [call, at] = seen[0] as [{ to: string; data: string }, string];
    expect(call.to).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(call.data.startsWith("0xe94a0102")).toBe(true); // authorizationState(address,bytes32)
    expect(call.data).toContain(nonce.slice(2));
    expect(at).toBe("finalized");
  });

  it("RAIL-5: rejects malformed results and RPC errors with a typed error", async () => {
    const bad = fakeRpc(() => ({ number: "12", timestamp: "0x1" }));
    await expect(new BaseSepoliaReader({ fetch: bad.fetchFn }).block("latest")).rejects.toBeInstanceOf(ChainReadError);
    const failing = fakeRpc(() => new Error("limited to a 200 range"));
    await expect(new BaseSepoliaReader({ fetch: failing.fetchFn }).block("latest")).rejects.toThrow("RPC error -32000");
  });

  it("RAIL-22: offers no method that sends a transaction", () => {
    const methods = Object.getOwnPropertyNames(BaseSepoliaReader.prototype);
    expect(methods.filter((m) => /send|sign|write|transfer/i.test(m))).toEqual([]);
  });
});
