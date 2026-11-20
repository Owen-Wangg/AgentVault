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
| x402 | The USDC payment is an EIP-3009 authorization. `lookup` reads `authorizationState(payer, nonce)` on the Base Sepolia USDC contract. Used means `settled`: the transaction hash comes from the `AuthorizationUsed(payer, nonce)` log, and the amount from the USDC `Transfer` in that transaction's receipt. Unused in the **finalized** state, with the finalized block's timestamp at or past the deadline, means `failed`: EIP-3009 rejects any block at or after `validBefore`, and every later block is too. Anything else is `unknown`, because the facilitator can still submit it. Confirmed in task 5: the @x402/evm client always picks a random nonce and expiry, so the adapter signs the authorization itself. The nonce is `sha256("agentvault/x402/eip3009-nonce/v1:" + key)`, and `validBefore` is at most the reservation's `created_at` plus 300 seconds, so `lookup` rebuilds both from the reservation row (`RailContext.reservedAt`) and nothing new is stored. |
| Stripe | Lists refunds and PaymentIntents created from 120 seconds before the reservation's `created_at` to 120 seconds after its SPT expires (`created[gte]`, `created[lte]`, up to 10 pages of 100), and matches `metadata.idempotency_key`. List endpoints, unlike search, reflect writes at once. Refunds carry the key because the adapter sets it. Payments carry it because the adapter sends the key as the MPP credential's `externalId` and the demo vendor copies it into the PaymentIntent's metadata through mppx's `paymentIntentOptions` (confirmed in task 8: the MPP flow allows metadata, and a recorded test-mode PaymentIntent has it). A succeeded PaymentIntent, or a succeeded or pending refund, is `settled`. Only a refund Stripe marked `failed` or `canceled` is `failed`. Anything else is `unknown`, including nothing found: the vendor writes the PaymentIntent's metadata, and a vendor that didn't could still have charged the SPT, so absence proves nothing. |

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
| `X402_MIN_UNITS` | x402, mock | facilitator minimum in USDC atomic units; default `1000` ($0.001), measured in task 4 |
| `AGENT_WALLET_PRIVATE_KEY` | x402 payer | **testnet-only** key, funded from a faucet |

## x402 adapter
- **Vendor side** (`app/vendor/api/weather/route.ts` → `src/server/vendor/weather.ts`): the CDP Next.js example's shape, `withX402(handler, { accepts: [{ scheme: "exact", network: "eip155:84532", payTo: X402_PAY_TO, price, maxTimeoutSeconds: 120 }] }, new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme()))`. The price is an `AssetAmount` in USDC atomic units built from micros, so no dollar string is parsed. The facilitator client is built from `@coinbase/cdp-sdk/auth` (`generateJwt`) and `HTTPFacilitatorClient`, which is what `createCdpFacilitatorClient` does: the `@coinbase/cdp-sdk/x402` entry point imports Solana and extension packages this app doesn't install. Without the vendor's variables the route answers 503.
- **Payer side** (`src/rails/x402/adapter.ts`): a `viem` account from `AGENT_WALLET_PRIVATE_KEY` signs the EIP-3009 `TransferWithAuthorization` typed data itself (see `lookup()` above for why), and `@x402/core/http` encodes and decodes the `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` headers. Chain reads go through a read-only JSON-RPC reader (`src/rails/x402/chain.ts`) that checks the chain ID and validates every result with Zod.
- Flow: `quote()` makes an unpaid request and parses the 402 requirements. `execute()` picks the exact-scheme Base Sepolia USDC option with the USDC EIP-712 domain (anything else is `CHALLENGE_MISMATCH`), checks its amount equals `toRailUnits(approvedMicros, "x402", "debit")` (RAIL-13), signs, retries, and reads the transaction hash from `PAYMENT-RESPONSE`.
- Outcomes: before signing, a non-402 answer is `RAIL_REJECTED` and an unreadable challenge is `INVALID_RAIL_RESPONSE`. After the paid request is sent, anything but a well-formed successful settlement for this payer and amount is `INVALID_RAIL_RESPONSE` or `RAIL_TIMEOUT`, so unknown: a facilitator refusal can't be told apart from a submitted transaction whose answer was lost, and `lookup()` resolves both. `refund()` is `RAIL_REJECTED` (x402 has no refunds).
- The 30-second rail timeout can't push an authorization past its deadline: with under 30 seconds left, the adapter signs nothing and returns `RAIL_TIMEOUT`.
- Explorer link: `https://sepolia.basescan.org/tx/<hash>`.
- **Price:** `$0.0015` per call, the same as the mock rail. Measured in task 4 on Base Sepolia: the CDP facilitator settles `$0.0015` and `$0.001` (1000 units) and refuses 999 units and below with `amount_too_low`.
- **Payment URLs (RAIL-23 to RAIL-25, task 9).** The vendor registry has one paid endpoint per rail: `vendors.x402_url` and `vendors.mpp_url`, both nullable. The guarded flow passes the one for the tool's rail (`x402.pay` → `x402_url`, `mpp.pay` → `mpp_url`) as `vendorUrl`. The agent names a vendor, never a URL, so it can't send money to an endpoint the workspace didn't register. A vendor without a URL for the rail gets `vendorUrl: ""`: both real adapters fail to fetch it before signing or creating anything and return `RAIL_REJECTED`, a confirmed failure, so the reservation is released. A check constraint keeps each URL under the vendor's `origin` followed by `/`, so `https://a.example` can't register `https://a.example.evil.test/…`. The sandbox seed registers `nimbus-weather` with `/vendor/api/weather` (x402) and `/vendor/api/report` (MPP) on the app's origin; `gpu-cloud` has none, since its payments are denied as drift. The mock rail ignores the URL. Before task 9, the flow passed the registry `origin`, which reached the site root, got no 402, and failed closed.

