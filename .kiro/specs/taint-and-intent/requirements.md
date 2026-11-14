# Requirements: Taint Tracking and Intent Scope

## Introduction
This spec covers the two defenses against a hijacked agent: **taint tracking**, which freezes high-privilege tools after the agent reads untrusted content, and **intent scope**, which denies payments outside the task the agent was given. It also covers `/api/v1/fetch`, the proxied fetch that makes taint tracking possible, and `/api/v1/tool`, the gate for high-privilege tools.

## Glossary
- **Trusted origin**: an origin on the workspace's vendor list with `trusted = true`.
- **Untrusted content**: any fetched content whose origin is not trusted.
- **Tainted session**: a session that has received untrusted content.
- **High-privilege tool**: a tool that can move money out or change payees: `stripe.refund`, `wire_transfer`, `payout.create`, `payee.update`, or any registry tool flagged `privileged`.
- **Task scope**: the vendor categories, tools, and budget declared for a task.

## Requirement 1: Proxied fetch with origin labels
**User story:** As a security owner, I want all agent web reads to go through AgentVault, so that I always know when an agent has seen untrusted content.

### Acceptance criteria
- **TAINT-1** WHEN an agent calls `/api/v1/fetch` with a URL, THE SYSTEM SHALL fetch it server-side and return the body with a label of `trusted` or `untrusted` based on the origin.
- **TAINT-2** IF the URL is not `https` (or `http://localhost` in development), resolves to a private, loopback, or link-local address, or redirects to such an address, THEN THE SYSTEM SHALL refuse the fetch with `FETCH_BLOCKED`.
- **TAINT-3** THE SYSTEM SHALL cap fetches at 1 MB and 10 seconds, and SHALL return content as text only.
- **TAINT-4** WHEN an untrusted response is returned, THE SYSTEM SHALL mark the session tainted and record the source URL and the SHA-256 of the content in an audit event.
- **TAINT-5** WHILE a session is tainted, THE SYSTEM SHALL keep it tainted until the session ends, regardless of any agent request.

## Requirement 2: Freezing high-privilege tools
**User story:** As a developer, I want refunds and payouts blocked after my agent reads a suspicious page, so that a prompt injection can't move money out.

### Acceptance criteria
- **TAINT-6** WHEN a high-privilege tool is requested in a tainted session, THE SYSTEM SHALL hold it with `HELD_TAINTED` and create an approval that shows the taint source.
- **TAINT-7** WHEN a high-privilege tool is requested in an untainted session, THE SYSTEM SHALL apply the normal envelope rules, including the approval threshold.
- **TAINT-8** IF an agent requests a tool that is not in the tool registry, THEN THE SYSTEM SHALL deny it with `TOOL_NOT_ALLOWED`.
- **TAINT-9** WHEN a `HELD_TAINTED` request is approved, THE SYSTEM SHALL execute it only if all other rules still pass (HITL-2).

## Requirement 3: Intent scope
**User story:** As a developer, I want each task to declare what it may buy, so that an agent that drifts off-task is stopped.

### Acceptance criteria
- **INT-1** WHEN a session is created, THE SYSTEM SHALL require a task ID, and the task SHALL declare allowed vendor categories, allowed tools, and a budget in micros.
- **INT-2** IF a payment's vendor category is not in the task's allowed categories, THEN THE SYSTEM SHALL deny it with `DENY_INTENT_DRIFT` and include the expected and actual categories.
- **INT-3** IF a requested tool is not in the task's allowed tools, THEN THE SYSTEM SHALL deny it with `DENY_INTENT_DRIFT`.
- **INT-4** IF a payment would bring the session's total spend above the task budget, THEN THE SYSTEM SHALL deny it with `OVER_TASK_BUDGET`.
- **INT-5** THE SYSTEM SHALL take the vendor category from the workspace's vendor registry, never from the agent's request.
- **INT-6** IF the vendor is not in the registry, THEN THE SYSTEM SHALL treat its category as `unknown`, which no task allows.

## Requirement 4: Advisory LLM signal
**User story:** As a developer, I want an optional LLM opinion on drift, without letting it override hard rules.

### Acceptance criteria
- **INT-7** WHERE the Gemini agent integration is enabled, THE SYSTEM SHALL accept an advisory drift score between 0 and 100 for a request.
- **INT-8** IF the advisory score is at or above the workspace threshold (default 70), THEN THE SYSTEM SHALL add the hold reason `ADVISORY_DRIFT`.
- **INT-9** THE SYSTEM SHALL never let an advisory score remove a deny or hold reason.
