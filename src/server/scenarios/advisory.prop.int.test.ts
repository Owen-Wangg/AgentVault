import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentClient } from "@/agents/client";
import { LIVE_CATALOG } from "@/agents/gemini/scenarios";
import { type ProposedAction, type ScoringContext, scoreDrift } from "@/agents/gemini/scorer";
import { recordedModel, score } from "@/agents/gemini/test-fixtures";
import { type ScenarioClient, decisionSequence, runScripted } from "@/agents/scripted/agent";
import { SCENARIOS, SCENARIO_NAMES } from "@/agents/scripted/scenarios";
import { fromMicrosString } from "@/core/money";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { advisoryScoreArb } from "@/core/testing/arbitraries";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, expectAuditBeforeSpend, testDeps } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { startRun } from "./runner";
import { BASE_URL, apiFetch } from "./test-fixtures";

/**
 * demo-agents property 3 on in-memory PGlite, like property 1: each case
 * runs all five scenarios, about 48 agent requests, and needs no
 * concurrency. The per-request score behavior is covered on Postgres by
 * src/server/payments/advisory.int.test.ts and live.int.test.ts.
 *
 * Each pay or tool step carries a score from the real scorer, reading a
 * recorded Gemini reply with a generated score, so the score goes through
 * the same parsing a live run uses.
 */

let database: Awaited<ReturnType<typeof createTestDb>>;
let sandboxId: string;
const clock = new FakeClock();

beforeAll(async () => {
  database = await createTestDb({ driver: "pglite" });
  sandboxId = (await resetSandbox(database.db, { key: TEST_HEAD_KEY, appOrigin: BASE_URL, now: clock.now() })).workspaceId;
}, 60_000);

afterAll(async () => {
  if (database) await expectAuditBeforeSpend(database.db);
  await database?.close();
});

const SEVERITY = { allow: 0, hold: 1, deny: 2 } as const;

/** A client that asks the (mocked) Gemini scorer before each pay or tool request and sends the score with it. */
function scoredClient(inner: AgentClient, scores: readonly number[], context: ScoringContext): ScenarioClient {
  let i = 0;
  const next = (action: ProposedAction) => {
    const n = scores[i % scores.length]!;
    i += 1;
    return scoreDrift(recordedModel(score(n)).model, context, action);
  };
  return {
    fetch: (url) => inner.fetch(url),
    pay: async (vendor, amountMicros, key, tool = "x402.pay") =>
      inner.pay(vendor, amountMicros, key, tool, { advisoryDriftScore: await next({ tool, vendor, amountMicros }) }),
    tool: async (name, args, key) => {
      // payee.update moves no money, so it has no amount_micros.
      const a = args as { vendor: string; amount_micros?: string };
      return inner.tool(name, args, key, { advisoryDriftScore: await next({ tool: name, vendor: a.vendor, amountMicros: fromMicrosString(a.amount_micros ?? "0") }) });
    },
  };
}

describe("demo-agents property 3", () => {
  // Property 3. Advisory can't loosen (INT-9): with mocked Gemini returning any score, no
  // decision is looser than the scripted run's decision for the same step.
  it("INT-9, AGT-16: property 3: with any scores, every step is at least as strict as the scripted run, with every scripted reason", async () => {
    const { deps: guarded } = testDeps(database.db, { clock });
    const { send } = apiFetch(database.db, guarded);
    let held = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(advisoryScoreArb(), { minLength: 1, maxLength: 40 }), async (scores) => {
        for (const name of SCENARIO_NAMES) {
          // Each run gets a fresh agent, so earlier runs can't change its decisions; the gap keeps windows apart anyway.
          clock.advance(120_000);
          const scenario = SCENARIOS[name];
          const started = await startRun(database.db, { workspaceId: sandboxId, scenario: name, runId: crypto.randomUUID(), actor: "sandbox_visitor" }, { key: TEST_HEAD_KEY, now: clock.now() });
          const inner = new AgentClient(BASE_URL, started.apiKey, started.sessionId, { fetch: send });
          const context: ScoringContext = {
            task: scenario.task.description,
            allowedVendorCategories: scenario.task.allowedVendorCategories,
            allowedTools: scenario.task.allowedTools,
            budgetMicros: scenario.task.budgetMicros,
            catalog: Object.fromEntries(LIVE_CATALOG.map((v) => [v.name, v.category])),
          };
          const run = await runScripted(scenario, scoredClient(inner, scores, context), { vendorOrigin: BASE_URL, vendors: started.vendors });
          expect(run.completed).toBe(true);
          const actual = decisionSequence(run.results);
          // Held calls count toward calls per minute too, so even the runaway loop makes the same number of requests.
          expect(actual).toHaveLength(scenario.expected.length);
          for (const [i, got] of actual.entries()) {
            const want = scenario.expected[i]!;
            expect(SEVERITY[got.decision as keyof typeof SEVERITY]).toBeGreaterThanOrEqual(SEVERITY[want.decision]);
            for (const code of want.reasons) expect(got.reasons).toContain(code);
            if (got.reasons.includes("ADVISORY_DRIFT")) held += 1;
          }
        }
      }),
      { numRuns: 8 },
    );
    // The generated scores did hold some steps, so the property saw ADVISORY_DRIFT at work.
    expect(held).toBeGreaterThan(0);
  }, 600_000);
});
