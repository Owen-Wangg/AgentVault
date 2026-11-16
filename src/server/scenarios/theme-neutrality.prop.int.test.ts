import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENARIO_NAMES, type ScenarioName } from "@/agents/scripted/scenarios";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import { type HumanRouteDeps, handleApprovalAction, handleListApprovals, handleUnfreeze } from "@/server/approvals/handlers";
import { createTestDb } from "@/server/db/test-db";
import { FakeClock, eventsOf } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import type { ScenarioRouteDeps } from "./handler";
import { BASE_URL, type RunBody, decisionsOf, expectedOf, runScenarioRoute, scenarioRouteDeps } from "./test-fixtures";

/**
 * telemetry-dashboard property 2 (UI-18). Two sandboxes in lockstep, on
 * the same fake clock, take the same random sequence of scenario runs,
 * approvals, denials, and unfreezes. Every request in one carries the
 * browser's theme cookie set to default, and in the other to kiroween:
 * the run request, each request the scripted agent sends, and each human
 * action. The responses and the audit events must be identical once the
 * random IDs and the hashes that cover them are numbered in order.
 *
 * This forces PGlite, like scenario property 1: it makes about 30
 * sequential runs in each of two databases, which takes minutes over the
 * network and needs no concurrency. runner.int.test.ts runs every
 * scenario on Postgres.
 */

const COOKIE = { default: "av-theme=default", kiroween: "av-theme=kiroween" } as const;
type ThemeName = keyof typeof COOKIE;

interface World {
  theme: ThemeName;
  database: Awaited<ReturnType<typeof createTestDb>>;
  clock: FakeClock;
  sandboxId: string;
  deps: ScenarioRouteDeps;
  human: HumanRouteDeps;
}

/** A fetch that adds the theme cookie to every request, as a browser would. */
const withCookie = (send: typeof fetch, cookie: string): typeof fetch =>
  (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("cookie", cookie);
    return send(new Request(request, { headers }));
  }) as typeof fetch;

async function createWorld(theme: ThemeName): Promise<World> {
  const database = await createTestDb({ driver: "pglite" });
  const clock = new FakeClock();
  const sandboxId = (await resetSandbox(database.db, { key: TEST_HEAD_KEY, appOrigin: BASE_URL, now: clock.now() })).workspaceId;
  const { deps, guarded } = scenarioRouteDeps(database, { clock });
  const human: HumanRouteDeps = {
    openDb: deps.openDb,
    key: deps.key,
    now: clock.now,
    railFor: guarded.railFor,
    getUser: async () => null,
    rateLimit: { limit: 1_000_000, windowMs: 60_000 },
  };
  return { theme, database, clock, sandboxId, deps: { ...deps, agentFetch: withCookie(deps.agentFetch!, COOKIE[theme]) }, human };
}

const humanRequest = (world: World, path: string, body?: unknown) =>
  new Request(`${BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie: COOKIE[world.theme] },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Step {
  scenario: ScenarioName;
  gapMs: number;
  approve: boolean;
  unfreeze: boolean;
}

/** What one world answered to one step: every response, in order. */
async function play(world: World, step: Step): Promise<{ body: RunBody; transcript: { status: number; text: string }[] }> {
  world.clock.advance(step.gapMs);
  const transcript: { status: number; text: string }[] = [];
  const run = await runScenarioRoute(step.scenario, world.deps, { cookie: COOKIE[world.theme] });
  transcript.push({ status: run.status, text: run.text });
  for (const s of run.body.steps) {
    if (!s.approval_id) continue;
    const response = await handleApprovalAction(humanRequest(world, `/api/v1/approvals/${s.approval_id}`, { action: step.approve ? "approve" : "deny" }), s.approval_id, world.human);
    transcript.push({ status: response.status, text: await response.text() });
  }
  if (step.unfreeze) {
    const response = await handleUnfreeze(humanRequest(world, `/api/v1/agents/${run.body.agent_id}/unfreeze`, {}), run.body.agent_id, world.human);
    transcript.push({ status: response.status, text: await response.text() });
  }
  const list = await handleListApprovals(humanRequest(world, "/api/v1/approvals"), world.human);
  transcript.push({ status: list.status, text: await list.text() });
  return { body: run.body, transcript };
}

/**
 * Numbers each distinct UUID, 64-hex hash, and mock rail reference by first appearance. Two
 * worlds that did the same things then read the same, whatever random
 * IDs each one drew.
 */
function normalize(value: unknown): string {
  const seen = new Map<string, string>();
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v instanceof Date ? v.toISOString() : v));
  // UUIDs, sha256 hashes, and the mock rail's random references (mock_tx_…, mock_re_…).
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{64}\b|\bmock_[a-z]+_[0-9a-f]{8,}\b/gi, (match) => {
    const key = match.toLowerCase();
    if (!seen.has(key)) seen.set(key, `${key.startsWith("mock_") ? "ref" : key.length === 64 ? "hash" : "id"}#${seen.size}`);
    return seen.get(key)!;
  });
}