## Stripe MPP adapter
- **Vendor side** (`app/vendor/api/report/route.ts` → `src/server/vendor/report.ts`): `Mppx.create({ methods: [stripe.charge({ client, networkId: STRIPE_PROFILE_ID, currency: "usd", decimals: 2, paymentMethodTypes: ["card", "link"] })], secretKey })` from mppx's SPT-only entry points (`mppx/server/core`, `mppx/stripe/server/spt`), then `mppx.charge({ amount: "0.50", paymentIntentOptions })(request)`. A 402 returns `response.challenge`; a success returns the report through `withReceipt()`. Confirmed in task 7: Stripe's guide shows `stripe.create(...).defaultMethods()`, which in mppx 0.19 also offers Tempo stablecoin payments and requires a shared atomic `store`, which serverless instances don't share; this endpoint takes cards only and keeps no state. The challenge-signing secret is `HMAC-SHA256(STRIPE_SECRET_KEY, "mpp-challenge-signing")`, as in Stripe's guide. `paymentIntentOptions` copies a well-formed credential `externalId` into the PaymentIntent's `metadata.idempotency_key`. The amount string comes from micros (`stripeChargeAmount`), so no dollar string is parsed. Without the Stripe variables the route answers 503. mppx is a Next.js server external package, because bundling it fails on lazy imports of optional peers (the MCP SDK, Hono, Express) this app doesn't install.
- **Discovery** (`app/openapi.json/route.ts`): `mppx validate` finds paid endpoints through an OpenAPI document with `x-payment-info`, and resolves each path against the URL it is given. So the document is at the site root, and the validator runs against the origin (`pnpm mpp:validate`, the `/validate-mpp` steering command), not against `/vendor/api/report`.
- **`/llms.txt`** (RAIL-26, `app/llms.txt/route.ts`): the validator suggests one. Static Markdown-style text built in `src/server/vendor/llms.ts` from the same constants as the routes (`REPORT_PATH`, `REPORT_PRICE`), so the price can't drift from the endpoint. It links `/openapi.json` for the machine-readable part and names no secret or account.
- **Payer side** (`src/rails/stripe-mpp/adapter.ts`): Stripe calls go through a small REST client over an injected fetch (`stripe-api.ts`), so every call takes the rail's AbortSignal and tests can replay recordings. Flow:
  1. The unpaid request. Anything but a 402 is `RAIL_REJECTED`; an unreadable challenge is `INVALID_RAIL_RESPONSE`.
  2. Exactly one `stripe`/`charge` offer, in `usd`, to this account's `STRIPE_PROFILE_ID`, accepting `card`, for exactly `toRailUnits(approvedMicros, "stripe", "debit")` cents. Anything else is `CHALLENGE_MISMATCH` (the RAIL-13 rule).
  3. A test SPT from `POST /v1/test_helpers/shared_payment/granted_tokens` with `payment_method=pm_card_visa`, `usage_limits[currency]=usd`, `usage_limits[max_amount]=<cents>`, `usage_limits[expires_at]=<reservedAt + 600 s>`, header `Stripe-Version: 2026-09-30.preview` (confirmed live in task 8), and `Idempotency-Key: agentvault-spt-v1:<rail key>`. Every parameter comes from the key, the amount, and the reservation, so a retry gets the same SPT, and an SPT pays once up to `max_amount` (RAIL-3, confirmed live: the same key's second attempt got the same SPT, and the vendor's PaymentIntent creation refused it). The test helper grants the SPT to the key's own account, so the vendor must be this account. With under 60 seconds left in the window, nothing is created (`RAIL_TIMEOUT`). A failed creation is `RAIL_REJECTED`, because the SPT never left this process.
  4. Present the SPT with `Credential.serialize({ challenge, payload: { spt, externalId: <rail key> } })`. From here on, anything short of a 200 with a `Payment-Receipt` of `status: "success"` and a `pi_` reference is unknown (`INVALID_RAIL_RESPONSE` or `RAIL_TIMEOUT`). That includes the vendor's 402 after a failed verification, which can't be told apart from a charge whose answer was lost.
