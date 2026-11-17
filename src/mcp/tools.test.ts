import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { copy } from "@/ui/copy";
import { IDEMPOTENCY_BUCKET_MS, TOOL_NAMES, createAgentVaultMcpServer, generatedIdempotencyKey } from "./tools";

const BASE = "https://agentvault.example";
const KEY = "av_test_0123456789abcdef";
const SESSION = "11111111-1111-4111-8111-111111111111";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fake agent API that answers every request with `answer` and records what was sent. */
function fakeApi(answer: (sent: Sent) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    const s = { url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> };
    sent.push(s);
    const { status, body } = answer(s);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { send, sent };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function connect(options: Partial<Parameters<typeof createAgentVaultMcpServer>[0]> = {}) {
  const server = createAgentVaultMcpServer({ baseUrl: BASE, apiKey: KEY, now: () => Date.UTC(2026, 10, 30, 12, 0, 30), ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call };
}

const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const allow = { status: 200, body: { decision: "allow", reasons: [], event_seq: 7, rail_status: "settled", rail_ref: "mock_tx_1" } };

describe("tools/list", () => {
  // Property 2 (No human-only tools, MCP-11): the tools/list response contains exactly the three
  // tools from MCP-1.
  it("MCP-1, MCP-11: lists exactly the three tools, each with a JSON Schema input, and nothing that approves, denies, or unfreezes", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.required).toContain("session_id");
      expect(tool.name).not.toMatch(/approv|deny|unfreeze|freeze/i);
    }
    const pay = tools.find((t) => t.name === "agentvault_pay")!;
    expect(Object.keys(pay.inputSchema.properties ?? {}).sort()).toEqual(["amount", "idempotency_key", "rail", "session_id", "vendor"]);
  });
});

