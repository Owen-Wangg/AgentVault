# Tasks: Rail Adapters

Plan (`docs/PLAN.md`): **Phase 6** = tasks 1–2. **Phase 13** = tasks 3–5. **Phase 14** = tasks 6–8.

- [ ] 1. Define the adapter interface and startup config validation
  - `src/rails/types.ts`, `src/rails/config.ts` (Zod env schema)
  - Refuse `sk_live_` keys and non-Base-Sepolia networks
  - _Requirements: RAIL-1, RAIL-5, RAIL-7, RAIL-8, RAIL-9_

- [ ] 2. Build the mock adapter and `railFor()` selector
  - Deterministic refs, minimums, failure modes (including a timeout after the payment is recorded)
  - `lookup()` and `setLookupResult()` for the reconciler (audit-and-approvals task 9)
  - Properties 1, 2, and 4
  - _Requirements: RAIL-2, RAIL-3, RAIL-4, RAIL-5, RAIL-6, RAIL-19, RAIL-20, RAIL-21, RAIL-22_

- [ ] 3. Set up the x402 accounts (step-by-step in `docs/SETUP.md`)
  - Create a CDP API key in the CDP portal
  - Create two Base Sepolia test wallets: one for the vendor (`X402_PAY_TO`), one for the agent (`AGENT_WALLET_PRIVATE_KEY`). Explain what a private key is and why this one must never hold real funds
  - Get test ETH and test USDC from a faucet; explain what a faucet is
  - _Requirements: RAIL-9_

- [ ] 4. Build the x402 vendor endpoint `/vendor/api/weather`
  - CDP facilitator, `environment: "development"`, `eip155:84532`
  - Test whether a sub-cent price settles; record the result in `docs/KIRO_LOG.md`
  - _Requirements: RAIL-10_

- [ ] 5. Build the x402 payer adapter
  - Challenge check, signing, retry, transaction hash, explorer link
  - `lookup()` through `authorizationState`; decide whether the nonce can be derived from the idempotency key or must be stored before sending
  - Contract tests with recorded fixtures; `@live` test
  - Property 3
  - _Requirements: RAIL-11, RAIL-12, RAIL-13, RAIL-21, RAIL-22_

- [ ] 6. Set up Stripe test mode (step-by-step in `docs/SETUP.md`)
  - Find the `sk_test_` key, create the Stripe profile, get the `profile_` ID
  - Seed a $500 test PaymentIntent for the refund scenario
  - _Requirements: RAIL-7_

- [ ] 7. Build the MPP vendor endpoint `/vendor/api/report` and pass the validator
  - `mppx` at $0.50
  - Run `/validate-mpp`
  - _Requirements: RAIL-14, RAIL-18_

- [ ] 8. Build the Stripe MPP payer adapter and refunds
  - Test SPT from the test helper, present to the challenge, record PaymentIntent ID
  - `refund()` through the Refunds API with an idempotency key and `metadata.idempotency_key`
  - `lookup()` for payments and refunds by `metadata.idempotency_key`
  - Contract tests with fixtures; `@live` tests
  - _Requirements: RAIL-15, RAIL-16, RAIL-17, RAIL-21, RAIL-22_
