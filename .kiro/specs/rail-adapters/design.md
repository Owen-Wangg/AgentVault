# Design: Rail Adapters

## Overview
```mermaid
flowchart LR
  S[runGuardedRequest] --> RS[railFor(tool, workspace)]
  RS -->|sandbox or RAIL_MODE=mock| M[MockAdapter]
  RS -->|x402.pay| X[X402Adapter]
  RS -->|mpp.pay, stripe.refund| SM[StripeMppAdapter]
  X -->|402 challenge, pay, retry| VW["/vendor/api/weather<br/>x402 + CDP facilitator"]
  SM -->|SPT| VR["/vendor/api/report<br/>mppx"]
  SM -->|refunds.create| ST[(Stripe test mode)]
  VW --> BS[(Base Sepolia)]
```

## Interface
```ts
// src/rails/types.ts
export interface RailAdapter {
  readonly rail: Rail;
  readonly minimumUnits: bigint;               // in rail units
  quote(req: RailRequest): Promise<RailQuote>; // reads the vendor's 402 challenge
  execute(req: RailRequest, ctx: RailContext): Promise<RailResult>;
  refund(req: RefundRequest, ctx: RailContext): Promise<RailResult>;
  lookup(idempotencyKey: string, ctx: RailContext): Promise<RailLookup>; // RAIL-21, RAIL-22; read-only
}
export interface RailRequest {
  vendorUrl: string;
  approvedMicros: Micros;
  idempotencyKey: string;
}
export type RailResult =
  | { ok: true; ref: string; explorerUrl?: string; vendorBody?: unknown; settledMicros: Micros }
  | { ok: false; code: "BELOW_RAIL_MINIMUM" | "CHALLENGE_MISMATCH" | "RAIL_TIMEOUT" | "RAIL_REJECTED" | "INVALID_RAIL_RESPONSE"; detail?: string };
export type RailLookup =
  | { status: "settled"; ref: string; explorerUrl?: string; settledMicros: Micros }
  | { status: "failed"; code: "RAIL_REJECTED" }
  | { status: "unknown" };
```

`RAIL_TIMEOUT` and `INVALID_RAIL_RESPONSE` are not proof that no money moved. The server classifies them as unknown outcomes and keeps the reservation (audit-and-approvals RES-5). `BELOW_RAIL_MINIMUM` and `CHALLENGE_MISMATCH` are returned before anything is sent, and `RAIL_REJECTED` means the rail refused, so those three are confirmed failures.

### `lookup()` per rail (RAIL-21, RAIL-22)
| Rail | How it finds the outcome |
|---|---|
| Mock | Reads its record for the key, or the result a test set with `setLookupResult(key, result)` |
| x402 | The USDC payment is an EIP-3009 authorization. `lookup` reads `authorizationState(payer, nonce)` on the Base Sepolia USDC contract. Used means `settled` (the transaction hash comes from the `AuthorizationUsed` event). Unused **and** past `validBefore` means `failed`. Unused before `validBefore` means `unknown`, because the facilitator can still submit it. This needs the nonce and `validBefore` for the key: derive the nonce from `sha256(idempotencyKey)` if the x402 client allows a custom nonce, otherwise store both on the reservation before sending. Confirm in Task 12. |
| Stripe | Refunds: list refunds for the PaymentIntent and match the `metadata.idempotency_key` set at creation. Payments: find the PaymentIntent created from the SPT by its `metadata.idempotency_key`, if the MPP flow allows metadata. Confirm in Task 13. If absence can't be proven, return `unknown`. |

`lookup` never re-sends a request. Retrying `execute` with the same key is not used as a lookup, because only Stripe guarantees idempotent replays.

## Config (validated with Zod at startup, RAIL-7, RAIL-8)
| Variable | Used by | Notes |
|---|---|---|
| `RAIL_MODE` | all | `mock` (default) or `real` |
| `STRIPE_SECRET_KEY` | Stripe | must start with `sk_test_` |
| `STRIPE_PROFILE_ID` | Stripe | `profile_…`, the MPP `networkId` |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | x402 vendor | CDP facilitator auth |
| `X402_PAY_TO` | x402 vendor | vendor receiving address on Base Sepolia |
| `X402_NETWORK` | x402 | must be `eip155:84532` |
| `AGENT_WALLET_PRIVATE_KEY` | x402 payer | **testnet-only** key, funded from a faucet |

