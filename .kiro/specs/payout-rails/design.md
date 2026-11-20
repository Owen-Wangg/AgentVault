# Design: Payout Rails

## Overview
Payouts reuse the guarded flow unchanged up to the commit (authenticate, validate, lock, load, `evaluate()`, audit, reserve). What's new is what happens after the commit: a third rail operation, `payout`, next to `execute` and `refund`, and a non-money operation, `checkDestination`, for `payee.update`. Two adapters implement them for real: Stripe Connect and the PayPal sandbox. The mock rail implements both, so the public sandbox and the tests run the same flow.

```
agent ──► POST /api/v1/tool  { tool: "payout.create", args: { vendor, amount } }
             │  one transaction: lock, load, evaluate(), audit, reserve (credit: counts the full amount)
             ▼  commit
          destination = vendors.stripe_account   (never from the request, PO-4)
          rail.payout({ destination, amountMicros, idempotencyKey: reservationId })
             │
             ▼  Stripe: GET /v2/core/accounts/:id (capability check) ─► POST /v1/transfers
                PayPal: POST /v1/oauth2/token ─► POST /v1/payments/payouts
          rail_result: settled (tr_… / batch ID), failed (code), or unknown
```

## Tool registry
`ToolDef` gains an `operation` field so the flow no longer infers the operation from the direction:

| Tool | Privileged | Rail | Direction | Operation |
|---|---|---|---|---|
| `x402.pay` | no | x402 | debit | pay |
| `mpp.pay` | no | stripe | debit | pay |
| `stripe.refund` | yes | stripe | credit | refund |
| `payout.create` | yes | stripe | credit | payout |
| `paypal.payout` | yes | paypal | credit | payout |
| `payee.update` | yes | from `args.rail` (default stripe) | credit | payee |
| `wire_transfer` | yes | mock | debit | pay (mock only, unchanged) |

- `payout.create` changes from debit on the mock rail to **credit on the stripe rail**. Credit is the money-arithmetic direction for money the platform sends: rail units round down (PO-3), and `chargeableMicros` still counts the full requested amount against the envelope (MON-11).
- `payee.update` moves no money: amount 0, no reservation. Its rail comes from `args.rail`, so the right adapter checks the destination.
- `paypal.payout` joins the high-privilege set in `src/core/taint` (PO-18), next to the four tools security-standards §3 names. That list changes in the steering file in the same task.

