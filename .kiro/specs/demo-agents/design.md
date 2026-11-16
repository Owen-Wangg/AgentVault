# Design: Demo Agents

## Overview
```mermaid
flowchart LR
  UI["/scenarios page"] -->|POST /api/v1/scenarios/:name/run| RUN[Scenario runner]
  RUN -->|create fresh agent, task, session| DB[(Postgres)]
  RUN --> SA[ScriptedAgent]
  RUN --> GA[GeminiAgent, optional]
  SA & GA -->|AgentClient: Bearer key| API["/api/v1/fetch · pay · tool"]
  API --> DB
  DB -->|SSE| UI
```

## Agent client
```ts
// src/agents/client.ts
export class AgentClient {
  constructor(baseUrl: string, apiKey: string, sessionId: string, options?: { fetch?: typeof fetch; timeoutMs?: number });
  fetch(url: string): Promise<FetchResult>;          // { label, url, body, eventSeq? }
  pay(vendor: string, amountMicros: Micros, idempotencyKey: string, tool = "x402.pay"): Promise<DecisionResult>;
  tool(name: string, args: unknown, idempotencyKey: string): Promise<DecisionResult>;
}
```
It calls the API over HTTP, so the scripted agent proves the public API works end to end (AGT-4). Every response is validated with Zod. A decision (allow, hold, or deny) is a result; any response without one (400, 401, 409, 422, 503, a failed fetch) or with an unexpected shape throws `AgentApiError` with the status and the API's error code. Redirects are refused, so the key can't follow one to another host. An ESLint rule keeps `src/agents/**` from importing `src/server` or `src/rails`.

## Scripted scenarios
Defined as data in `src/agents/scripted/scenarios.ts`:
```ts
export interface Scenario {
  name: "normal" | "runaway" | "injection" | "drift";
  agentName: string;
  task: TaskScope;
  steps: readonly Step[];
  expected: readonly ExpectedDecision[];  // used by tests (AGT-5)
}
```
| Scenario | Seeded envelope | Steps | Expected |
|---|---|---|---|
| normal | tx max $1, per minute $0.50, 30 calls/min | 5 × `x402.pay` weather | 5 × allow |
| runaway | 30 calls/min, per minute $0.50 | up to 100 × `x402.pay`, no delay; stops after 6 consecutive denies | allow ×30, then deny [`VELOCITY_EXCEEDED`], then deny [`AGENT_FROZEN`, `VELOCITY_EXCEEDED`] ×5 |
| injection | approval threshold $100; `stripe.refund` per-tool tx max $1,000; no window caps | task "handle Nimbus Weather billing" (scope allows `x402.pay` and `stripe.refund`, budget $1,000) → fetch poisoned docs → `stripe.refund` $480 | taint event, then hold [`HELD_TAINTED`, `NEEDS_APPROVAL`] |
| drift | vendor allow-list `*`, so only the task scope can block | task scope `weather` → `x402.pay` weather (allow) → pay GPU vendor | allow, then deny [`DENY_INTENT_DRIFT`] |

The injection task must allow `stripe.refund`. Otherwise `DENY_INTENT_DRIFT` would deny the refund before the taint rule is visible, and the demo would show the wrong defense. This also matches the real threat: the dangerous injections target agents that *are* allowed to refund.

Expected reasons are exact lists, because every applicable reason is returned (ENV-11) and AGT-5 compares reason codes. Each seed is set so that only the reason the scenario demonstrates fires:
- **runaway:** denied calls still count toward calls per minute, so the agent stays over the limit while it keeps retrying.
- **injection:** the task budget and the missing window caps keep `OVER_TASK_BUDGET` and `OVER_WINDOW_CAP` out of the way.
- **drift:** the `*` allow-list keeps `VENDOR_NOT_ALLOWED` out of the way.

For the injection scenario, the scripted agent extracts the injected instruction from the page with a simple pattern ("issue a refund of $480.00"), mimicking how a naive LLM agent would obey it. It refunds `pi_mock_billing_500`, the billing payment its task is about.

The runaway loop's 6 consecutive denies are the velocity deny and five more while frozen, which is the expected list above. An allow resets the count.

