# Requirements: Money and Policy Core

## Introduction
This spec covers the pure domain core of AgentVault: the `Micros` money type and the policy engine that decides whether a payment request is allowed, held, or denied under the agent's spend envelope. Both live in `src/core` and do no I/O, so they can be property-tested exhaustively. Taint and intent rules are in the `taint-and-intent` spec; this engine consumes their results.

## Glossary
- **Micros**: integer count of millionths of a USD, stored as `bigint`.
- **Envelope**: the set of spend limits attached to an agent.
- **Window state**: spend and call counts in the trailing minute, hour, and day, computed by the server and passed in.
- **Decision**: `allow`, `hold`, or `deny`, with one or more reason codes.

## Requirement 1: Exact money representation
**User story:** As a developer, I want every amount stored as integer micros, so that sub-cent agent charges are exact and never lose precision.

### Acceptance criteria
- **MON-1** THE SYSTEM SHALL represent every monetary amount as a non-negative `bigint` count of micros, where 1 USD = 1,000,000 micros.
- **MON-2** WHEN a decimal string with at most 6 decimal places is parsed, THE SYSTEM SHALL return the exact equivalent in micros.
- **MON-3** IF a decimal string is negative, uses exponent notation, has more than 6 decimal places, or is otherwise malformed, THEN THE SYSTEM SHALL reject it with `INVALID_AMOUNT`.
- **MON-4** IF a value of JavaScript type `number` is passed where an amount is expected, THEN THE SYSTEM SHALL reject it at compile time through the branded type, and at runtime with `INVALID_AMOUNT`.
- **MON-5** IF an arithmetic result would be negative or exceed `MAX_MICROS`, THEN THE SYSTEM SHALL throw `AMOUNT_OUT_OF_RANGE` instead of returning a value.
- **MON-6** WHEN an amount is formatted for display, THE SYSTEM SHALL show at least 2 and at most 6 decimal places with no rounding (for example `1500n` → `$0.0015`).

## Requirement 2: Rail unit conversion
**User story:** As a security owner, I want conversion to rail units to never favor the agent, so that rounding can't be used to exceed a budget.

### Acceptance criteria
- **MON-7** WHEN converting a debit to Stripe cents, THE SYSTEM SHALL round up to the next whole cent.
- **MON-8** WHEN converting a credit to Stripe cents, THE SYSTEM SHALL round down to the whole cent.
- **MON-9** WHEN converting any amount to x402 USDC atomic units, THE SYSTEM SHALL convert exactly 1:1 with no rounding.
- **MON-10** WHEN a debit is counted against an envelope, THE SYSTEM SHALL count the post-conversion (rounded-up) amount.

## Requirement 3: Spend envelope limits
**User story:** As a developer, I want per-agent spend limits, so that a compromised or looping agent can't drain my account.

### Acceptance criteria
- **ENV-1** IF a request's amount exceeds the envelope's per-transaction maximum, THEN THE SYSTEM SHALL deny it with `OVER_TX_MAX`.
- **ENV-2** IF a request's amount plus the trailing-minute, trailing-hour, or trailing-day spend would exceed the matching cap, THEN THE SYSTEM SHALL deny it with `OVER_WINDOW_CAP` and name the window.
- **ENV-3** IF the agent's call count in the trailing minute, including this request, exceeds the envelope's calls-per-minute limit, THEN THE SYSTEM SHALL deny it with `VELOCITY_EXCEEDED`.
- **ENV-4** WHEN `VELOCITY_EXCEEDED` is returned, THE SYSTEM SHALL mark the agent as frozen until a human unfreezes it.
- **ENV-5** WHILE an agent is frozen, THE SYSTEM SHALL deny every request from that agent with `AGENT_FROZEN`.
- **ENV-6** IF the vendor is not on the envelope's vendor allow-list, THEN THE SYSTEM SHALL deny the request with `VENDOR_NOT_ALLOWED`.
- **ENV-7** IF the tool is not on the envelope's tool allow-list, THEN THE SYSTEM SHALL deny the request with `TOOL_NOT_ALLOWED`.
- **ENV-8** IF a request passes all deny rules and its amount is at or above the envelope's approval threshold, THEN THE SYSTEM SHALL hold it with `NEEDS_APPROVAL`.
- **ENV-9** WHERE a per-vendor or per-tool limit is configured, THE SYSTEM SHALL apply it in addition to the agent-level limits, and the stricter limit SHALL win.
- **ENV-10** WHEN a request passes every rule, THE SYSTEM SHALL return `allow` with no reason codes.

## Requirement 4: Decision semantics
**User story:** As a security owner, I want decisions to be predictable and explainable, so that I can trust and audit them.

### Acceptance criteria
- **ENV-11** THE SYSTEM SHALL return every applicable reason code, not only the first.
- **ENV-12** IF any reason code is a deny reason, THEN THE SYSTEM SHALL return `deny`; otherwise, IF any reason is a hold reason, THEN `hold`; otherwise `allow`.
- **ENV-13** WHEN given identical inputs, THE SYSTEM SHALL return an identical decision.
- **ENV-14** IF any envelope cap is lowered and all other inputs stay the same, THEN THE SYSTEM SHALL NOT change a `deny` into `hold` or `allow`.
- **ENV-15** IF the inputs fail schema validation, THEN THE SYSTEM SHALL return `deny` with `INVALID_REQUEST` (fail closed).