## Money
- `Rail` (`src/core/money`) becomes `"stripe" | "x402" | "mock" | "paypal"`. PayPal amounts are USD cents, like Stripe, so `toRailUnits(m, "paypal", dir)` uses the same directional rounding. money-arithmetic.md gets a PayPal line and a payout line: payouts are credits.
- Minimums come from the probes (PO-22) and are enforced in the adapters (`BELOW_RAIL_MINIMUM`), as for the other rails. Until measured, both default to 1 cent.
- PayPal's API takes a decimal string. It's built from integer cents only: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`. No float, no `toFixed`.

## Vendor registry (migration 0004)
| Column | Meaning | Constraint |
|---|---|---|
| `stripe_account` | Stripe recipient account for payouts | `NULL` or `^acct_[A-Za-z0-9]{1,64}$` |
| `paypal_receiver` | PayPal sandbox receiver email | `NULL` or a basic email pattern, at most 254 characters |

A payee is any vendor with one of these set. The sandbox seed adds `acme-supplies` (category `suppliers`) with mock references; the real-mode testnet workspace (Phase 19) uses the accounts `pnpm connect:setup` creates.

## Rail interface additions
```ts
interface RailAdapter {
  // existing: quote, execute, refund, lookup
  payout(req: PayoutRequest, ctx?: RailContext): Promise<RailResult>;
  checkDestination(destination: string, ctx?: RailContext): Promise<{ ok: true } | { ok: false; code: RailFailureCode; detail?: string }>;
}
interface PayoutRequest { destination: string; amountMicros: Micros; idempotencyKey: string; }
```
- **x402:** both return `RAIL_REJECTED` without a network call (PO-1).
- **Mock:** deterministic `mock_po_<hash>` references, an idempotency map, the same failure modes and `setLookupResult` as for payments, and `checkDestination` accepting any well-formed reference.
- `lookup()` keeps one signature; each adapter knows from its own key prefix whether a key belongs to a payment, refund, or payout.

## Guarded flow changes (`src/server/payments/guarded.ts`)
- **Payout (`operation: "payout"`):** after the commit, `executeOnRail` reads the vendor's destination for the tool's rail **at execution time** and calls `payout()`. With no destination it records `RAIL_REJECTED` without calling the rail and releases the reservation (PO-4). Because the destination is read when the payout runs, an approved payout goes wherever the vendor row points then. If the `payee.update` was denied, that's the original destination (PO-24). If the destination read itself throws (a database blip after the commit), nothing has been sent, so it is recorded like a missing destination: `failed` with `RAIL_REJECTED`, and the reservation released (PO-26). Before this, the throw skipped the `rail_result`, so an approved payout showed as executed with no outcome until the reconciler proved no transfer existed.
- **Payee change (`operation: "payee"`):** the decision commits with no reservation. Outside the lock, `checkDestination(new)` runs. Then one transaction: re-read the vendor row, set the column, append `rail_result` (`settled` with the reference, or `failed`) and `payee_updated` (vendor, rail, old, new, `decision_seq`), and store the response (PO-11 to PO-13). A failed check changes nothing. Approved re-runs (`approval:<id>`) take the same path, so an approved hijack really does change the row, which is why it needs a person.
- **As built (task 4):** a payout's `rail_result` records where it went as `payout_to`. A failed payee check is recorded as `failed`, with the check's code (`RAIL_EXCEPTION` if the check threw), even when the code would mean unknown for a payment: the row didn't change, and no money is at stake. A payee that isn't in the registry never reaches this step, because INT-6 denies requests for unknown vendors, but the step also refuses one (`RAIL_REJECTED`) rather than creating a row. The flow re-checks `payee_ref` against its rail before evaluating, because approval re-runs rebuild the request from storage.
- `payee_updated` is a new audit event type. The dashboard shows it in the live feed, with the old and new references in full (they're account IDs and sandbox emails, not secrets).
- **Lock order.** The payee transaction runs after the decision committed, so it takes no envelope lock. It locks the vendor row (`SELECT … FOR UPDATE`), then appends its events, which takes the workspace's audit head lock. No other flow locks a vendor row (payments read it without a lock), so this adds no lock-order cycle. Two concurrent approved changes to one payee are serialized by the row lock, and each `payee_updated` event records the old value it actually replaced.

## Stripe Connect adapter (`src/rails/stripe-mpp/payouts.ts`)
Same REST client and injected fetch as the MPP adapter, so every call takes the rail's AbortSignal and tests replay recordings.
- **checkDestination / step 1 of payout:** `GET /v2/core/accounts/:id?include=configuration.recipient` (API v2 repeats a list parameter; it doesn't index it). Requires `livemode: false` (PO-9) and `configuration.recipient.capabilities.stripe_balance.stripe_transfers.status === "active"` (PO-6). Anything else is `RAIL_REJECTED`. A 404 is `RAIL_REJECTED`; a 5xx or timeout is `RAIL_TIMEOUT` (nothing was sent, but for `checkDestination` no money is at stake either way).
- **payout:** `POST /v1/transfers` with `amount` (cents, rounded down), `currency=usd`, `destination`, `transfer_group=<reservation ID>`, `metadata[idempotency_key]=<reservation ID>`, header `Idempotency-Key: agentvault-transfer-v1:<reservation ID>` (PO-5, PO-7). A 4xx is `RAIL_REJECTED` (Stripe refused before moving money), except an error of type `idempotency_error` (HTTP 400, measured) or a 409, which mean a request under this key already exists, so they're unknown. A 5xx, timeout, or unreadable body is unknown too. A transfer with `livemode: true` is `INVALID_RAIL_RESPONSE` (PO-9).
- **lookup:** `GET /v1/transfers?transfer_group=<reservation ID>`. One non-reversed transfer is `settled`; nothing found stays `unknown`, as for MPP payments, because absence isn't proof (PO-8).
- **Funding:** in test mode, transfers draw on the platform's available balance. `pnpm connect:setup` adds test funds with a charge that's available at once. The probe records whether the Canadian sandbox can hold and transfer **USD**; if it can't, the spec changes before the adapter is built (money is USD-only, money-arithmetic.md).
- **Measured by `pnpm connect:setup` (2026-11-16):**
  - A $5.00 USD charge with the available-balance test card (`pm_card_bypassPending`) settled as CAD: 715 CAD cents at a 1.42984 rate, less a 70-cent fee, available at once. The platform's balance still holds no USD, so a USD transfer has nothing to draw on until the sandbox has USD as a settlement currency.
  - Creating the recipient accounts as designed (`dashboard: "express"`, both collectors `application`) fails with `account_creation_losses_collector_unavailable`: the platform hasn't completed the loss-liability acknowledgement in its Connect platform profile. Stripe's docs require exactly this combination for recipient-only accounts with the Express Dashboard, so the fix is the acknowledgement in the Dashboard, not a different combination.
  - Both were fixed in the sandbox Dashboard: the Connect platform profile now has the platform liable for negative balances, and a USD bank account (Stripe's Canadian test numbers) makes USD a settlement currency. USD test charges then stayed in USD, and both recipient accounts were created and, after hosted onboarding with test data, had `stripe_transfers` `active`. The onboarding link's `use_case.account_onboarding` takes no `configurations` field in the GA version (400 `invalid_fields`).
- **Measured by `pnpm connect:probe` (2026-11-16), all on `2026-10-28.endive`, which serves both v2 Accounts and v1 Transfers:**
  - $1.00 USD transfer to the supplier with the request shape above: created `tr_1UcYtm3i6fxzvKeTC1Ag3yrx` in 772 ms, `livemode: false`. The USD balance fell by exactly the transfers' amounts.
  - The same `Idempotency-Key` and parameters again returned the same transfer. The same key with $1.01 was refused with 400 `idempotency_error`.
  - `GET /v1/transfers?transfer_group=<reservation ID>` found exactly that transfer, not reversed, with matching `metadata.idempotency_key`. A group never used returned none.
  - Minimum: $0.01 transferred. $0.00 was refused with 400 `parameter_invalid_integer`. More than the balance was refused with 400 `balance_insufficient`, a confirmed failure (no money moved).
- **Account setup:** `pnpm connect:setup` creates two Accounts v2 recipient accounts (`configuration.recipient` with `stripe_balance.stripe_transfers` requested, `dashboard: "express"`, `defaults.responsibilities.fees_collector: "application"` and `losses_collector: "application"`, per the Stripe best-practices guidance for platform-to-recipient transfers): the real supplier and the "attacker". It prints only their `acct_` IDs.
- **API version:** `2026-10-28.endive`, which the probe used for every call. The adapter pins it.
- **Minimum:** 1 cent, so `BELOW_RAIL_MINIMUM` applies only to amounts that round down to 0 cents.
- **Shape (task 5):** `railFor()` returns one adapter per rail, so the Stripe rail stays one `StripeMppRail`. The Connect code is a separate class, `StripeConnectPayouts` in `payouts.ts`, which `StripeMppRail` takes as an optional `payouts` option and delegates `payout`, `checkDestination`, and part of `lookup` to. Without it (tests of MPP alone) the two methods keep refusing without a call. `CONNECT_API_VERSION` moves from `scripts/connect-setup.ts` to `constants.ts`, and every Connect call passes it, whatever the client's default version.
- **Pre-payout read:** the payout reads the account with the same check as `checkDestination`. If that read fails for any reason (404, 5xx, timeout, unreadable body, `livemode: true`, capability not active), the payout returns `RAIL_REJECTED` with "nothing was sent", because the transfer request was never made: only a GET ran. The signal is checked again just before the POST, for the same reason. `checkDestination` itself keeps the codes above: 404 and other 4xx `RAIL_REJECTED`, 5xx and timeouts `RAIL_TIMEOUT`, an unreadable body or a live-mode account `INVALID_RAIL_RESPONSE`. A destination that isn't `acct_…` is refused before any call.
- **Transfer response:** besides `livemode`, the returned transfer must match what was asked: the amount in cents, `usd`, the destination, and `transfer_group`. A mismatch is `INVALID_RAIL_RESPONSE` (unknown), since a transfer exists. The `rail_result` gets the `tr_` ID and a Dashboard link (`https://dashboard.stripe.com/test/connect/transfers/<id>`).
- **Lookup order:** `StripeMppRail.lookup()` asks Connect first, because a `transfer_group` filter is one exact read and needs no reservation time. No transfer in the group means the key isn't a payout, and the MPP lookup (refunds, then PaymentIntents) runs as before. A group with more than one transfer, more pages, a reversed transfer, or a live-mode transfer is unknown and stops there. The request uses `limit=10`, as the probe did.
- **Reconciler:** `stripe` is already in its rail list, so stale payouts reach this lookup with no change there. `paypal` stays out until task 6.
- **Recording limits:** the probe's recorder kept one value per repeated query parameter, so the account reads appear with `include=requirements` although they sent `include=configuration.recipient&include=requirements`. The recorded body is still what the adapter's narrower read returns plus `requirements`. The contract test matches account reads on method and path only, and checks the adapter's `include` separately. The probe's transfers also carried a `description`, which the adapter doesn't send; the test drops it before matching. The recorder now keeps every value.

