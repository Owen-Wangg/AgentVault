# Requirements: Rail Adapters

## Introduction
This spec covers the adapters that turn an allowed decision into a real payment, and the demo vendor endpoints that charge for data. There are three adapters behind one interface: **mock** (always available), **x402** on Base Sepolia through the Coinbase CDP facilitator, and **Stripe MPP** in Stripe test mode using card Shared Payment Tokens (SPTs). The public sandbox always uses mock.

## Glossary
- **Payer side**: AgentVault paying a vendor on the agent's behalf.
- **Vendor side**: our demo vendor API that answers with HTTP 402 and accepts payment.
- **Rail reference**: the on-chain transaction hash (x402) or Stripe PaymentIntent or Refund ID.

## Requirement 1: Common adapter interface
**User story:** As a developer, I want every rail behind the same interface, so that policy code never depends on a rail.

### Acceptance criteria
- **RAIL-1** THE SYSTEM SHALL expose `quote`, `execute`, `refund`, and `lookup` with the same signatures for every rail.
- **RAIL-2** WHEN `RAIL_MODE` is `mock`, or the workspace is the sandbox, THE SYSTEM SHALL use the mock adapter for every rail.
- **RAIL-3** WHEN `execute` is called twice with the same idempotency key, THE SYSTEM SHALL perform at most one payment.
- **RAIL-4** IF the converted amount is below the rail's minimum, THEN THE SYSTEM SHALL return `BELOW_RAIL_MINIMUM` without contacting the rail.
- **RAIL-5** THE SYSTEM SHALL validate every rail response with Zod and return `INVALID_RAIL_RESPONSE` for an invalid one. The server treats it as an unknown outcome, because an unreadable response does not prove that no money moved (audit-and-approvals RES-5).
- **RAIL-6** WHEN a rail call fails or times out (default 30 seconds), THE SYSTEM SHALL return a typed failure that the server records as a `rail_result` event. A timeout SHALL return `RAIL_TIMEOUT`, which the server records with `status: "unknown"` and does not release (audit-and-approvals RES-4, RES-5).
- **RAIL-21** WHEN `lookup` is called with an idempotency key, THE adapter SHALL report `settled` (with the rail reference), `failed` (only when the rail proves no payment happened and none can still happen), or `unknown`.
- **RAIL-22** THE `lookup` method SHALL never create, sign, or submit a payment or refund.

## Requirement 2: Test-only safety
**User story:** As the developer, I want the app to refuse real money, so that a config mistake can't spend real funds.

### Acceptance criteria
- **RAIL-7** IF `STRIPE_SECRET_KEY` starts with `sk_live_`, THEN THE SYSTEM SHALL refuse to start.
- **RAIL-8** IF the configured x402 network is not `eip155:84532` (Base Sepolia), THEN THE SYSTEM SHALL refuse to start.
- **RAIL-9** THE SYSTEM SHALL read the agent wallet private key only from an environment variable, never log it, and never send it to the client.

## Requirement 3: x402 on Base Sepolia
**User story:** As a judge, I want to see a real on-chain micro-payment, so that I know the integration is real.

### Acceptance criteria
- **RAIL-10** WHEN the vendor endpoint `/vendor/api/weather` receives a request without payment, THE SYSTEM SHALL return HTTP 402 with x402 payment requirements for Base Sepolia USDC.
- **RAIL-11** WHEN the x402 adapter executes an allowed payment, THE SYSTEM SHALL pay the vendor's 402 challenge from the agent wallet, retry the request, and return the vendor's response.
- **RAIL-12** WHEN an x402 payment settles, THE SYSTEM SHALL record the transaction hash and a Base Sepolia block explorer link in the `rail_result` event.
- **RAIL-13** IF the amount in the vendor's 402 challenge differs from the amount the policy approved, THEN THE SYSTEM SHALL not pay and SHALL return `CHALLENGE_MISMATCH`.

## Requirement 4: Stripe MPP in test mode
**User story:** As a judge, I want to see a card-based agent payment and a refund in Stripe, so that I know both rails work.

### Acceptance criteria
- **RAIL-14** WHEN the vendor endpoint `/vendor/api/report` receives a request without payment, THE SYSTEM SHALL return an MPP 402 challenge for $0.50 using `mppx`.
- **RAIL-15** WHEN the Stripe MPP adapter executes an allowed payment, THE SYSTEM SHALL obtain a test SPT scoped to the approved amount and present it to the vendor's challenge.
- **RAIL-16** WHEN a Stripe payment succeeds, THE SYSTEM SHALL record the PaymentIntent ID in the `rail_result` event.
- **RAIL-17** WHEN an allowed or approved `stripe.refund` runs, THE SYSTEM SHALL create a test-mode refund through the Refunds API and record the Refund ID.
- **RAIL-18** THE SYSTEM SHALL pass the MPP validator (`npx mppx@latest validate`) for `/vendor/api/report`.

## Requirement 6: Payment URLs for guarded payments
**User story:** As a developer, I want an agent's allowed payment to reach the vendor's paid endpoint, so that real x402 and MPP payments run through AgentVault, not only through the adapters directly.

### Acceptance criteria
- **RAIL-23** WHEN an allowed `x402.pay` or `mpp.pay` runs, THE SYSTEM SHALL send it to the vendor's registered payment URL for that rail (`x402_url` or `mpp_url`), never to a URL from the agent's request.
- **RAIL-24** IF the vendor has no payment URL for the tool's rail, THEN THE SYSTEM SHALL fail closed with `RAIL_REJECTED` without contacting any vendor, and release the reservation.
- **RAIL-25** THE SYSTEM SHALL store a payment URL only if it is on the vendor's own registered origin (the database refuses any other value).

## Requirement 5: Mock rails
**User story:** As a judge, I want the sandbox to work without any accounts, so that I can test the app right away.

### Acceptance criteria
- **RAIL-19** THE mock adapter SHALL return deterministic rail references (`mock_tx_<hash of idempotency key>`), and SHALL simulate the same minimums and failure codes as the real rails.
- **RAIL-20** WHERE a test sets a failure mode on the mock adapter, THE mock adapter SHALL return that failure. A test SHALL also be able to set what a later `lookup` reports for a key.
