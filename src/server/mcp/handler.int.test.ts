import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import { hashApiKey } from "@/server/auth/agent-keys";
import { agents, approvals, sessions, spendReservations, tasks } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, eventsOf, expectAuditBeforeSpend } from "@/server/payments/test-fixtures";
import { copy } from "@/ui/copy";
import { handleMcp } from "./handler";
import { MCP_PRESETS } from "./provision";
import { BASE_URL, DOCS_URL, httpClient, mcpRouteDeps, mcpScene, textOf } from "./test-fixtures";

/**
 * /api/mcp end to end: an MCP client over Streamable HTTP, the route's
 * handler, the pay, tool, and fetch handlers, and the database. The agent
 * comes from createMcpAgent, as `pnpm mcp:agent` makes it.
 */

let database: Awaited<ReturnType<typeof createTestDb>>;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDb();
}, 60_000);

afterAll(async () => {
  if (database) await expectAuditBeforeSpend(database.db);
  await database?.close();
});

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("pnpm mcp:agent", () => {
  it("MCP-6: creates an agent with a working key, a task with the preset's scope, a session, and an audit event", async () => {
    const clock = new FakeClock();
    const { sandboxId, agent } = await mcpScene(db(), clock, "weather");
    const [row] = await db().select().from(agents).where(eq(agents.id, agent.agentId));
    expect(row).toMatchObject({ workspaceId: sandboxId, name: "mcp-weather-agent", apiKeyHash: hashApiKey(agent.apiKey), frozenAt: null });
    const [session] = await db().select().from(sessions).where(eq(sessions.id, agent.sessionId));
    const [task] = await db().select().from(tasks).where(eq(tasks.id, session!.taskId));
    expect(task).toMatchObject({
      workspaceId: sandboxId,
      allowedVendorCategories: [...MCP_PRESETS.weather.task.allowedVendorCategories],
      allowedTools: [...MCP_PRESETS.weather.task.allowedTools],
      budgetMicros: MCP_PRESETS.weather.task.budgetMicros,
    });
    const last = (await eventsOf(db(), sandboxId)).at(-1);
    expect(last).toMatchObject({ seq: agent.eventSeq, type: "mcp_agent_created", payload: { agent_id: agent.agentId, session_id: agent.sessionId, preset: "weather", actor: "cli" } });
    expect(JSON.stringify(last)).not.toContain(agent.apiKey);
    expect((await verifyChain(db(), sandboxId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  });
});

describe("/api/mcp", () => {
  it("MCP-8, MCP-11: lists exactly the three tools over Streamable HTTP", async () => {
    const { deps } = mcpRouteDeps(db());
    const { client, close } = await httpClient(deps);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["agentvault_fetch", "agentvault_pay", "agentvault_request_tool"]);
    } finally {
      await close();
    }
  });

  it("MCP-2, MCP-3, MCP-6: a payment with the bearer key goes through the guarded flow and is in the audit chain", async () => {
    const clock = new FakeClock();
    const { deps, mocks } = mcpRouteDeps(db(), clock);
    const { sandboxId, agent } = await mcpScene(db(), clock);
    const { call, close } = await httpClient(deps, bearer(agent.apiKey));
    try {
      const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: agent.sessionId, idempotency_key: "mcp-pay-1" });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ decision: "allow", reasons: [], rail_status: "settled", idempotency_key: "mcp-pay-1" });
      const events = await eventsOf(db(), sandboxId);
      const decision = events.find((e) => e.type === "decision" && (e.payload as { agent_id?: string }).agent_id === agent.agentId);
      expect(decision?.payload).toMatchObject({ decision: "allow", request: { vendor: "nimbus-weather", tool: "x402.pay", amount_micros: "1500", idempotency_key: "mcp-pay-1" } });
      expect(mocks.x402.recorded()).toHaveLength(1);

      // The same key again replays: no second payment (PXY-12).
      const replay = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: agent.sessionId, idempotency_key: "mcp-pay-1" });
      expect(replay.structuredContent).toMatchObject({ decision: "allow" });
      expect(mocks.x402.recorded()).toHaveLength(1);
      expect((await verifyChain(db(), sandboxId, { key: TEST_HEAD_KEY })).ok).toBe(true);
    } finally {
      await close();
    }
  });

  it("MCP-7: without a bearer key, or with a wrong one, every tool call is an authentication error and nothing is recorded", async () => {
    const clock = new FakeClock();
    const { deps, mocks } = mcpRouteDeps(db(), clock);
    const { sandboxId, agent } = await mcpScene(db(), clock);
    const before = (await eventsOf(db(), sandboxId)).length;
    for (const headers of [{}, bearer("av_test_not_a_real_key"), { authorization: "Basic abc" }]) {
      const { call, close } = await httpClient(deps, headers);
      try {
        for (const [name, args] of [
          ["agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: agent.sessionId, idempotency_key: "x" }],
          ["agentvault_fetch", { url: DOCS_URL, session_id: agent.sessionId }],
          ["agentvault_request_tool", { tool: "stripe.refund", args: { vendor: "nimbus-weather", amount: "1", payment_ref: "pi_1" }, session_id: agent.sessionId }],
        ] as const) {
          const result = await call(name, args);
          expect(result.isError, `${name} ${JSON.stringify(headers)}`).toBe(true);
          expect(textOf(result)).toBe(copy.default["mcp.authError"]);
        }
      } finally {
        await close();
      }
    }
    expect(await eventsOf(db(), sandboxId)).toHaveLength(before);
    expect(mocks.x402.recorded()).toEqual([]);
    const [session] = await db().select().from(sessions).where(eq(sessions.id, agent.sessionId));
    expect(session?.taintedAt).toBeNull();
  });

  it("MCP-4, MCP-5: the poisoned page comes back labeled untrusted, and the refund it asks for is held for a person", async () => {
    const clock = new FakeClock();
    const { deps } = mcpRouteDeps(db(), clock);
    const { agent } = await mcpScene(db(), clock);
    const { call, close } = await httpClient(deps, bearer(agent.apiKey));
    try {
      const page = await call("agentvault_fetch", { url: DOCS_URL, session_id: agent.sessionId });
      expect(page.structuredContent).toMatchObject({ label: "untrusted", url: DOCS_URL });
      expect(textOf(page).startsWith("[UNTRUSTED]")).toBe(true);

      const refund = await call("agentvault_request_tool", {
        tool: "stripe.refund",
        args: { vendor: "nimbus-weather", amount: "480", payment_ref: "pi_3Uc9pZ3i6fxzvKeT0hGFL3nf" },
        session_id: agent.sessionId,
        idempotency_key: "mcp-refund-1",
      });
      const out = refund.structuredContent as { decision: string; reasons: string[]; approval_id: string; approve_at: string; explanation: string };
      // Held for the taint, and also because $480 is at or above the preset's $100 approval threshold (ENV-8).
      expect(out).toMatchObject({ decision: "hold", reasons: ["HELD_TAINTED", "NEEDS_APPROVAL"], approve_at: `${BASE_URL}/approvals` });
      expect(out.explanation).toContain(copy.default["mcp.held"]);
      const [approval] = await db().select().from(approvals).where(eq(approvals.id, out.approval_id));
      expect(approval?.status).toBe("pending");
      expect(approval?.request).toMatchObject({ agent_id: agent.agentId });
    } finally {
      await close();
    }
  });

  it("MCP-12: a rail timeout comes back as a possible payment that stays counted, to retry only with the same key", async () => {
    const clock = new FakeClock();
    const { deps, mocks } = mcpRouteDeps(db(), clock);
    const { agent } = await mcpScene(db(), clock);
    mocks.x402.setFailureMode("RAIL_TIMEOUT");
    const { call, close } = await httpClient(deps, bearer(agent.apiKey));
    try {
      const result = await call("agentvault_pay", { vendor: "nimbus-weather", amount: "0.0015", session_id: agent.sessionId, idempotency_key: "mcp-timeout-1" });
      const out = result.structuredContent as { decision: string; rail_status: string; explanation: string; idempotency_key: string };
      expect(out).toMatchObject({ decision: "allow", rail_status: "unknown", idempotency_key: "mcp-timeout-1" });
      expect(out.explanation).toContain(copy.default["mcp.unknown"]);
      const reservations = await db().select().from(spendReservations).where(eq(spendReservations.agentId, agent.agentId));
      expect(reservations.map((r) => r.status)).toEqual(["reserved"]);
    } finally {
      await close();
    }
  });

  it("MCP-8: the stateless endpoint has no event stream, and a request body over 64 KiB is refused", async () => {
    const { deps } = mcpRouteDeps(db());
    for (const method of ["GET", "DELETE"]) {
      const response = await handleMcp(new Request(`${BASE_URL}/api/mcp`, { method, headers: { accept: "text/event-stream" } }), deps);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const big = await handleMcp(
      new Request(`${BASE_URL}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70 * 1024) } }),
      }),
      deps,
    );
    expect(big.status).toBe(413);
  });
});