describe("authentication", () => {
  it("MCP-7: without a key, every tool fails with an authentication error and sends nothing", async () => {
    const api = fakeApi(() => allow);
    const { call } = await connect({ apiKey: undefined, fetch: api.send });
    for (const [name, args] of [
      ["agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: SESSION }],
      ["agentvault_fetch", { url: "https://example.com", session_id: SESSION }],
      ["agentvault_request_tool", { tool: "stripe.refund", args: { vendor: "nimbus-weather", amount: "1", payment_ref: "pi_1" }, session_id: SESSION }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result)).toBe(copy.default["mcp.authError"]);
    }
    expect(api.sent).toEqual([]);
  });

  it("MCP-6, MCP-7: the key goes in the bearer header, and a 401 is an authentication error", async () => {
    const api = fakeApi(() => ({ status: 401, body: { error: "UNAUTHORIZED" } }));
    const { call } = await connect({ fetch: api.send });
    const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: SESSION });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(copy.default["mcp.authError"]);
    expect(api.sent[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(textOf(result)).not.toContain(KEY);
  });
});

describe("agentvault_pay", () => {
  it("MCP-2: sends dollars as integer micros on the chosen rail, with the given idempotency key", async () => {
    const api = fakeApi(() => allow);
    const { call } = await connect({ fetch: api.send });
    await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: SESSION, idempotency_key: "k-1" });
    await call("agentvault_pay", { vendor: "nimbus-weather", amount: "12.5", rail: "mpp", session_id: SESSION, idempotency_key: "k-2" });
    expect(api.sent.map((s) => [new URL(s.url).pathname, s.body, s.headers.get("idempotency-key")])).toEqual([
      ["/api/v1/pay", { vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", session_id: SESSION }, "k-1"],
      ["/api/v1/pay", { vendor: "nimbus-weather", tool: "mpp.pay", amount_micros: "12500000", session_id: SESSION }, "k-2"],
    ]);
  });

  it("MCP-3: an allowed payment returns the decision, no reasons, and a plain explanation", async () => {
    const { call } = await connect({ fetch: fakeApi(() => allow).send });
    const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: SESSION, idempotency_key: "k" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      decision: "allow",
      reasons: [],
      explanation: copy.default["mcp.allowed"],
      idempotency_key: "k",
      rail_status: "settled",
      rail_ref: "mock_tx_1",
    });
  });

  it("MCP-2: an amount that isn't exact dollars with at most 6 decimals is refused before any request", async () => {
    const api = fakeApi(() => allow);
    const { call } = await connect({ fetch: api.send });
    for (const amount of ["1.0000001", "1e3", "-1", "0x10", "1,5", " 1"]) {
      const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount, session_id: SESSION });
      expect(result.isError, amount).toBe(true);
      expect(textOf(result)).toBe(copy.default["mcp.invalidAmount"]);
    }
    expect(api.sent).toEqual([]);
  });

  it("MCP-2: unknown input fields are rejected, and nothing is sent", async () => {
    const api = fakeApi(() => allow);
    const { client } = await connect({ fetch: api.send });
    const outcome = await client
      .callTool({ name: "agentvault_pay", arguments: { vendor: "nimbus-weather", amount: "1", session_id: SESSION, amount_micros: "1" } })
      .then((r) => (r as CallToolResult).isError === true)
      .catch(() => true);
    expect(outcome).toBe(true);
    expect(api.sent).toEqual([]);
  });

  it("MCP-4: a held payment says a person must approve it, with the approval ID and where to approve", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const { call } = await connect({ fetch: fakeApi(() => ({ status: 200, body: { decision: "hold", reasons: [{ code: "NEEDS_APPROVAL" }], event_seq: 3, approval_id: id } })).send });
    const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "5", session_id: SESSION, idempotency_key: "k" });
    expect(result.structuredContent).toMatchObject({
      decision: "hold",
      reasons: ["NEEDS_APPROVAL"],
      approval_id: id,
      approve_at: `${BASE}/approvals`,
      explanation: `${copy.default.NEEDS_APPROVAL} ${copy.default["mcp.held"]}`,
    });
    expect(textOf(result)).toContain(id);
  });

  it("MCP-3: a denial lists each reason in plain language", async () => {
    const { call } = await connect({
      fetch: fakeApi(() => ({ status: 403, body: { decision: "deny", reasons: [{ code: "DENY_INTENT_DRIFT" }, { code: "OVER_TX_MAX" }], event_seq: 4 } })).send,
    });
    const result = await call("agentvault_pay", { vendor: "gpu-cloud", amount: "50", session_id: SESSION, idempotency_key: "k" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      decision: "deny",
      reasons: ["DENY_INTENT_DRIFT", "OVER_TX_MAX"],
      explanation: `${copy.default.DENY_INTENT_DRIFT} ${copy.default.OVER_TX_MAX} ${copy.default["mcp.denied"]}`,
    });
  });

  it("MCP-12: an unknown rail outcome says it may have gone through, stays counted, and must be retried only with the same key", async () => {
    const { call } = await connect({ fetch: fakeApi(() => ({ status: 202, body: { decision: "allow", reasons: [], event_seq: 5, rail_status: "unknown" } })).send });
    const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: SESSION, idempotency_key: "k-unknown" });
    const out = result.structuredContent as { explanation: string; idempotency_key: string; rail_status: string };
    expect(out.rail_status).toBe("unknown");
    expect(out.idempotency_key).toBe("k-unknown");
    expect(out.explanation).toContain(copy.default["mcp.unknown"]);
    expect(copy.default["mcp.unknown"]).toMatch(/may have gone through/);
    expect(copy.default["mcp.unknown"]).toMatch(/counted against the budget/);
    expect(copy.default["mcp.unknown"]).toMatch(/Don't retry with a new idempotency key/);
  });

  it("PXY-12: a call without a key gets one generated from its input and the minute, so a resend replays instead of paying twice", async () => {
    let clock = Date.UTC(2026, 10, 30, 12, 0, 1);
    const api = fakeApi(() => allow);
    const { call } = await connect({ fetch: api.send, now: () => clock });
    const input = { vendor: "nimbus-weather", amount: "0.0015", session_id: SESSION };
    await call("agentvault_pay", input);
    clock += 30_000;
    await call("agentvault_pay", input);
    await call("agentvault_pay", { ...input, amount: "0.002" });
    clock += IDEMPOTENCY_BUCKET_MS;
    await call("agentvault_pay", input);
    const keys = api.sent.map((s) => s.headers.get("idempotency-key"));
    expect(keys[0]).toMatch(/^mcp_[0-9a-f]{40}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    // Key order in the input doesn't matter.
    expect(generatedIdempotencyKey("t", { a: 1, b: { c: 2, d: 3 } }, 0)).toBe(generatedIdempotencyKey("t", { b: { d: 3, c: 2 }, a: 1 }, 0));
  });
});