- **Refunds**: `POST /v1/refunds` with `payment_intent`, `amount` (credits round down, MON-8; under 1 cent is `BELOW_RAIL_MINIMUM`), `metadata[idempotency_key]`, and `Idempotency-Key: agentvault-refund-v1:<rail key>`. A reference that isn't `pi_…` is `RAIL_REJECTED` without a call. A Stripe 4xx other than 409 is `RAIL_REJECTED`; a 409, a 5xx, an unreadable answer, or a network error is unknown. `succeeded` and `pending` refunds are settled (a pending refund stays counted); `failed` and `canceled` are `RAIL_REJECTED`. `pnpm stripe:seed` creates the $500 test PaymentIntent that the prompt-injection scenario's $480 refund targets in real mode; the sandbox scenario uses a mock reference and never touches it.
- Explorer link: the test-mode Dashboard page of the PaymentIntent or Refund.
- Minimum: 50 cents (RAIL-4), Stripe's minimum for SPT card payments.
- The scope-cut fallback (step 3 in `docs/PLAN.md`, the payer on the mock adapter) wasn't needed: the payer side works in test mode.

## Mock adapter
- Deterministic refs: `mock_tx_` + first 16 hex chars of `sha256(idempotencyKey)`.
- Same `minimumUnits` per simulated rail: 50 cents for Stripe, `X402_MIN_UNITS` (default 1000 units, $0.001) for x402.
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
- Contract tests with recorded 402 challenges and responses in `src/rails/__fixtures__/` (`pnpm x402:probe --record`, `pnpm stripe:probe --record`).
- `@live` tests for x402 on Base Sepolia and Stripe test mode, skipped in CI, run with `pnpm test:live`.
- `/validate-mpp` steering command for RAIL-18 (`pnpm mpp:validate`).
- RAIL-26: a route test that `/llms.txt` is `text/plain`, names the endpoints and the paid report's price from `REPORT_PRICE`, and contains nothing shaped like a key (`sk_`, `rk_`, `av_`, `acct_`, `0x` addresses, email addresses).
- RAIL-29: a test that `next.config.ts` sends the no-load policy on `/vendor/api/:path*` as on `/api/:path*`. `withX402`'s browser page (`customPaywallHtml`) is static text with no style, script, or form, so `default-src 'none'` loses nothing; the vendor docs and invoice pages keep their own policy from `STATIC_PAGE_HEADERS`.
- RAIL-27 and RAIL-28: integration tests on Postgres. Refunds: a refund of a payment this workspace never made, or another workspace made, is denied before any rail call; refunds are allowed up to the settled amount, then denied; a confirmed failed refund frees its amount and an unknown one doesn't; a tainted refund is still held, not denied. The vendor limit: the handler runs up to 60 requests, then 429 without running it, and 503 when the count fails.
- Example tests cover the rest: RAIL-1 (every adapter class has the `RailAdapter` type and its four methods), RAIL-2, RAIL-5 to RAIL-12, RAIL-14 to RAIL-17, RAIL-19, RAIL-20, and RAIL-23 to RAIL-25 (the guarded flow's URL choice, the fail-closed case without a URL, and the origin check constraint).