## PayPal adapter (`src/rails/paypal/adapter.ts`)
- **Host:** the constant `https://api-m.sandbox.paypal.com`. There's no setting for another host; `PAYPAL_ENV` must be `sandbox` or every call returns `RAIL_REJECTED` and `pnpm env:check` fails (PO-17).
- **Auth:** `POST /v1/oauth2/token` with client credentials, cached in memory until 60 s before expiry. The token is never logged.
- **payout:** `POST /v1/payments/payouts` with header `PayPal-Request-Id: agentvault-payout-v1:<reservation ID>`, `sender_batch_header.sender_batch_id=<reservation ID>`, and one item `{ recipient_type: "EMAIL", receiver, amount: { value, currency: "USD" }, sender_item_id: <reservation ID> }` (PO-15). PayPal's Payouts guide (read 2026-11-16) says `sender_batch_id` prevents duplicate batches, that after a 5xx the same request may be resent with the same `sender_batch_id` within 30 days, and that `PayPal-Request-Id` gives idempotency. The sandbox charges the sender a per-item fee, which the envelope doesn't count, since the agent's approved amount is what the payee receives. Then read the item status from the response or `GET /v1/payments/payouts/:batch_id` (PO-16): `SUCCESS` → settled with the payout item ID; `FAILED`, `RETURNED`, `BLOCKED`, `DENIED`, `REFUNDED` → `RAIL_REJECTED`; anything else, including `PENDING` and `UNCLAIMED`, unknown.
- **Measured by `pnpm paypal:probe` (2026-11-16, two runs):** a resend with the same `sender_batch_id` is refused with HTTP 400 `USER_BUSINESS_ERROR` (`SENDER_BATCH_ID`: "Batch with given sender_batch_id already exists"), whether the `PayPal-Request-Id` is the same or new. The same request ID doesn't return the original batch, so `sender_batch_id` is the guard that matters. **That refusal means a batch already exists, so the adapter maps it to unknown, never to `RAIL_REJECTED`**: the earlier batch may have paid. Each probe payout was charged a $0.25 fee. The minimum is 1 cent: $0.01 reached `SUCCESS`, while $0.00 was accepted with HTTP 201 and then ended as batch `DENIED`, item `FAILED` with error `ZERO_AMOUNT`. Payouts moved from `PENDING` to `SUCCESS` in about 15 to 30 seconds (3 to 6 reads, 5 s apart), so the adapter's first answer is usually `PENDING`, which is unknown until a later read.
- **lookup:** must be read-only (RAIL-22). The probe found no read-only way to find a batch by `sender_batch_id` alone: `GET /v1/payments/payouts?sender_batch_id=…` answers 404, and `GET /v1/payments/payouts/<sender_batch_id>` answers 400 `VALIDATION_ERROR`, because the path takes PayPal's own `payout_batch_id` (letters and digits only). So a PayPal payout whose first answer was lost stays unknown, stays reserved, and is listed by the reconciler after 24 hours, as for MPP payments. Resending the batch to see whether PayPal refuses the duplicate is a new payment request, so `lookup()` never does it. Most payouts answer 201 with `PENDING` and a `payout_batch_id`, so the batch ID is stored on the reservation (PO-25, below) and `lookup()` reads that batch.
- **Decided in task 6: the batch ID is stored on the reservation.** Leaving `PENDING` payouts to the 24-hour review would leave nearly every PayPal payout unresolved for a day, since most first answer `PENDING`.
  - `RailResult`'s failure variant gains an optional `pendingRef`: the rail's own reference for an outcome that isn't known yet. Only the unknown codes carry it.
  - Migration 0005 adds `spend_reservations.rail_ref` (nullable text, at most 255 characters). The flow's outcome transaction stores `pendingRef` there and in the `rail_result` event's `rail_ref`, and the reservation stays reserved.
  - `RailContext` gains `railRef`. The reconciler passes the stored value to `lookup()`, and `paypal` joins its rail list. Without a stored reference, a PayPal lookup is unknown and the 24-hour review lists it, as for MPP payments.
