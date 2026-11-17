# Tasks: Rail Adapters

Plan (`docs/PLAN.md`): **Phase 6** = tasks 1–2. **Phase 13** = tasks 3–5. **Phase 14** = tasks 6–8.

- [x] 1. Define the adapter interface and startup config validation
  - `src/rails/types.ts`, `src/rails/config.ts` (Zod env schema)
  - Refuse `sk_live_` keys and non-Base-Sepolia networks
  - `pnpm env:check`: validates the env schema and prints only pass or fail per variable, never values (used by `/validate-mpp`)
  - _Requirements: RAIL-1, RAIL-5, RAIL-7, RAIL-8, RAIL-9_

- [x] 2. Build the mock adapter and `railFor()` selector
  - Deterministic refs, minimums, failure modes (including a timeout after the payment is recorded)
  - `lookup()` and `setLookupResult()` for the reconciler (audit-and-approvals task 9)
  - Properties 1, 2, and 4
  - _Requirements: RAIL-2, RAIL-3, RAIL-4, RAIL-5, RAIL-6, RAIL-19, RAIL-20, RAIL-21, RAIL-22_

- [x] 3. Set up the x402 accounts (step-by-step in `docs/SETUP.md`)
  - Create a CDP API key in the CDP portal (Live, no permissions checked)
  - Create two Base Sepolia test wallets: one for the vendor (`X402_PAY_TO`), one for the agent (`AGENT_WALLET_PRIVATE_KEY`). Explain what a private key is and why this one must never hold real funds
  - Get test USDC from a faucet; explain what a faucet is. Test ETH turned out to be unnecessary: the facilitator pays the gas
  - `pnpm wallet:new`, `pnpm x402:status`, and an x402 section in `pnpm env:check`
  - _Requirements: RAIL-9_

- [x] 4. Build the x402 vendor endpoint `/vendor/api/weather`
  - CDP facilitator, `eip155:84532`, price `$0.0015`
  - Measured on Base Sepolia: sub-cent settles; the facilitator refuses 999 units with `amount_too_low` and settles 1000. `X402_MIN_UNITS` defaults to 1000. Recorded in `docs/KIRO_LOG.md`
  - _Requirements: RAIL-10_

- [x] 5. Build the x402 payer adapter
  - Challenge check, signing, retry, transaction hash, explorer link
  - `lookup()` through `authorizationState`. The nonce is derived from the idempotency key and the deadline from the reservation's `created_at`, so nothing is stored before sending
  - Contract tests with recorded fixtures; `@live` tests
  - Property 3
  - _Requirements: RAIL-11, RAIL-12, RAIL-13, RAIL-21, RAIL-22_

- [x] 6. Set up Stripe test mode (step-by-step in `docs/SETUP.md`)
  - Find the `sk_test_` key, create the Stripe profile, get the `profile_` ID. A sandbox's profile ID starts with `profile_test_`, which real mode now requires; `pnpm stripe:profile` prints it
  - Seed a $500 test PaymentIntent for the refund scenario (`pnpm stripe:seed`)
  - A Stripe section in `pnpm env:check`
  - _Requirements: RAIL-7_

- [x] 7. Build the MPP vendor endpoint `/vendor/api/report` and pass the validator
  - `mppx` at $0.50, through its SPT-only entry points (mppx 0.19's `defaultMethods()` needs a shared store)
  - Discovery at `/openapi.json`; the validator runs against the origin, because it resolves paths against the URL it's given
  - Run `/validate-mpp` (`pnpm mpp:validate`): 18 checks pass, including a $0.50 test payment
  - _Requirements: RAIL-14, RAIL-18_

- [x] 8. Build the Stripe MPP payer adapter and refunds
  - Test SPT from the test helper, present to the challenge, record PaymentIntent ID
  - `refund()` through the Refunds API with an idempotency key and `metadata.idempotency_key`
  - `lookup()` for payments and refunds by `metadata.idempotency_key`. Confirmed: the MPP flow carries it to the PaymentIntent through the credential's `externalId`. Absence can't be proven, so it stays `unknown`
  - Contract tests with fixtures (`pnpm stripe:probe --record`); `@live` tests
  - _Requirements: RAIL-15, RAIL-16, RAIL-17, RAIL-21, RAIL-22_

- [x] 9. Send guarded payments to the vendor's payment URL
  - `vendors.x402_url` and `vendors.mpp_url` (migration 0003), a check constraint keeping each under the vendor's origin, and the sandbox seed's URLs for `nimbus-weather` (seed version 2)
  - The guarded flow passes the URL for the tool's rail (`paymentUrl()`); both real adapters refuse a missing or non-http URL as `RAIL_REJECTED` before contacting anyone, so the reservation is released
  - The `@live` x402 test's guarded payment now goes to the scene vendor's `x402_url` and settles on Base Sepolia. A real payment over HTTP needs a workspace outside the sandbox with vendors, which doesn't exist yet
  - _Requirements: RAIL-23, RAIL-24, RAIL-25_

- [ ] 10. Serve `/llms.txt`
  - A static route with the summary, built from the vendor constants, and a route test
  - Run `/validate-mpp` again: the llms.txt suggestion should be gone
  - _Requirements: RAIL-26_
