# Requirements: Payout Rails

## Introduction
AgentVault's most dangerous tools send money out or change where it goes: `payout.create`, `payee.update`, and `wire_transfer`. Until now they ran only on the mock rail. This spec gives two of them real test-mode rails: **Stripe Connect** (Accounts v2 recipient accounts and Transfers) for `payout.create` and `payee.update`, and the **PayPal sandbox** (Payouts API) for a new `paypal.payout` tool. Every rule that applies to payments applies to payouts: the envelope, intent scope, taint, approvals, the audit log, reservations, and unknown outcomes. `wire_transfer` stays on the mock rail.

The public sandbox keeps using mock rails for all of these (rail-adapters RAIL-2). Real payout rails run only with `RAIL_MODE=real`, outside the sandbox.

## Glossary
- **Payee**: a vendor that receives payouts. Its payout destinations are stored on its vendor row.
- **Payout destination**: a Stripe connected account ID (`acct_…`) or a PayPal receiver email.
- **Recipient account**: a Stripe Accounts v2 connected account with the `recipient` configuration and the `stripe_balance.stripe_transfers` capability.
- **Payout**: money leaving the platform to a payee: a Stripe Transfer or a PayPal payout item.

## Requirement 1: Payouts are their own operation
**User story:** As a developer, I want payouts handled as payouts, not as charges or refunds, so that rounding, routing, and lookups are right for money going out.

### Acceptance criteria
- **PO-1** THE rail adapter interface SHALL add `payout` and `checkDestination` methods with the same signatures on every rail. A rail that can't pay out SHALL return `RAIL_REJECTED` from both without contacting anyone.
- **PO-2** WHEN an allowed `payout.create` or `paypal.payout` runs, THE SYSTEM SHALL call the rail's `payout` method, never `execute` or `refund`.
- **PO-3** THE SYSTEM SHALL send the payee at most the approved amount: rail units round down (money-arithmetic, credit direction), and the envelope counts the full requested amount (MON-11).
- **PO-4** THE SYSTEM SHALL send a payout only to the payout destination registered on the payee's vendor row for that rail, never to a destination from the agent's request. IF the payee has no destination for the rail, THEN THE SYSTEM SHALL fail closed with `RAIL_REJECTED` without contacting the rail, and release the reservation.
- **PO-5** THE `payout` method SHALL be idempotent per reservation: called twice with the same idempotency key, it SHALL pay out at most once.

## Requirement 2: Stripe Connect payouts
**User story:** As a judge, I want to see an agent's payout to another business held, approved, and then sent in Stripe test mode, so that I know AgentVault guards money going out, not only purchases.

### Acceptance criteria
- **PO-6** WHEN the Stripe adapter pays out, THE SYSTEM SHALL first read the destination account through the Accounts v2 API and SHALL pay out only if `configuration.recipient.capabilities.stripe_balance.stripe_transfers.status` is `active`. Otherwise it SHALL return `RAIL_REJECTED` without creating a transfer.
- **PO-7** WHEN the Stripe adapter pays out, THE SYSTEM SHALL create a Transfer in USD to the destination with an `Idempotency-Key` derived from the reservation, `transfer_group` set to the reservation ID, and `metadata.idempotency_key` set to the reservation ID, and SHALL record the Transfer ID in the `rail_result` event.
- **PO-8** WHEN `lookup` is called for a Stripe payout, THE SYSTEM SHALL find the Transfer by its `transfer_group`. A found transfer that hasn't been reversed is `settled`; nothing found stays `unknown` (rail-adapters RAIL-21).
- **PO-9** IF a connected account or transfer that Stripe returns has `livemode: true`, THEN THE SYSTEM SHALL treat the response as invalid and not record it as settled (security-standards §7).

## Requirement 3: Changing a payee's destination
**User story:** As a security engineer, I want changes to where payouts go treated as high-privilege, so that a prompt-injected agent can't redirect money to an attacker's account.

### Acceptance criteria
- **PO-10** `payee.update` SHALL take `vendor`, `payee_ref`, and an optional `rail` (`stripe` by default, or `paypal`). `payee_ref` SHALL match the rail's format: `acct_` followed by letters and digits for Stripe, or a PayPal sandbox account address (`@personal.example.com` or `@business.example.com`) for PayPal.
- **PO-11** WHEN `payee.update` is allowed or approved, THE SYSTEM SHALL commit the decision first, then verify the new destination with `checkDestination` outside the envelope lock, and only then store it on the vendor row, in the same transaction as the `rail_result` event. In real mode, a Stripe destination SHALL pass the PO-6 capability check; in the sandbox, the mock rail accepts any well-formed reference.
- **PO-12** WHEN a payee's destination changes, THE SYSTEM SHALL append a `payee_updated` audit event with the vendor, the rail, the old and new references, and the decision's `seq`.
- **PO-13** IF verification fails, THEN THE SYSTEM SHALL leave the vendor row unchanged and record `RAIL_REJECTED`.