let worlds: [World, World];

beforeAll(async () => {
  worlds = [await createWorld("default"), await createWorld("kiroween")];
}, 120_000);

afterAll(async () => {
  for (const world of worlds ?? []) await world.database.close();
});

describe("theme neutrality", () => {
  // Property 2 (Theme neutrality, UI-18): for every scenario, the recorded decision sequence is
  // identical with theme = default and theme = kiroween.
  // Beyond the decisions, it also compares every API response and every audit event, including
  // approvals, denials, and unfreezes after the runs.
  it("UI-18: property 2: the same actions give the same decisions, responses, and audit events in both themes", async () => {
    const step = fc.record({
      scenario: fc.constantFrom(...SCENARIO_NAMES),
      gapMs: fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 0, max: 15_000 }) }, { weight: 1, arbitrary: fc.integer({ min: 60_000, max: 3_600_000 }) }),
      approve: fc.boolean(),
      unfreeze: fc.boolean(),
    });
    const seen = new Set<ScenarioName>();

    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 4 }), async (steps) => {
        const before = await Promise.all(worlds.map(async (w) => (await eventsOf(w.database.db, w.sandboxId)).length));
        const results: { transcript: unknown[]; events: unknown[] }[] = [];
        for (const [i, world] of worlds.entries()) {
          const transcript: unknown[] = [];
          for (const s of steps) {
            const { body, transcript: t } = await play(world, s);
            // Not vacuous: each world gives the scenario's expected decisions.
            expect(decisionsOf(body)).toEqual(expectedOf(s.scenario));
            seen.add(s.scenario);
            transcript.push(t);
          }
          const events = (await eventsOf(world.database.db, world.sandboxId)).slice(before[i]);
          results.push({ transcript, events });
        }
        const [a, b] = results as [(typeof results)[number], (typeof results)[number]];
        expect(normalize(b.transcript)).toBe(normalize(a.transcript));
        expect(normalize(b.events)).toBe(normalize(a.events));
      }),
      { numRuns: 8 },
    );
    expect([...seen].sort()).toEqual([...SCENARIO_NAMES].sort());
  }, 600_000);
});

/** Source files under a directory, without tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("theme boundary", () => {
  // The property above can only try the code paths it runs. This covers the rest: nothing that
  // decides, records, or answers an API request can read the theme at all.
  it("UI-18: no code under src/core, src/server, src/rails, src/agents, src/mcp, app/api, or app/vendor reads the theme", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const dirs = ["src/core", "src/server", "src/rails", "src/agents", "src/mcp", "app/api", "app/vendor", "app/openapi.json"];
    const files = dirs.flatMap((d) => sources(join(root, d)));
    expect(files.length).toBeGreaterThan(50);
    // Any quoted module path into src/ui catches `from`, bare side-effect imports, import(), and require().
    const offenders = files.filter((file) => /["'][^"'\n]*(@\/ui\/|\/ui\/)|av-theme|THEME_COOKIE|data-theme|kiroween/i.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
});