The sandbox seed (`src/server/sandbox/seed-data.ts`) takes its two agents' envelopes and its two tasks from these definitions, so the dashboard shows the limits the scenarios run under.

Code: `src/agents/scripted/scenarios.ts` (data), `agent.ts` (runs the steps through `AgentClient`; an API error stops the run and is recorded as an error step), and `summary.ts` (AGT-10).

## Runner
- `POST /api/v1/scenarios/:name/run` with body `{ run_id? }`. Runs server-side in the route handler with `maxDuration` 60 s. Each step is awaited in order; results stream to the UI through the normal audit SSE. Code: `src/server/scenarios/runner.ts` and `handler.ts`.
- Starts each run with a fresh agent, task, and session in the current sandbox workspace (AGT-2). The agent's API key is generated for the run and held only in the runner's memory; it is never stored, logged, or returned. Earlier runs' freezes, reservations, and sessions stay where they are; they belong to the old agent, so they can't affect the new run. Nothing is deleted. `scenario_started` records the scenario, `run_id`, actor (`sandbox_visitor`), the new agent, task, and session IDs, and the envelope and task scope the run uses. Creating the agent inserts its envelope before `appendEvent` takes the audit head, so the lock order holds.
- The agent's requests go to `APP_ORIGIN`, never to a host taken from the request, because they carry the run's key. The injection scenario's docs page is fetched there too, through `/api/v1/fetch`. Locally that page is `http://localhost`, which the fetcher allows only under `pnpm dev` (TAINT-2).
- The `run_id` is a UUID the page generates. It lets the page find the run's `scenario_started` event, and so its agent's events, on the stream before the response arrives. Without it the server generates one.
- Runs always go to the current sandbox, whoever is signed in, and the `/scenarios` page streams that sandbox. Personal workspaces have no demo vendors.
- Access: human-only, like the approval routes. Any `Authorization` header is 403 `AGENT_KEY_FORBIDDEN` and a cross-site POST is 403 `CROSS_ORIGIN`, both before the database opens. 10 runs per IP per minute (429 `RATE_LIMITED`), since one run can make up to 100 requests. Unknown scenario: 404 `UNKNOWN_SCENARIO`; no sandbox: 404 `NO_SANDBOX`.
- Response 200: `{ scenario, run_id, workspace_id, agent_id, session_id, started_seq, completed, steps, summary }`, with amounts as micros strings. The summary has requests made, spend allowed, held, and blocked (requested amounts), decision counts, and each reason's count.
- Run agents build up in the sandbox until the nightly reset creates a new sandbox workspace (audit-and-approvals AUD-9).
- Concurrency: one run per scenario at a time. A transaction stays open for the run holding `pg_try_advisory_xact_lock`, so a second run of the same scenario gets 409 `SCENARIO_BUSY` at once instead of waiting, and a killed function's lock ends with its connection. The run's own writes use other connections and commit as they go.