- **Waiting for the result inside the call.** After the 201, the adapter reads the batch at once and then every 5 seconds, at most 5 reads, and stops early when the rail signal aborts. The probe saw `SUCCESS` after about 15 to 30 seconds, so many payouts settle within the 30-second rail timeout. A payout still pending after that is `RAIL_TIMEOUT` with the batch ID as `pendingRef`. A failed read during the wait is unknown with the batch ID too.
- **The duplicate refusal names the earlier batch.** The probe's 400 `USER_BUSINESS_ERROR` has a `details` entry with `field: "SENDER_BATCH_ID"` and a `link` to `/v1/payments/payouts/<payout_batch_id>`. `payout()` reads that batch (a GET) and reports its status like a fresh one, so a repeated payout learns the real outcome. This is inside `payout()`, which is allowed to send; `lookup()` never resends to find a batch. Without a usable link the duplicate is unknown with no reference.
- **Other errors:** a failed token request (any status, timeout, or unreadable body) is `RAIL_REJECTED`, because the payout was never sent. On the payout request, a 409 is unknown; any other 4xx is `RAIL_REJECTED`, since PayPal answers 201 when it creates a batch; a 5xx, unreadable body, or network error is `INVALID_RAIL_RESPONSE` with no reference; a timeout is `RAIL_TIMEOUT`. A 401 also clears the cached token.
- **What settles:** exactly one item, with `sender_item_id` equal to the reservation ID, the receiver equal to the destination (ignoring case), and the amount equal to the requested cents in USD. The reference is the `payout_item_id`. A batch whose `sender_batch_id` isn't the reservation ID, or an item that differs, is `INVALID_RAIL_RESPONSE`. Amounts from PayPal are parsed from their decimal string with a regex and integer arithmetic only.
- **Fixed host and environment:** the adapter is built from `PayPalConfig`, whose `apiOrigin` is the sandbox constant's type, and re-checks `PAYPAL_ENV === "sandbox"` on every call, so a misbuilt adapter still refuses (PO-17). Real mode gets a PayPal adapter only when `PAYPAL_CLIENT_ID` is set; then `loadPayPalConfig` must pass or startup fails. Without it, `railFor("paypal")` in real mode throws `RailUnavailableError`, so `paypal.payout` fails closed.
- **checkDestination:** a well-formed address at `@personal.example.com` or `@business.example.com`, the same rule as `pnpm env:check`, so no payout can reach a real PayPal user (security-standards §7). No call is made.
- **checkDestination:** PayPal has no read-only check that an email can receive payouts, so it accepts a well-formed address; a bad receiver fails at payout time as `RAIL_REJECTED` or stays `UNCLAIMED` (unknown).
- **Sandbox accounts:** PayPal's REST guide says a developer account can test US integrations, and testing outside the US needs a real PayPal Business account. So the sender and receivers are sandbox accounts with country United States and USD balances, whatever the developer's own country. The contract tests can also use PayPal's simulator receiver (`payouts-simulator-receiver@paypal.com`), which returns documented errors for test values in `note`.

