# Tasks: Payout Rails

Plan (`docs/PLAN.md`): **Phase 20** = tasks 1–4. **Phase 21** = tasks 5–6. **Phase 22** = tasks 7–8.

- [x] 1. Update steering and the money core for payouts
  - `tech.md`: Stripe Connect (Accounts v2 recipients, Transfers) and the PayPal sandbox in the rails table, with why each was added
  - `security-standards.md`: `paypal.payout` in the §3 high-privilege list; §7 refuses any PayPal environment but `sandbox` and any `livemode: true` Stripe object
  - `money-arithmetic.md`: payouts are credits; PayPal uses cents with the same directional rounding
  - `Rail` gains `"paypal"`; `toRailUnits` and `chargeableMicros` cover it; the high-privilege set in `src/core/taint` adds `paypal.payout`
  - Property 2 and property 4
  - _Requirements: PO-3, PO-17, PO-18, PO-19_

- [x] 2. Set up the accounts and measure both rails (step by step in `docs/SETUP.md`)
  - `pnpm connect:setup`: two Accounts v2 recipient accounts (the supplier and the attacker) and test funds in the platform balance; prints only `acct_` IDs
  - Create the PayPal developer sandbox app, a business (sender) account, and two personal (receiver) accounts; explain what each is
  - `pnpm connect:probe` and `pnpm paypal:probe`: USD transfers from the Canadian sandbox, minimums, a repeated key or `sender_batch_id`, and a read-only lookup by the reservation ID alone. Record results in `docs/KIRO_LOG.md` and change this spec if a finding contradicts it
  - A PayPal section in `pnpm env:check`, and the recipient accounts in `pnpm connect:check` (read-only)
  - _Requirements: PO-21, PO-22_

- [x] 3. Add `payout` and `checkDestination` to the rail interface, the mock rail, and the registry
  - `RailAdapter.payout()` and `checkDestination()`; x402 returns `RAIL_REJECTED` without a call; the mock rail records payouts with deterministic `mock_po_` references
  - `ToolDef.operation`; `payout.create` becomes a credit on the stripe rail; `paypal.payout` registered; `payee.update` takes `rail`
  - Properties 3 and 6
  - _Requirements: PO-1, PO-2, PO-5, PO-10, PO-14_

- [x] 4. Route payouts and payee changes through the guarded flow
  - Migration 0004: `vendors.stripe_account` and `vendors.paypal_receiver` with format checks
  - Payouts read the destination at execution time; no destination fails closed without a rail call
  - `payee.update`: commit the decision, check the destination outside the lock, then update the row with `rail_result` and `payee_updated` in one transaction; approvals re-run the same path
  - The live feed shows `payee_updated`
  - Property 1
  - _Requirements: PO-4, PO-11, PO-12, PO-13, PO-20, PO-24_

- [x] 5. Build the Stripe Connect payout adapter
  - Accounts v2 capability and `livemode` checks; `POST /v1/transfers` with the derived idempotency key, `transfer_group`, and metadata; lookup by `transfer_group`
  - Contract tests on recorded exchanges (`pnpm connect:probe --record`); `@live` test of a guarded $1.00 transfer
  - _Requirements: PO-6, PO-7, PO-8, PO-9_

- [x] 6. Build the PayPal sandbox payout adapter
  - Fixed sandbox host and the `PAYPAL_ENV` check; OAuth token cache; payout batch with `sender_batch_id`; status mapping; lookup as the probe allows
  - Contract tests on recorded exchanges (`pnpm paypal:probe --record`); `@live` test of a guarded $1.00 payout
  - Property 5
  - Migration 0005 (`spend_reservations.rail_ref`); `pendingRef` on unknown results, stored by the flow and passed to `lookup()` by the reconciler; `paypal` in the reconciler's rail list
  - _Requirements: PO-15, PO-16, PO-17, PO-25_

- [x] 7. Add the Payee hijack scenario
  - `acme-supplies` in the sandbox seed, the poisoned invoice page `/vendor/docs/invoice`, the task, the envelope, and the scripted steps
  - Scenario card, steps, and summary on `/scenarios`, with copy in both themes
  - `agentvault_request_tool` accepts `paypal.payout` and `payee.update`'s `rail`
  - The Playwright test's hijack path
  - _Requirements: PO-23, PO-24_

- [x] 8. Update the docs
  - README (scenarios table, rails, limits), `docs/MCP.md`, the Devpost story, the Kiro write-up, and the demo script
  - Run `/validate-mpp` again to confirm the MPP endpoint is unchanged
  - _Requirements: PO-21, PO-23_

- [x] 9. Record a failed destination read as a failed payout
  - `executeGuarded` catches the destination read and records `RAIL_REJECTED` without a rail call
  - _Requirements: PO-26_

- [ ] 10. Name each run's supplier from its agent ID
  - `runPayeeName` takes the new agent ID (16 hex characters), not the client's run ID
  - _Requirements: PO-23_