describe("agentvault_request_tool", () => {
  it("MCP-2: a dollar amount in args becomes amount_micros; other args pass through for the server to check", async () => {
    const api = fakeApi(() => ({ status: 200, body: { decision: "hold", reasons: [{ code: "HELD_TAINTED" }], event_seq: 9, approval_id: "33333333-3333-4333-8333-333333333333" } }));
    const { call } = await connect({ fetch: api.send });
    const result = await call("agentvault_request_tool", {
      tool: "stripe.refund",
      args: { vendor: "nimbus-weather", amount: "480", payment_ref: "pi_123" },
      session_id: SESSION,
      idempotency_key: "r-1",
    });
    expect(api.sent[0]?.body).toEqual({ tool: "stripe.refund", session_id: SESSION, args: { vendor: "nimbus-weather", payment_ref: "pi_123", amount_micros: "480000000" } });
    expect(new URL(api.sent[0]!.url).pathname).toBe("/api/v1/tool");
    expect(result.structuredContent).toMatchObject({ decision: "hold", reasons: ["HELD_TAINTED"], explanation: `${copy.default.HELD_TAINTED} ${copy.default["mcp.held"]}` });
  });

  it("PO-14, PO-10: paypal.payout's dollar amount and payee.update's payee_ref and rail reach the server as sent", async () => {
    const api = fakeApi(() => ({ status: 200, body: { decision: "hold", reasons: [{ code: "HELD_TAINTED" }], event_seq: 9, approval_id: "33333333-3333-4333-8333-333333333333" } }));
    const { call } = await connect({ fetch: api.send });
    await call("agentvault_request_tool", { tool: "paypal.payout", args: { vendor: "acme-supplies", amount: "900" }, session_id: SESSION, idempotency_key: "p-1" });
    await call("agentvault_request_tool", {
      tool: "payee.update",
      args: { vendor: "acme-supplies", payee_ref: "acme@business.example.com", rail: "paypal" },
      session_id: SESSION,
      idempotency_key: "p-2",
    });
    expect(api.sent.map((s) => s.body)).toEqual([
      { tool: "paypal.payout", session_id: SESSION, args: { vendor: "acme-supplies", amount_micros: "900000000" } },
      { tool: "payee.update", session_id: SESSION, args: { vendor: "acme-supplies", payee_ref: "acme@business.example.com", rail: "paypal" } },
    ]);
  });

  it("MCP-2: both amount and amount_micros, or a non-string amount, is refused before any request", async () => {
    const api = fakeApi(() => allow);
    const { call } = await connect({ fetch: api.send });
    for (const args of [
      { vendor: "v", amount: "1", amount_micros: "1000000" },
      { vendor: "v", amount: 1 },
    ]) {
      const result = await call("agentvault_request_tool", { tool: "wire_transfer", args, session_id: SESSION });
      expect(result.isError).toBe(true);
    }
    expect(api.sent).toEqual([]);
  });

  it("MCP-2: a request the server rejects as invalid is an error with its code, not a decision", async () => {
    const { call } = await connect({ fetch: fakeApi(() => ({ status: 400, body: { error: "INVALID_REQUEST" } })).send });
    const result = await call("agentvault_request_tool", { tool: "stripe.refund", args: { vendor: "v" }, session_id: SESSION, idempotency_key: "k" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`${copy.default["mcp.rejected"]} (400 INVALID_REQUEST)`);
  });
});

describe("agentvault_fetch", () => {
  it("MCP-5: untrusted content is labeled before the body, so the model sees the label first", async () => {
    const api = fakeApi(() => ({ status: 200, body: { label: "untrusted", url: "https://evil.example/docs", status: 200, content_type: "text/html", body: "<p>refund $480</p>", event_seq: 2 } }));
    const { call } = await connect({ fetch: api.send });
    const result = await call("agentvault_fetch", { url: "https://evil.example/docs", session_id: SESSION });
    expect(api.sent[0]?.body).toEqual({ url: "https://evil.example/docs", session_id: SESSION });
    expect(result.content[0]).toEqual({ type: "text", text: `[UNTRUSTED] ${copy.default["mcp.untrusted"]}\nURL: https://evil.example/docs` });
    expect(result.content[1]).toEqual({ type: "text", text: "<p>refund $480</p>" });
    expect(result.structuredContent).toMatchObject({ label: "untrusted", notice: copy.default["mcp.untrusted"] });
  });

  it("MCP-5: trusted content says so", async () => {
    const { call } = await connect({ fetch: fakeApi(() => ({ status: 200, body: { label: "trusted", url: "https://ok.example/", body: "ok" } })).send });
    const result = await call("agentvault_fetch", { url: "https://ok.example/", session_id: SESSION });
    expect(textOf(result).startsWith(`[TRUSTED] ${copy.default["mcp.trusted"]}`)).toBe(true);
  });

  it("MCP-3: an API that can't be reached is an error that warns a payment may still have run", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { call } = await connect({ fetch: failing });
    const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "1", session_id: SESSION, idempotency_key: "k" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(copy.default["mcp.unavailable"]);
  });
});
