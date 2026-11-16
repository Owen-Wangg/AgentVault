import type { ScenarioName } from "@/agents/scripted/scenarios";
import { SCENARIOS } from "@/agents/scripted/scenarios";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { Db } from "@/server/db/client";
import { type FetchDeps, handleFetch } from "@/server/fetch/fetch-handler";
import { type PayDeps, handlePay } from "@/server/payments/pay-handler";
import type { GuardedDeps } from "@/server/payments/guarded";
import { type FakeClock, testDeps } from "@/server/payments/test-fixtures";
import { handleTool } from "@/server/tools/tool-handler";
import { GET as poisonedDocs } from "../../../app/vendor/docs/integration/route";
import { type ScenarioRouteDeps, handleRunScenario } from "./handler";
import { type ScenarioLock, advisoryScenarioLock } from "./runner";

/** Test-only helpers for the scenario runner. */

export const BASE_URL = "https://agentvault.example";

/** PGlite has one connection, so a lock transaction held open would block the run's own writes. */
export const passthroughLock: ScenarioLock = async (_db, _name, run) => ({ acquired: true, value: await run() });

/** Route deps on a test database, with the agent's requests sent to the real handlers. */
export function scenarioRouteDeps(
  database: { db: Db; driver: "postgres" | "pglite" },
  { clock: given, otherPages, ...over }: Partial<ScenarioRouteDeps> & { clock?: FakeClock; otherPages?: boolean } = {},
) {
  const { deps: guarded, mocks, clock } = testDeps(database.db, given ? { clock: given } : {});
  const { send, sent } = apiFetch(database.db, guarded, otherPages ? { otherPages } : {});
  const deps: ScenarioRouteDeps = {
    openDb: () => ({ db: database.db, close: async () => {} }),
    key: () => TEST_HEAD_KEY,
    now: clock.now,
    baseUrl: () => BASE_URL,
    agentFetch: send,
    lock: database.driver === "postgres" ? advisoryScenarioLock : passthroughLock,
    // Every FakeClock starts in the same minute, so tests would share one rate-limit window.
    rateLimit: { limit: 1_000_000, windowMs: 60_000 },
    liveRateLimit: { perIp: { limit: 1_000_000, windowMs: 60_000 }, total: { limit: 1_000_000, windowMs: 60_000 } },
    ...over,
  };
  return { deps, mocks, clock, sent, guarded };
}

export interface RunBody {
  scenario: ScenarioName;
  run_id: string;
  workspace_id: string;
  agent_id: string;
  session_id: string;
  started_seq: number;
  completed: boolean;
  steps: {
    kind: string;
    tool?: string;
    vendor?: string;
    decision?: string;
    reasons?: string[];
    label?: string;
    url?: string;
    event_seq?: number;
    approval_id?: string;
    amount_micros?: string;
    advisory_drift_score?: number;
  }[];
  summary: { requests: number; allowed_micros: string; held_micros: string; blocked_micros: string; decisions: Record<string, number>; reasons: { code: string; count: number }[] };
}

export const runRequest = (name: string, body: unknown = { run_id: crypto.randomUUID() }, headers: Record<string, string> = {}) =>
  new Request(`${BASE_URL}/api/v1/scenarios/${name}/run`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export async function runScenarioRoute(name: string, deps: ScenarioRouteDeps, headers: Record<string, string> = {}): Promise<{ status: number; body: RunBody; text: string }> {
  const response = await handleRunScenario(runRequest(name, undefined, headers), name, deps);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as RunBody, text };
}

/** A run's decisions, and a scenario's expected ones, in the same form. */
export const decisionsOf = (body: RunBody) => body.steps.filter((s) => s.decision).map((s) => ({ decision: s.decision, reasons: s.reasons }));
export const expectedOf = (name: ScenarioName) => SCENARIOS[name].expected.map((e) => ({ decision: e.decision, reasons: [...e.reasons] }));

/**
 * A fetch that sends each agent request to the real route handler for its
 * path, as the deployment would. The proxied fetch reads the real docs
 * route for the docs URL, so the injection agent sees the poisoned page.
 * `sent` records every request, for checks on what the agent sent.
 */
export function apiFetch(db: Db, guarded: Pick<GuardedDeps, "key" | "now" | "railFor">, options: { otherPages?: boolean } = {}) {
  const open = () => ({ db, close: async () => {} });
  const pay: PayDeps = { openDb: open, key: () => guarded.key, now: guarded.now, railFor: guarded.railFor };
  const fetchDeps: FetchDeps = {
    openDb: open,
    key: () => guarded.key,
    now: guarded.now,
    fetchPage: async (url) => {
      if (url !== `${BASE_URL}/vendor/docs/integration`) {
        // A live model may follow other links on the page; they answer 404 here.
        if (options.otherPages && new URL(url).origin === BASE_URL) return { url, hops: [url], status: 404, contentType: "text/plain", body: "Not found" };
        throw new Error(`unexpected fetch of ${url}`);
      }
      return { url, hops: [url], status: 200, contentType: "text/html", body: await poisonedDocs().text() };
    },
  };
  const sent: Request[] = [];
  const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push(request.clone());
    const { origin, pathname } = new URL(request.url);
    if (origin !== BASE_URL) throw new TypeError(`fetch failed: ${origin}`);
    if (pathname === "/api/v1/pay") return handlePay(request, pay);
    if (pathname === "/api/v1/tool") return handleTool(request, pay);
    if (pathname === "/api/v1/fetch") return handleFetch(request, fetchDeps);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { send, sent };
}
