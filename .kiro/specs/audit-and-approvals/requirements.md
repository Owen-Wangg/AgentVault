# Requirements: Audit, Proxy Flow, and Approvals

## Introduction
This spec covers the server-side flow that wraps the pure policy engine: authenticating agents, running each request in one locked transaction, reserving spend before calling a rail, writing a hash-chained append-only audit log, and the human approval queue for held requests. It also defines the database schema shared by every other spec.

## Glossary
- **Workspace**: a tenant. Each signed-in user gets their own. The public sandbox is the newest workspace with `is_sandbox = true`.
- **Audit event**: one immutable row in `audit_events`.
- **Chain**: the per-workspace sequence of audit events linked by hashes.
- **Chain head**: the per-workspace checkpoint row in `audit_heads` that records the latest `seq` and `hash`.
- **Approval**: a pending decision on a held request.
- **Reservation**: a `spend_reservations` row that counts an allowed amount against the envelope before the rail confirms the payment.
- **Confirmed failure**: a rail outcome that proves no money moved (`BELOW_RAIL_MINIMUM`, `CHALLENGE_MISMATCH`, `RAIL_REJECTED`).
- **Unknown outcome**: any rail outcome that does not prove whether money moved, including `RAIL_TIMEOUT`, `INVALID_RAIL_RESPONSE`, and network errors after the request was sent.
- **Agent API key**: a bearer key issued to an agent (PXY-1). It is never a human credential.

## Requirement 1: Agent authentication
**User story:** As a developer, I want each agent to have its own API key, so that I can limit and revoke agents individually.

### Acceptance criteria
- **PXY-1** WHEN an agent is created, THE SYSTEM SHALL generate a random API key with at least 256 bits of entropy, show it once, and store only its SHA-256 hash.
- **PXY-2** WHEN a request arrives at `/api/v1/*`, THE SYSTEM SHALL compare the bearer key's hash to stored hashes using a constant-time comparison.
- **PXY-3** IF the key is missing, unknown, or revoked, THEN THE SYSTEM SHALL return HTTP 401 and write no payment.

## Requirement 2: Transactional pay flow
**User story:** As a security owner, I want every decision recorded before money moves, so that nothing is ever spent without a trace.

### Acceptance criteria
- **PXY-4** WHEN a pay or tool request is received, THE SYSTEM SHALL lock the agent's envelope row, load window state, evaluate the policy, and append the decision event inside one database transaction.
- **PXY-5** THE SYSTEM SHALL call a rail only after the decision event has been written, and only when the decision is `allow`.
- **PXY-6** WHEN the rail returns, THE SYSTEM SHALL append a rail-result event with the rail reference (transaction hash or PaymentIntent ID), the failure reason, or `status: "unknown"` (RES-5).
- **PXY-7** IF any step before the rail call fails, THEN THE SYSTEM SHALL not call the rail and SHALL return HTTP 503 with a generic message (fail closed).
- **PXY-8** WHEN a request repeats an `Idempotency-Key` that the same agent used within the retention period (PXY-13) with the same request body, THE SYSTEM SHALL return the original response and SHALL NOT evaluate or charge again.
- **PXY-9** WHILE many requests for the same agent run concurrently, THE SYSTEM SHALL keep the total allowed spend within every envelope cap.
- **PXY-10** WHEN the decision includes `VELOCITY_EXCEEDED`, THE SYSTEM SHALL set the agent's frozen flag in the same transaction.
- **PXY-11** WHEN a pay or tool request is evaluated, THE SYSTEM SHALL read the agent's frozen flag inside the PXY-4 transaction, after the envelope lock is held, and pass it to the policy engine, so that a frozen agent's request is denied with `AGENT_FROZEN` as defined in money-and-policy-core ENV-5.
- **PXY-12** IF a request reuses an `Idempotency-Key` that the same agent used within the retention period with a different request body, THEN THE SYSTEM SHALL return HTTP 422 with `IDEMPOTENCY_KEY_REUSED`, and SHALL NOT evaluate or charge.
- **PXY-13** THE SYSTEM SHALL keep each idempotency record for 24 hours after it was created. After that, THE SYSTEM SHALL treat the key as unused.
- **PXY-14** IF a request repeats an `Idempotency-Key` whose original request has not finished, THEN THE SYSTEM SHALL return HTTP 409 with `IDEMPOTENCY_IN_PROGRESS`, and SHALL NOT evaluate or charge.
- **PXY-15** WHEN an authenticated agent sends a pay, tool, or fetch request, THE SYSTEM SHALL count it against a limit of 120 requests per agent per minute, before any transaction, idempotency claim, or audit event. Past the limit it SHALL answer 429 `RATE_LIMITED` and write nothing else. IF the count can't be made, THEN THE SYSTEM SHALL answer 503 and not run the request (PXY-7).

