import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentApiError, AgentClient } from "@/agents/client";
import { fromDecimalString } from "@/core/money";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock } from "@/server/payments/test-fixtures";
import { copy } from "@/ui/copy";
import { inProcessApi } from "./handler";
import { BASE_URL, DOCS_URL, httpClient, mcpRouteDeps, mcpScene } from "./test-fixtures";

/**
 * mcp-server property 1 (MCP-9). Two sandboxes in lockstep, on the same
 * fake clock, each with an MCP agent from the billing preset. One takes a
 * random sequence of payments, tool requests, page reads, and replays
 * through the HTTP API (AgentClient straight to the route handlers); the
 * other takes the same sequence through an MCP client over Streamable
 * HTTP. Every request must get the same decision and reason codes, or
 * fail the same way.
 *
 * This forces PGlite, like the scenario properties: about 200 sequential
 * requests in each of two databases, with no concurrency needed.
 * handler.int.test.ts runs the MCP route on Postgres.
 */

type Step =
  | { kind: "pay"; vendor: string; amount: string; rail: "x402" | "mpp"; key: number; gapMs: number }
  | { kind: "tool"; tool: string; vendor: string; amount: string; key: number; gapMs: number }
  | { kind: "fetch"; gapMs: number };

/** The same outcome, from either path: a decision, or the API's error status. */
type Outcome = { decision: string; reasons: string[] } | { error: number | "auth" | "other" };

const amount = fc.constantFrom("0", "0.0015", "0.5", "1", "1.000001", "5", "99.99", "100.000001", "480", "1000.000001");
const gap = fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 0, max: 5_000 }) }, { weight: 1, arbitrary: fc.integer({ min: 60_000, max: 3_600_000 }) });
// Few distinct keys, so replays (same key, same or different body) happen often.
const key = fc.integer({ min: 0, max: 6 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("pay" as const), vendor: fc.constantFrom("nimbus-weather", "gpu-cloud", "not-registered"), amount, rail: fc.constantFrom("x402" as const, "mpp" as const), key, gapMs: gap }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("tool" as const),
      // Mostly refunds to the task's own vendor, the only tool requests whose outcome depends on the amount.
      tool: fc.oneof({ weight: 4, arbitrary: fc.constant("stripe.refund") }, { weight: 1, arbitrary: fc.constantFrom("wire_transfer", "payout.create") }),
      vendor: fc.oneof({ weight: 4, arbitrary: fc.constant("nimbus-weather") }, { weight: 1, arbitrary: fc.constant("gpu-cloud") }),
      amount: fc.oneof(amount, fc.constantFrom("100", "480", "1000")),
      key,
      gapMs: gap,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("fetch" as const), gapMs: gap }) },
);

const toolArgs = (s: Extract<Step, { kind: "tool" }>, amountField: Record<string, string>) => ({
  vendor: s.vendor,
  ...amountField,
  ...(s.tool === "stripe.refund" ? { payment_ref: "pi_3Uc9pZ3i6fxzvKeT0hGFL3nf" } : {}),
});

async function newWorld() {
  const database = await createTestDb({ driver: "pglite" });
  const clock = new FakeClock();
  const { deps } = mcpRouteDeps(database.db, clock);
  const { agent } = await mcpScene(database.db, clock);
  return { database, clock, deps, agent };
}

type World = Awaited<ReturnType<typeof newWorld>>;

let worlds: [World, World];
let mcp: Awaited<ReturnType<typeof httpClient>>;
let run = 0;

beforeAll(async () => {
  worlds = [await newWorld(), await newWorld()];
  mcp = await httpClient(worlds[1].deps, { authorization: `Bearer ${worlds[1].agent.apiKey}` });
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  for (const w of worlds ?? []) await w.database.close();
});

/** Through the HTTP API, as an agent with its own code would send it. */
async function viaApi(world: World, s: Step, prefix: string): Promise<Outcome> {
  const client = new AgentClient(BASE_URL, world.agent.apiKey, world.agent.sessionId, { fetch: inProcessApi(world.deps) });
  try {
    if (s.kind === "fetch") {
      await client.fetch(DOCS_URL);
      return { decision: "fetched", reasons: [] };
    }
    const k = `${prefix}-${s.key}`;
    const d =
      s.kind === "pay"
        ? await client.pay(s.vendor, fromDecimalString(s.amount), k, s.rail === "mpp" ? "mpp.pay" : "x402.pay")
        : await client.tool(s.tool, toolArgs(s, { amount_micros: fromDecimalString(s.amount).toString() }), k);
    return { decision: d.decision, reasons: d.reasons.map((r) => r.code) };
  } catch (error) {
    // The MCP tools report these statuses with their code, 401 as an authentication error, and anything else as unavailable.
    if (!(error instanceof AgentApiError)) return { error: "other" };
    if (error.status === 401) return { error: "auth" };
    return { error: REPORTED.includes(error.status) ? error.status : "other" };
  }
}

const REPORTED = [400, 403, 404, 409, 413, 422];

/** The same request as an MCP tool call. */
async function viaMcp(s: Step, prefix: string): Promise<Outcome> {
  const result =
    s.kind === "fetch"
      ? await mcp.call("agentvault_fetch", { url: DOCS_URL, session_id: worlds[1].agent.sessionId })
      : s.kind === "pay"
        ? await mcp.call("agentvault_pay", { vendor: s.vendor, amount: s.amount, rail: s.rail, session_id: worlds[1].agent.sessionId, idempotency_key: `${prefix}-${s.key}` })
        : await mcp.call("agentvault_request_tool", { tool: s.tool, args: toolArgs(s, { amount: s.amount }), session_id: worlds[1].agent.sessionId, idempotency_key: `${prefix}-${s.key}` });
  if (result.isError) {
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (text === copy.default["mcp.authError"]) return { error: "auth" };
    const status = /\((\d{3}) [A-Z_]+\)$/.exec(text)?.[1];
    return { error: status ? Number(status) : "other" };
  }
  if (s.kind === "fetch") return { decision: "fetched", reasons: [] };
  const out = result.structuredContent as { decision: string; reasons: string[] };
  return { decision: out.decision, reasons: out.reasons };
}

describe("MCP parity", () => {
  // Property 1 (Parity, MCP-9): for any generated request and state, the MCP tool result's
  // decision equals the HTTP API's decision.
  it("MCP-9: property 1: every request gets the same decision and reasons through MCP as through the HTTP API", async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
        // Each case uses its own keys, so a replay only ever matches a request from the same case.
        const prefix = `case-${(run += 1)}`;
        for (const s of steps) {
          for (const w of worlds) w.clock.advance(s.gapMs);
          const api = await viaApi(worlds[0], s, prefix);
          const viaTool = await viaMcp(s, prefix);
          expect(viaTool, JSON.stringify(s)).toEqual(api);
          seen.add("decision" in api ? api.decision : `error ${api.error}`);
        }
      }),
      { numRuns: 25 },
    );
    // Not vacuous: the sequence reached every outcome.
    expect([...seen]).toEqual(expect.arrayContaining(["allow", "hold", "deny", "fetched"]));
  }, 600_000);
});