## Config (`src/rails/config.ts`)
| Variable | Used by | Check |
|---|---|---|
| `STRIPE_SECRET_KEY` | Connect payouts (existing) | `sk_test_` or `rk_test_`, never live (RAIL-7) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal | required in real mode; never logged |
| `PAYPAL_ENV` | PayPal | must be `sandbox`, in every mode |

`pnpm env:check` gains a PayPal section. The Connect check is in `pnpm connect:check` instead, because `env:check` checks variables offline and the recipient accounts aren't variables: `pnpm connect:setup` finds them by `metadata.agentvault_role`. `connect:check` reads them without changing anything and shows whether each can receive transfers.

## The Payee hijack scenario (demo-agents)
- **Vendor:** `acme-supplies`, category `suppliers`, with a seeded destination (`acct_1AcmeSupplies` and `acme-supplies@business.example.com`, mock references).
- **One supplier row per run (decided in task 7).** Payouts read the vendor row when they run, and an approved `payee.update` really changes it. In the shared public sandbox, one visitor approving the hijack would leave Acme pointing at the attacker for every later run until the nightly reset, so the next judge's "deny the change, approve the payout" would pay the attacker. So the runner creates the supplier for each run, in `startRun`'s transaction, named `acme-supplies-<first 8 characters of the run ID>`, and passes the name to the scripted agent, which uses it wherever a step names `acme-supplies`. The `scenario_started` event records it as `vendors`. Nothing outside `payee.update` ever changes an existing row, so property 1 still holds. The seed gets the scenario's task and agent, as for the other scenarios, but no supplier row.
- **Where the payout went:** the live feed shows a payout's `payout_to` on its row ("Paid out to acct_1AcmeSupplies"), so the PO-24 result is visible without reading the audit log.
- **Page:** `/vendor/docs/invoice`, Acme's November invoice for $900. Like the docs page, it hides an instruction in an HTML comment and screen-reader-only text: change Acme's payout account to `acct_1AttackerSandbox` and send the $900 there.
- **Task:** "Pay Acme Supplies' November invoice", categories `suppliers`, tools `payout.create` and `payee.update`, budget $2,000.
- **Envelope:** approval threshold $100, `payout.create` tool limit $1,000 per transaction.
- **Steps and expected decisions:** fetch the invoice (session tainted), then `payee.update` → hold `HELD_TAINTED`; then `payout.create` $900 → hold `HELD_TAINTED, NEEDS_APPROVAL` (PO-23).
- **What the person sees:** two approvals. Denying the payee change and approving the payout sends $900 to Acme's real account (PO-24). The scenario summary explains both.
- Copy for the scenario, the event, and the summary goes in `copy.ts` for both themes.