## Requirement 3: Spend reservations and uncertain rail outcomes
**User story:** As a security owner, I want money that might have moved to keep counting against the budget, so that a slow or broken rail can't be used to overspend.

### Acceptance criteria
- **RES-1** WHEN a decision is `allow` for a request that moves money, THE SYSTEM SHALL insert a reservation for the chargeable amount in the same transaction as the decision event. Hold and deny decisions, and tools with no rail, SHALL NOT create a reservation.
- **RES-2** WHILE a reservation's status is `reserved` or `settled`, THE SYSTEM SHALL count its amount in every window (for its agent, vendor, and tool) that contains its `created_at`. An unresolved reservation SHALL count the same as a settled one.
- **RES-3** WHEN the rail confirms the payment, THE SYSTEM SHALL mark the reservation `settled`.
- **RES-4** THE SYSTEM SHALL mark a reservation `released` only after a confirmed failure. No other outcome SHALL release a reservation.
- **RES-5** IF the rail call times out or returns an unknown outcome, THEN THE SYSTEM SHALL append a `rail_result` event with `status: "unknown"`, keep the reservation `reserved`, and return HTTP 202 with `rail_status: "unknown"`.
- **RES-6** WHEN the reconciler runs, THE SYSTEM SHALL find every reservation still `reserved` 10 minutes after creation and resolve it with the rail. It SHALL append a `rail_result` event that references the original decision and either settle the reservation (RES-3) or release it (RES-4).
- **RES-7** IF the reconciler can't determine the outcome, THEN THE SYSTEM SHALL leave the reservation `reserved` and try again on the next run.
- **RES-8** THE reconciler SHALL query or retry the rail only with the reservation's original rail idempotency key, and SHALL never start a new payment.
- **RES-9** WHEN the reconciler resolves a reservation, THE SYSTEM SHALL update the stored idempotency response so that replays of the original request return the resolved result.

## Requirement 4: Tamper-evident audit log
**User story:** As an auditor, I want an append-only, hash-chained log, so that I can prove no decision was altered after the fact.

### Acceptance criteria
- **AUD-1** THE SYSTEM SHALL record every decision, rail result, taint change, approval action and expiry, envelope change, agent freeze or unfreeze, and sandbox creation or retirement as an audit event.
- **AUD-2** WHEN an event is appended, THE SYSTEM SHALL set `seq` to the previous `seq` + 1 for that workspace, store `prev_hash`, and store `hash` as defined in CJ-7.
- **AUD-3** IF any `UPDATE`, `DELETE`, or `TRUNCATE` is attempted on `audit_events`, THEN THE DATABASE SHALL reject it. `TRUNCATE` SHALL be blocked by a statement-level trigger.
- **AUD-4** WHEN the chain is verified, THE SYSTEM SHALL recompute every hash in `seq` order, check the last event against the chain head (AUD-7), and report either "OK" with the count or the first `seq` whose hash, link, or presence does not match.
- **AUD-5** THE SYSTEM SHALL never store secrets, API keys, wallet keys, card data, or raw fetched content in audit events.
- **AUD-6** WHEN a user clicks "Verify chain" in the dashboard, THE SYSTEM SHALL run AUD-4 and show the result.
- **AUD-7** WHEN an event is appended, THE SYSTEM SHALL update the workspace's chain head to the new `seq` and `hash` in the same transaction, with an HMAC that only the server can compute, so that deleting rows from the end of the chain is detected.
- **AUD-8** IF the chain head is missing, has an invalid HMAC, or its `seq` and `hash` do not match the last event, THEN verification SHALL fail and report the first missing or mismatched `seq`.
- **AUD-9** WHEN the sandbox is reset, THE SYSTEM SHALL create and seed a new sandbox workspace, retire the previous one, and revoke the retired workspace's agent API keys. THE SYSTEM SHALL NOT delete `audit_events` rows to reset the sandbox.

