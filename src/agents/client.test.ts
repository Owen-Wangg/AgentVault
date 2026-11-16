import { describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { AgentApiError, AgentClient } from "./client";

const BASE = "https://agentvault.example";
const KEY = `av_test_${"a".repeat(43)}`;
const SESSION = "11111111-1111-4111-8111-111111111111";

/** A fetch that records each request and answers with the next canned response. */
function fakeFetch(...responses: { status: number; body: unknown }[]) {
  const requests: Request[] = [];
  const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { send, requests };
}

const client = (send: typeof fetch) => new AgentClient(BASE, KEY, SESSION, { fetch: send });

describe("AgentClient", () => {
  it("AGT-4: pay sends the agent API's request: bearer key, Idempotency-Key, and amount as a micros string", async () => {
    const { send, requests } = fakeFetch({ status: 200, body: { decision: "allow", reasons: [], event_seq: 3, rail_status: "settled", rail_ref: "mock_1" } });
    const result = await client(send).pay("nimbus-weather", fromDecimalString("0.0015"), "step-1");
    expect(result).toEqual({ status: 200, decision: "allow", reasons: [], eventSeq: 3, railStatus: "settled", railRef: "mock_1" });
    const [request] = requests;
    expect(request!.url).toBe(`${BASE}/api/v1/pay`);
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request!.headers.get("idempotency-key")).toBe("step-1");
    expect(request!.redirect).toBe("error");
    expect(await request!.json()).toEqual({ vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", session_id: SESSION });
  });

  it("AGT-4: a deny or hold is a result, with its reasons and approval", async () => {
    const approval = "22222222-2222-4222-8222-222222222222";
    const { send } = fakeFetch(
      { status: 403, body: { decision: "deny", reasons: [{ code: "VELOCITY_EXCEEDED", detail: { limit: "30" } }], event_seq: 9 } },
      { status: 202, body: { decision: "hold", reasons: [{ code: "HELD_TAINTED" }, { code: "NEEDS_APPROVAL" }], approval_id: approval, event_seq: 12 } },
    );
    const c = client(send);
    expect(await c.pay("nimbus-weather", fromDecimalString("0.0015"), "k1")).toEqual({
      status: 403,
      decision: "deny",
      reasons: [{ code: "VELOCITY_EXCEEDED", detail: { limit: "30" } }],
      eventSeq: 9,
    });
    expect(await c.tool("stripe.refund", { vendor: "nimbus-weather", amount_micros: "480000000", payment_ref: "pi_1" }, "k2")).toMatchObject({
      status: 202,
      decision: "hold",
      approvalId: approval,
    });
  });

  it("AGT-16: pay and tool send an advisory drift score only when one is given", async () => {
    const allow = { status: 200, body: { decision: "allow", reasons: [], event_seq: 1 } };
    const { send, requests } = fakeFetch(allow, allow, allow);
    const c = client(send);
    await c.pay("nimbus-weather", fromDecimalString("0.0015"), "k1", "x402.pay", { advisoryDriftScore: 12 });
    await c.tool("stripe.refund", { vendor: "v", amount_micros: "1", payment_ref: "pi_1" }, "k2", { advisoryDriftScore: 0 });
    await c.pay("nimbus-weather", fromDecimalString("0.0015"), "k3");
    expect(await requests[0]!.json()).toMatchObject({ advisory_drift_score: 12 });
    expect(await requests[1]!.json()).toMatchObject({ advisory_drift_score: 0 });
    expect(await requests[2]!.json()).not.toHaveProperty("advisory_drift_score");
  });

  it("AGT-4: tool sends the tool, session, and args", async () => {
    const { send, requests } = fakeFetch({ status: 403, body: { decision: "deny", reasons: [{ code: "TOOL_NOT_ALLOWED" }], event_seq: 1 } });
    await client(send).tool("stripe.refund", { vendor: "v", amount_micros: "1", payment_ref: "pi_1" }, "k");
    expect(requests[0]!.url).toBe(`${BASE}/api/v1/tool`);
    expect(await requests[0]!.json()).toEqual({ tool: "stripe.refund", session_id: SESSION, args: { vendor: "v", amount_micros: "1", payment_ref: "pi_1" } });
  });

  it("AGT-4: fetch returns the label, body, and taint event, and sends no Idempotency-Key", async () => {
    const { send, requests } = fakeFetch({ status: 200, body: { label: "untrusted", url: `${BASE}/docs`, status: 200, content_type: "text/html", body: "<p>hi</p>", event_seq: 4 } });
    expect(await client(send).fetch(`${BASE}/docs`)).toEqual({ label: "untrusted", url: `${BASE}/docs`, body: "<p>hi</p>", eventSeq: 4 });
    expect(requests[0]!.headers.has("idempotency-key")).toBe(false);
    expect(await requests[0]!.json()).toEqual({ url: `${BASE}/docs`, session_id: SESSION });
  });

  it("AGT-4: responses without a decision throw AgentApiError with the API's error code", async () => {
    const { send } = fakeFetch(
      { status: 401, body: { error: "UNAUTHORIZED" } },
      { status: 503, body: { error: "SERVICE_UNAVAILABLE", correlation_id: "x" } },
      { status: 400, body: { error: "FETCH_BLOCKED", event_seq: 2 } },
      { status: 409, body: { error: "IDEMPOTENCY_IN_PROGRESS" } },
    );
    const c = client(send);
    const amount = fromDecimalString("1");
    await expect(c.pay("v", amount, "k")).rejects.toEqual(new AgentApiError(401, "UNAUTHORIZED"));
    await expect(c.tool("stripe.refund", {}, "k")).rejects.toEqual(new AgentApiError(503, "SERVICE_UNAVAILABLE"));
    await expect(c.fetch("http://10.0.0.1/")).rejects.toEqual(new AgentApiError(400, "FETCH_BLOCKED"));
    await expect(c.pay("v", amount, "k")).rejects.toEqual(new AgentApiError(409, "IDEMPOTENCY_IN_PROGRESS"));
  });

  it("AGT-4: a response that doesn't match the API's shape is an error, never a decision", async () => {
    const { send } = fakeFetch(
      { status: 200, body: "not json" },
      { status: 200, body: { decision: "allowed", reasons: [], event_seq: 1 } },
      { status: 403, body: { decision: "deny", reasons: [{ code: "X", detail: { n: 1 } }], event_seq: 1 } },
      { status: 200, body: { decision: "allow", reasons: [] } },
      { status: 200, body: { label: "maybe", url: "u", body: "" } },
    );
    const c = client(send);
    const amount = fromDecimalString("1");
    for (const status of [200, 200, 403, 200]) await expect(c.pay("v", amount, "k")).rejects.toEqual(new AgentApiError(status, "UNEXPECTED_RESPONSE"));
    await expect(c.fetch("u")).rejects.toEqual(new AgentApiError(200, "UNEXPECTED_RESPONSE"));
  });
});