## Requirement 4: PayPal sandbox payouts
**User story:** As a judge, I want a second business payout rail, so that I can see AgentVault's rules apply the same way to a different provider.

### Acceptance criteria
- **PO-14** THE SYSTEM SHALL register `paypal.payout` as a high-privilege tool on the `paypal` rail, with the same arguments as `payout.create`.
- **PO-15** WHEN the PayPal adapter pays out, THE SYSTEM SHALL create a payout batch through the Payouts API with one USD item to the payee's registered receiver, `sender_batch_id` set to the reservation ID, and the amount as a decimal string built from integer cents.
- **PO-16** THE PayPal adapter SHALL report a payout item in `SUCCESS` as `settled`; `FAILED`, `RETURNED`, `BLOCKED`, `DENIED`, or `REFUNDED` as a confirmed failure; and any other status, including `PENDING` and `UNCLAIMED`, as unknown, so the reservation stays counted (audit-and-approvals RES-5).
- **PO-17** THE SYSTEM SHALL talk only to the PayPal sandbox API host. IF `PAYPAL_ENV` is anything but `sandbox`, THEN THE SYSTEM SHALL refuse every PayPal call (security-standards §7).
- **PO-25** WHEN a payout's outcome is unknown but the rail returned its own reference (PayPal's `payout_batch_id`), THE SYSTEM SHALL store that reference on the reservation and in the `rail_result` event, and `lookup` SHALL read the payout by it, read-only. Without a stored reference, the outcome stays unknown (rail-adapters RAIL-21).
- **PO-26** IF reading a payout's destination from the vendor row fails after the decision committed, THEN THE SYSTEM SHALL not call the rail, SHALL record a `failed` `rail_result` with `RAIL_REJECTED`, and SHALL release the reservation, because nothing was sent. An approved re-run SHALL end the same way, so its approval is followed by that failed result rather than by no result.

## Requirement 5: Taint and scope cover payouts
**User story:** As a security engineer, I want payouts covered by taint and intent scope like refunds are, so that a new rail doesn't open a new hole.

### Acceptance criteria
- **PO-18** `paypal.payout` SHALL be high-privilege even if a registry entry forgets the flag, like the four tools listed in security-standards §3.
- **PO-19** WHILE a session is tainted, THE SYSTEM SHALL hold `payout.create`, `paypal.payout`, and `payee.update` with `HELD_TAINTED`, on every rail.
- **PO-20** A payout or payee change to a vendor outside the task's categories, or with a tool outside the task's tools, SHALL be denied with `DENY_INTENT_DRIFT`, as for payments (INT-2 to INT-6).

## Requirement 6: Setup and verification
**User story:** As the developer, I want each new rail set up step by step and measured before it's trusted, as x402 and Stripe MPP were.

### Acceptance criteria
- **PO-21** `docs/SETUP.md` SHALL explain how to create the recipient accounts in the Stripe sandbox, fund the platform's test balance, create the PayPal sandbox app and accounts, and check the setup with `pnpm env:check` (PayPal) and `pnpm connect:check` (the recipient accounts).
- **PO-22** Before the adapters are built, a probe script per rail SHALL measure and record in `docs/KIRO_LOG.md`: that the Canadian sandbox can create recipient accounts and USD transfers (Stripe), each rail's minimum amount, whether a repeated idempotency key or `sender_batch_id` pays twice, and how each rail can be looked up by the reservation ID alone.

## Requirement 7: A payee-hijack demo
**User story:** As a judge, I want a scenario where an injected agent tries to redirect a supplier's payouts, so that I can see AgentVault stop the attack payout teams worry about most.

### Acceptance criteria
- **PO-23** THE scenarios page SHALL offer a scripted **Payee hijack** scenario: an agent whose task is paying the supplier `acme-supplies` (a fresh supplier row for each run, so one run's approvals can't change another's) reads the supplier's invoice page, which hides an instruction to change the supplier's payout account and send $900. The agent obeys. `payee.update` SHALL be held with exactly `HELD_TAINTED`, and `payout.create` for $900 SHALL be held with exactly `HELD_TAINTED, NEEDS_APPROVAL`. Neither runs until approved.
- **PO-24** IF a person denies the held `payee.update` and approves the held payout, THEN THE payout SHALL go to the supplier's original destination, not the injected one.