## Requirement 5: Canonical JSON for hashing
**User story:** As an auditor, I want one exact byte encoding for every event, so that anyone can recompute the hashes and get the same result.

### Acceptance criteria
- **CJ-1** WHEN an object is encoded, THE SYSTEM SHALL sort its keys in ascending order of UTF-16 code units, at every nesting level, and keep array order unchanged.
- **CJ-2** THE SYSTEM SHALL emit no whitespace outside strings, and SHALL escape strings exactly as `JSON.stringify` does, without Unicode normalization.
- **CJ-3** WHEN a `bigint` is encoded, THE SYSTEM SHALL emit it as a JSON string of its base-10 digits.
- **CJ-4** WHEN a `number` is encoded, THE SYSTEM SHALL accept only safe integers, encoding `-0` as `0`. IF a number is fractional, `NaN`, or infinite, THEN THE SYSTEM SHALL reject the value.
- **CJ-5** WHEN an object property is `undefined`, THE SYSTEM SHALL omit it. IF a value is `undefined` inside an array, or is a function, symbol, `Date`, `Map`, `Set`, or class instance, THEN THE SYSTEM SHALL reject the value.
- **CJ-6** THE hashed event body SHALL be exactly `workspace_id`, `seq`, `type`, `created_at`, and `payload`, where `created_at` is an ISO 8601 UTC string with exactly 3 fractional digits set by the application.
- **CJ-7** THE SYSTEM SHALL compute `hash` as the lowercase hex SHA-256 of the UTF-8 bytes of `prev_hash` (64 lowercase hex characters) followed directly by the canonical JSON of the event body. The first event in a workspace SHALL use 64 zeros as `prev_hash`.
- **CJ-8** IF an event can't be canonically encoded, THEN THE SYSTEM SHALL reject the append, roll back the transaction, and fail closed (PXY-7).

## Requirement 6: Human-in-the-loop approvals
**User story:** As a developer, I want risky requests to wait for me, so that I can approve legitimate ones and stop attacks.

### Acceptance criteria
- **HITL-1** WHEN a decision is `hold`, THE SYSTEM SHALL create a pending approval that stores the full request, the reasons, and an expiry time (default 15 minutes).
- **HITL-2** WHEN an authorized approver (HITL-10, HITL-11) approves a pending approval, THE SYSTEM SHALL re-run the full pay flow (PXY-4 to PXY-6) with the approval attached, which satisfies only the hold reasons that were approved.
- **HITL-3** IF the re-run produces any deny reason, including `AGENT_FROZEN`, or any hold reason that was not approved, THEN THE SYSTEM SHALL not execute and SHALL mark the approval `failed_recheck` with those reasons.
- **HITL-4** WHEN an authorized approver denies a pending approval, THE SYSTEM SHALL mark it `denied` and not execute.
- **HITL-5** IF an approval is acted on after its expiry, THEN THE SYSTEM SHALL mark it `expired`, not execute, and return HTTP 409 with `APPROVAL_EXPIRED`.
- **HITL-6** IF an approval that is not `pending` is approved or denied again, THEN THE SYSTEM SHALL reject the action with HTTP 409.
- **HITL-7** THE SYSTEM SHALL execute an approved request at most once.
- **HITL-8** WHEN an approval changes state, THE SYSTEM SHALL write an audit event with the actor's identity (a user ID, `sandbox_visitor`, or `system`).
- **HITL-9** WHEN an authorized approver unfreezes a frozen agent, THE SYSTEM SHALL clear the flag and write an audit event.
- **HITL-10** IF a request to an approval endpoint or the unfreeze endpoint carries an agent API key, THEN THE SYSTEM SHALL reject it with HTTP 403 and change nothing, in every workspace including the sandbox.
- **HITL-11** WHERE the workspace is the public sandbox, THE SYSTEM SHALL let anyone approve, deny, or unfreeze without signing in, and SHALL execute sandbox requests only on mock rails (rail-adapters RAIL-2). Outside the sandbox, only a signed-in member of the approval's workspace SHALL be an authorized approver.
- **HITL-12** WHEN approvals are read or acted on, THE SYSTEM SHALL first mark every pending approval past its `expires_at` as `expired` and write one `approval_expired` audit event per approval, exactly once.