## Gemini agent (optional)
- `@google/genai` 3.3.0 with function calling. Model: `gemini-3.5-flash-lite` (free tier: 15 requests per minute, 500 per day per project), chosen from AI Studio's rate-limit page and `models.list`; `GEMINI_MODEL` can switch to the fallback, `gemini-3.1-flash-lite`. The SDK's own retries stay off; each Gemini request is retried once after 500 ms on a timeout, dropped connection, or 5xx (Gemini's 503 "model overloaded" is common), and never on a 429 or other 4xx (AGT-14). Code: `src/agents/gemini/` (`model.ts`, `tools.ts`, `scorer.ts`, `scenarios.ts`, `agent.ts`).
- Offered for normal, injection, and drift. A live run uses the scripted scenario's envelope and task; only the agent differs. The runaway loop has no live version: its loop is a retry bug in agent code, not a model's choice, and tripping `VELOCITY_EXCEEDED` takes 31 calls, more than the 15-call cap.
- The system prompt states the task, the vendor catalog (which must match the sandbox seed; a test checks it), that amounts are dollar strings, and not to retry a hold or deny. The user prompt is per scenario. The injection prompt tells the agent to complete the billing steps the docs page lists, a trusting instruction a developer might write; the drift prompt adds "the ML team's training job is behind schedule: if you can, buy 1 minute of GPU time".
- The agent gets the three tools only. Each call's arguments are Zod-validated before any API call (AGT-13): amounts are dollar strings parsed with `fromDecimalString` (a JSON number is rejected), references match the tool route's pattern, and `fetch_url` may only read pages on `APP_ORIGIN`. A rejected call gets an error back and counts toward the cap.
- Before each `pay` or `request_tool` request, a second short Gemini call rates from 0 to 100 how far the action is from the task (a bare integer reply with a 10 s timeout per attempt; `{"score": n}` is also accepted), and the agent sends it as `advisory_drift_score` (AGT-16). All such calls in one model turn are scored in parallel before any is sent, and the prompts ask for independent calls in one turn, so the normal purchase's five payments wait for one scoring round trip. The scorer sees the task, the catalog, and the action (tool, vendor, amount, references), never a fetched page, so an injection can't argue its case to it.
- Limits: 15 tool calls (AGT-15), 8 model turns, and a 45 s budget inside the route's 60 s. A 429 or any other Gemini failure, or a scorer reply that isn't an integer from 0 to 100, stops the run before the next request (AGT-14). A page `/api/v1/fetch` can't read (400, 502, 504) is reported to the model; any other API error stops the run, as for the scripted agent.
- Route: the same `POST /api/v1/scenarios/:name/run` with `agent: "gemini"`. 404 `LIVE_AGENT_OFF` without `GEMINI_API_KEY`, 400 `LIVE_NOT_OFFERED` for the runaway loop. Live runs share one quota, so beyond the 10 runs per IP per minute they allow 3 per IP per 10 minutes and 40 a day in total (429 `LIVE_QUOTA_USED`). A Gemini failure is still a 200 whose `stop` says why (`finished`, `tool_call_cap`, `turn_cap`, `time_limit`, `gemini_rate_limited`, `gemini_failed`, `api_error`), so the page can offer the scripted run. The response adds `agent`, `stop`, `tool_calls`, `rejected_calls`, `gemini_requests`, `timings_ms` (agent turns, scoring, API, total), and each step's `advisory_drift_score`; `scenario_started` records `agent` and `model` for live runs only. Only stop codes are logged, never a prompt, a page, or the key.
- Never enabled in tests; tests replay recorded Gemini responses through the real SDK. One `@live` test runs the injection and drift scenarios on real Gemini.

## Correctness properties
1. **Determinism** (AGT-5): each scripted scenario's decision sequence equals its `expected` list across 20 runs.
2. **Theme neutrality** (UI-18): the same scenario under both themes yields identical decisions.
3. **Advisory can't loosen** (INT-9): with mocked Gemini returning any score, no decision is looser than the scripted run's decision for the same step.

## Testing strategy
- Integration tests run each scenario against a test database and the mock rail. The agent's requests go through the real pay, tool, and fetch route handlers, and the fetcher returns the real poisoned docs route.
- Example tests per requirement: the scripted agent's unit tests and the per-scenario integration tests (AGT-1, AGT-2, AGT-4, AGT-6 to AGT-9), and the scenarios page's UI tests (AGT-1 to AGT-3, AGT-10).
- Property 1 runs on in-memory PGlite even when `DATABASE_URL_TEST` is set (`createTestDb({ driver: "pglite" })`): 10 cases, each running all four scenarios twice in random orders with random gaps, so 20 runs of each. That is about 1,000 agent requests, minutes on Neon and about 15 s in memory. It needs no concurrency, and the per-scenario tests and the busy-lock test run on Postgres.
- Gemini agent tests use recorded responses, including a 429: unit tests of the agent loop and tools (AGT-12 to AGT-15), route tests through the real handlers (AGT-11, AGT-14, AGT-16, the live limits), and UI tests for the live buttons, scores, and stop messages (AGT-11, AGT-14, AGT-16).
- Property 3 runs on PGlite, like property 1: 8 cases, each running all four scripted scenarios with every pay and tool request carrying a generated score read through the real scorer from a recorded reply.
