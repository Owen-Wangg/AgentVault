import { eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENARIO_NAMES, type ScenarioName } from "@/agents/scripted/scenarios";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { verifyChain } from "@/server/audit/append";
import { agents } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, eventsOf, expectAuditBeforeSpend } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { BASE_URL, decisionsOf, expectedOf, runScenarioRoute, scenarioRouteDeps } from "./test-fixtures";

/**
 * Property 1 runs on in-memory PGlite even when DATABASE_URL_TEST is set.
 * It makes 80 sequential runs, about 1,000 agent requests of a dozen
 * queries each: minutes over the network to Neon, seconds in memory. It
 * needs no concurrency, and runner.int.test.ts runs every scenario on
 * real Postgres.
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

describe("scenario determinism", () => {
  // Property 1 (Determinism, AGT-5): each scripted scenario's decision sequence equals its
  // expected list across 20 runs.
  // Each case runs all five scenarios twice, in random orders and with random gaps, in one
  // sandbox, so every scenario repeats after the others and after itself, inside the minute
  // window or past it. 10 cases make 20 runs of each scenario. It also checks AGT-2: no run
  // changes or deletes an earlier audit event or an earlier run's agent.
  it("AGT-5, AGT-2: property 1: every run of a scenario produces its expected decisions, whatever ran before it", async () => {
    const { deps } = scenarioRouteDeps(database, { clock });
    const order = fc.shuffledSubarray([...SCENARIO_NAMES], { minLength: SCENARIO_NAMES.length, maxLength: SCENARIO_NAMES.length });
    // Mostly seconds apart, so repeats land inside the minute window; sometimes past it.
    const gap = fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 0, max: 15_000 }) }, { weight: 1, arbitrary: fc.integer({ min: 60_000, max: 3_600_000 }) });
    const runs = new Map<ScenarioName, number>();
    let repeatsInsideMinute = 0;
    let repeatsPastMinute = 0;

    await fc.assert(
      fc.asyncProperty(order, order, fc.array(gap, { minLength: 2 * SCENARIO_NAMES.length, maxLength: 2 * SCENARIO_NAMES.length }), async (a, b, gaps) => {
        const eventsBefore = await eventsOf(database.db, sandboxId);
        const agentsBefore = await database.db.select().from(agents).where(eq(agents.workspaceId, sandboxId)).orderBy(agents.id);
        const lastAt = new Map<ScenarioName, number>();
        for (const [i, name] of [...a, ...b].entries()) {
          clock.advance(gaps[i]!);
          const at = clock.now().getTime();
          const previous = lastAt.get(name);
          if (previous !== undefined) {
            if (at - previous < 60_000) repeatsInsideMinute += 1;
            else repeatsPastMinute += 1;
          }
          lastAt.set(name, at);
          const { status, body } = await runScenarioRoute(name, deps);
          expect(status).toBe(200);
          expect(decisionsOf(body)).toEqual(expectedOf(name));
          runs.set(name, (runs.get(name) ?? 0) + 1);
        }
        const eventsAfter = await eventsOf(database.db, sandboxId);
        expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
        const agentsAfter = await database.db.select().from(agents).where(eq(agents.workspaceId, sandboxId)).orderBy(agents.id);
        expect(agentsAfter.filter((x) => agentsBefore.some((y) => y.id === x.id))).toEqual(agentsBefore);
      }),
      { numRuns: 10 },
    );
    expect(Object.fromEntries(runs)).toEqual({ normal: 20, runaway: 20, injection: 20, drift: 20, hijack: 20 });
    // A run that inherited state from an earlier one would show up when a scenario repeats
    // inside the minute window (calls per minute, minute caps), or at all (a frozen agent).
    expect(repeatsInsideMinute).toBeGreaterThan(5);
    expect(repeatsPastMinute).toBeGreaterThan(0);
    expect((await verifyChain(database.db, sandboxId, { key: TEST_HEAD_KEY })).ok).toBe(true);
  }, 600_000);
});