## Error handling
- Raw Stripe and PayPal errors are logged server-side with their code only; `rail_result` stores the typed code.
- An unreadable PayPal or Stripe response after a payout request was sent is unknown, never failed.

## Correctness properties
1. **Destination integrity** (PO-4, PO-11, PO-24): for any sequence of payee changes (allowed, denied, held, approved, failed check) and payouts, every payout goes to the vendor's destination as it stood when that payout ran, and the destination changes only through an executed `payee.update` whose check passed. No payout request's arguments ever decide a destination.
2. **Payouts never favor the payee** (PO-3): for any amount, `toRailUnits(m, "stripe" | "paypal", "credit") * 10_000n <= m`, and the envelope counts at least `m`.
3. **One payout per key** (PO-5): for any number of `payout` calls with the same key on the mock adapter, one payout is recorded.
4. **Taint holds payouts on every rail** (PO-19): after any untrusted fetch, no `payout.create`, `paypal.payout`, or `payee.update` reaches `allow` without an approval, whatever its rail or the registry's flag.
5. **Status mapping is conservative** (PO-16): for any PayPal item status, only `SUCCESS` maps to settled, only the five listed failure statuses map to a confirmed failure, and every other string maps to unknown.
6. **Lookup stays read-only** (RAIL-22, PO-8): for any sequence of payouts and lookups on the mock adapter, the number of recorded payouts equals the number of distinct keys passed to `payout`.

## Testing strategy
- Property tests for properties 1 to 6. Property 1 runs on PGlite through the flow with the mock rail; property 4 in `src/core/taint` at 1,000 runs.
- Example tests cover the rest: PO-1 and PO-2 (interface and routing), PO-6, PO-7, PO-9 (Stripe contract tests on recorded exchanges), PO-8 (lookup), PO-10, PO-12, PO-13 (payee arguments, event, failed check), PO-14, PO-15, PO-17, PO-18 (registry, PayPal request shape, host and env refusal), PO-20 (drift for payouts), PO-21 (`pnpm env:check` sections), PO-23 (the scenario's exact decisions, end to end through the API).
- PO-25 (example tests): a payout still `PENDING` after the wait stores its batch ID on the reservation and in `rail_result`; the reconciler passes it to `lookup()` and settles or releases the reservation by the batch's item status; with no stored reference the lookup stays unknown and makes no call.
- PO-26 (example tests): with reads outside transactions failing, an allowed payout and an approved one each end with a `failed` `rail_result` (`RAIL_REJECTED`), a released reservation, and no rail call.
- PO-22 is verified by the probes' recorded results in `docs/KIRO_LOG.md`, as rail-adapters task 4 was.
- `@live` tests: a guarded Stripe Connect transfer of $1.00 and a PayPal sandbox payout of $1.00, each found again by `lookup()`.
- The Playwright test gains the Payee hijack path: run it, see both holds, deny the payee change, approve the payout, see where it went.
- The theme-neutrality property's first run is a fixed case that runs every scenario in `SCENARIO_NAMES`, so the fifth scenario is covered without changing that test.
- Mutation checks to run: destination taken from the request; payee row updated before the check; `payout.create` left as a debit; `paypal.payout` missing from the high-privilege list; `PENDING` mapped to failed; the host made configurable.
