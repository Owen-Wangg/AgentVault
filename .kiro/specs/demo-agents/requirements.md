# Requirements: Demo Agents

## Introduction
This spec covers the agents that exercise AgentVault: a **scripted agent** that replays the five demo scenarios deterministically, and an **optional live agent** on Gemini's free tier. Both call AgentVault only through its public API (`/api/v1/fetch`, `/api/v1/pay`, `/api/v1/tool`), exactly like a third-party agent would.

## Requirement 1: Scenario runner
**User story:** As a judge, I want to run each attack with one click, so that I can see AgentVault stop it.

### Acceptance criteria
- **AGT-1** THE scenarios page SHALL offer five scenarios: Normal purchase, Runaway loop, Prompt injection, Intent drift, and Payee hijack (payout-rails PO-23), each with a one-sentence description.
- **AGT-2** WHEN a scenario starts, THE SYSTEM SHALL create a fresh agent (with a new API key and the scenario's seeded envelope), task, and session in the current sandbox workspace, and write a `scenario_started` audit event. THE SYSTEM SHALL NOT delete or change earlier rows to do this; a full sandbox reset creates a new workspace instead (audit-and-approvals AUD-9).
- **AGT-3** WHILE a scenario runs, THE SYSTEM SHALL show its steps and their decisions live.
- **AGT-4** THE scripted agent SHALL use the same HTTP API and API key authentication as an external agent.
- **AGT-5** WHEN run with the same seed state, each scenario SHALL produce the same sequence of decisions and reason codes.

## Requirement 2: Scenario behavior
### Acceptance criteria
- **AGT-6** WHEN the Normal purchase scenario runs, THE agent SHALL make 5 weather data purchases, and each SHALL be allowed.
- **AGT-7** WHEN the Runaway loop scenario runs, THE agent SHALL send requests in a tight retry loop until denied, and THE SYSTEM SHALL deny with `VELOCITY_EXCEEDED` and freeze the agent before the minute cap is reached; later requests SHALL be denied with `AGENT_FROZEN`.
- **AGT-8** WHEN the Prompt injection scenario runs, THE agent SHALL fetch the poisoned vendor docs, follow the injected instruction to call `stripe.refund` for $480, and THE SYSTEM SHALL hold it with `HELD_TAINTED`.
- **AGT-9** WHEN the Intent drift scenario runs under the task "buy weather data," THE agent SHALL attempt to pay the GPU compute vendor, and THE SYSTEM SHALL deny it with `DENY_INTENT_DRIFT`.
- **AGT-10** WHEN a scenario finishes, THE SYSTEM SHALL show a summary: requests made, spend allowed, spend blocked, and decisions by reason.

## Requirement 3: Optional live Gemini agent
**User story:** As a judge, I want to see a real LLM fall for the injection and get caught.

### Acceptance criteria
- **AGT-11** WHERE `GEMINI_API_KEY` is set, THE scenarios page SHALL offer "Run with live AI agent" for each scenario except the runaway loop, which SHALL say it is scripted only; otherwise the option SHALL be hidden.
- **AGT-12** THE live agent SHALL expose only `fetch_url`, `pay`, and `request_tool` as tools, each calling the AgentVault API.
- **AGT-13** THE SYSTEM SHALL validate every LLM tool-call argument with Zod before calling the API.
- **AGT-14** IF Gemini returns HTTP 429, or a request still fails after one retry of a timeout, dropped connection, or 5xx error, THEN THE SYSTEM SHALL stop the run, show a clear message, and offer the scripted run. A 429 SHALL never be retried.
- **AGT-15** THE live agent SHALL stop after at most 15 tool calls per run.
- **AGT-16** WHERE the live agent produces an advisory drift score, THE SYSTEM SHALL show it next to the decision and pass it to the policy as advisory only (INT-7 to INT-9).
- **AGT-17** WHILE a run has at least one decision, THE scenarios page SHALL show its latest decision as a path through AgentVault's checks (agent, spend limits, task scope, untrusted input) to the payment rail. Each check SHALL be marked passed, held, or denied from the decision's reason codes, and the rail SHALL be marked reached only for an allowed decision. Every state SHALL be named in text, not by color alone. WHEN the request was refused before the checks ran (`INVALID_REQUEST`), the other checks SHALL be marked not checked.