## x402 adapter
- **Vendor side** (`app/vendor/api/weather/route.ts`): `createX402Server({ environment: "development", payToConfig: { type: "address", evm: X402_PAY_TO }, routes: { "GET /vendor/api/weather": { price, networks: ["eip155:84532"] } } })` with the Next.js adapter from the CDP runnable examples.
- **Payer side**: an x402 client (expected: `@x402/fetch` or the client in `@x402/core` with `@x402/evm` signer, confirmed during Task 12) with a `viem` account from `AGENT_WALLET_PRIVATE_KEY`.
- Flow: `quote()` makes an unpaid request and parses the 402 requirements. `execute()` checks the challenge amount equals `toRailUnits(approvedMicros, "x402", "debit")` (RAIL-13), signs, retries, and reads the settlement transaction hash from the response header.
- Explorer link: `https://sepolia.basescan.org/tx/<hash>`.
- **Price:** start at `$0.01` per call on the real rail. Whether the CDP facilitator settles sub-cent amounts (for example `$0.0015`) on Base Sepolia is unconfirmed; test it in Task 12. The mock rail uses `$0.0015` to show sub-cent accounting either way.

## Stripe MPP adapter
- **Vendor side** (`app/vendor/api/report/route.ts`): `Mppx.create({ methods: stripe.create({ client, networkId: STRIPE_PROFILE_ID, livemode: false }).defaultMethods(), secretKey })`, then `mppx.charge({ amount: "0.50" })(request)`. A 402 returns `response.challenge`.
- **Payer side**: create a test SPT with `POST /v1/test_helpers/shared_payment/granted_tokens` (`payment_method=pm_card_visa`, `usage_limits[currency]=usd`, `usage_limits[max_amount]=<cents>`, `usage_limits[expires_at]=<now+10min>`, header `Stripe-Version: 2026-09-30.preview`). Present it to the challenge with the `mppx` client (confirmed during Task 13).
- **Refunds**: `stripe.refunds.create({ payment_intent, amount }, { idempotencyKey })`. The seed creates a $500 test PaymentIntent that the prompt-injection scenario's $480 refund targets.
- Minimum: 50 cents (RAIL-4).
- Fallback if the payer-side SPT flow can't be completed in time: the vendor side and refunds stay real; the payer side uses the mock adapter. (This is step 3 of the scope-cut order.)

## Mock adapter
- Deterministic refs: `mock_tx_` + first 16 hex chars of `sha256(idempotencyKey)`.
- Same `minimumUnits` per simulated rail.
- `setFailureMode(code | null)` for tests (RAIL-20). `RAIL_TIMEOUT` mode records the payment and then reports a timeout, so tests cover "money moved but the caller doesn't know".
- `setLookupResult(key, result)` for reconciler tests (RAIL-20, RAIL-21).
- Keeps an in-memory map for idempotency inside one process (tests only). Server-level idempotency (PXY-8) is the real guarantee.

## Error handling
- All rail calls use `AbortSignal.timeout(30_000)`.
- Raw rail errors are logged server-side with a correlation ID; the `rail_result` event stores only the typed code.

## Correctness properties
1. **Idempotency** (RAIL-3): for any number of `execute` calls with the same key, the mock adapter records one payment.
2. **Minimum** (RAIL-4): for any amount below the minimum after conversion, `execute` returns `BELOW_RAIL_MINIMUM` and makes no call.
3. **Challenge match** (RAIL-13): for any challenge amount different from the approved amount, `execute` returns `CHALLENGE_MISMATCH`.
4. **Lookup is read-only** (RAIL-21, RAIL-22): for any sequence of `execute` and `lookup` calls on the mock adapter, the number of recorded payments equals the number of distinct keys passed to `execute`, and `lookup` reports `settled` exactly for keys with a recorded payment.

## Testing strategy
- Contract tests with recorded 402 challenges and responses in `src/rails/__fixtures__/`.
- `@live` tests for x402 on Base Sepolia and Stripe test mode, skipped in CI, run with `pnpm test:live`.
- `/validate-mpp` steering command for RAIL-18.
