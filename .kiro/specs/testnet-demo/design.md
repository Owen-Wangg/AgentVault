# Design: Public testnet payment

## Overview
One new public endpoint, `POST /api/v1/testnet/pay`, acts as a fixed demo agent in a fixed workspace and runs one $0.0015 `x402.pay` through `runGuardedRequest`, exactly as `/api/v1/pay` does for an agent with a key. The workspace isn't a sandbox, so with `RAIL_MODE=real` the payment goes to the real x402 adapter, which signs with the agent wallet and pays the hosted vendor's `/vendor/api/weather`. The CDP facilitator settles it on Base Sepolia, and the transaction hash and BaseScan link come back in the response.

Nothing about the payment comes from the visitor: the body must be `{}`. The visitor only decides when it happens, and the limits decide how often.

## Data
Migration 0006:
- `workspaces.public_testnet boolean NOT NULL DEFAULT false`.
- `CHECK (NOT (is_sandbox AND public_testnet))`: a sandbox is never the testnet workspace, so RAIL-2's sandbox rule and this one can't overlap.
- A unique partial index on `(public_testnet) WHERE public_testnet`, so the database refuses a second testnet workspace (TN-9).

The testnet workspace has no owner, so it isn't anyone's personal workspace, and the dashboard never resolves to it. Its events stay private to the database (telemetry-dashboard TEL-5 is unchanged); the visitor sees the result on the card.

## Setup (TN-9)
`createTestnetWorkspace(db, { appOrigin, key, now })` in `src/server/testnet/workspace.ts`, in one transaction:
- `createWorkspace(tx, { name: "Public testnet demo", isSandbox: false })`, then set `public_testnet`.
- Vendor `nimbus-weather`: `origin = appOrigin`, category `weather`, `x402_url = appOrigin + /vendor/api/weather`. No `mpp_url`, so `mpp.pay` fails closed with `RAIL_REJECTED` (RAIL-24) even if someone found a way to request it.
- Task "Make one real testnet payment": categories `["weather"]`, tools `["x402.pay"]`, budget $0.01 per session.
- The demo agent, `testnet-demo-agent`, with an unusable key hash (as the sandbox seed does), and its envelope (TN-6): `txMaxMicros` $0.01, `windowCapsMicros.day` $0.05, `callsPerMinute` 30, `allowedVendors ["nimbus-weather"]`, `allowedTools ["x402.pay"]`.
- `testnet_workspace_created` audit event (a new event type) with the vendor URL and the limits.

If a testnet workspace exists, it returns that one and creates nothing. `pnpm testnet:setup [--origin <https origin>]` runs it; `--origin` defaults to `APP_ORIGIN` and must be `https`, or `http://localhost` for development. The x402 URL must point at the deployment that serves the endpoint.

## The endpoint (TN-2, TN-3, TN-5, TN-7)
`src/server/testnet/handler.ts`, route `app/api/v1/testnet/pay/route.ts` (`maxDuration = 60`). In order:
1. `withHuman`: any `Authorization` header is 403, a cross-site request is 403, any error is a generic 503 with a correlation ID.
2. Body: `z.strictObject({})`. Anything else is 400 `INVALID_REQUEST`.
3. Available (TN-1): `RAIL_MODE=real`, `loadX402PayerConfig` succeeds, and the testnet workspace exists. Otherwise 404 `TESTNET_OFF`. The check names variables only, never values.
4. Limits (TN-5), each with `hitRateLimit` on fixed windows: `testnet pay` per IP, 2 per hour; `testnet pay minute` for all visitors, 6 per minute; `testnet pay day` for all visitors, 20 per UTC day. The all-visitor buckets use a constant that isn't an IP, as the live-run quota does. A refusal returns before step 5, so it creates nothing.
5. A new session for the demo agent under the workspace's task.
6. `runGuardedRequest` with the demo agent, idempotency key `testnet:<uuid>`, and body `{ vendor: "nimbus-weather", tool: "x402.pay", amountMicros: 1500n, sessionId }`. The guarded flow does everything else: lock, evaluate, audit, reserve, commit, rail call, `rail_result`.
7. Response: `{ decision, reasons, rail_status, rail_ref, explorer_url, event_seq, amount_micros: "1500" }`. An `unknown` outcome stays counted until the reconciler resolves it (security-standards §2); the card says the payment may still settle.

The window caps are evaluated under the envelope lock, so concurrent presses can't both slip past the $0.05 day cap.

## Rail choice per workspace (TN-8)
Today every server entry point builds `railOptions()` before it knows the workspace, and in real mode that builds every real adapter, so a missing real-rail variable throws even for a sandbox request. `railOptionsFor(workspace, env)` in `src/rails/real.ts` replaces those calls:
- Sandbox: `loadRailConfig({ ...env, RAIL_MODE: "mock" })`. The checks that apply in every mode still run (a live Stripe key, a network other than Base Sepolia, or a `PAYPAL_ENV` other than `sandbox` still throws), and no real adapter is built.
- Anything else: `railOptions(env)`, as now.

`railFor` already returns the mock adapter for a sandbox; this only stops the real ones from being built first.

## The card (TN-1, TN-3, TN-4)
`TestnetPaymentCard` on `/scenarios`, shown only when the page's server component finds the testnet available (the same check as step 3). It has the button, the limits, and a note that it's Base Sepolia test USDC. After a press it shows the decision badge and reasons, "Settled on Base Sepolia" with a shortened transaction hash linking to `https://sepolia.basescan.org/tx/<hash>` (`rel="noopener noreferrer"`, new tab), and the audit `seq`. A 429 shows the limit that was hit; any other failure shows the generic error. The link is built from the response's `explorer_url` only if it starts with `https://sepolia.basescan.org/tx/`; anything else shows no link. Copy in both themes.

## Error handling
- No testnet configured: 404 `TESTNET_OFF`, and no card.
- Wallet out of test USDC: the facilitator rejects the payment, the adapter returns `failed` with its code, the reservation is released, and the card shows the failure. `pnpm ops:check` and `pnpm x402:status` show it.
- The facilitator or Base Sepolia slow: `unknown`, reservation kept, reconciler resolves it by its nonce (rail-adapters RAIL-21).

## Correctness properties
1. **Limits hold** (TN-5): for any sequence of presses from any IPs at any times, no IP gets more than 2 payments in an hour, all visitors get at most 6 in a minute and 20 in a UTC day, and every refused press creates no session, no audit event, and no rail call.
2. **Fixed payment** (TN-2, TN-7): for any request body other than `{}`, and any `Authorization` header, nothing is paid; for `{}`, the rail is asked for exactly one $0.0015 payment to the vendor's registered `x402_url`, never anything else.
3. **Sandbox stays mock** (TN-8): for any environment whose every-mode safety checks pass, `railOptionsFor({ isSandbox: true })` builds no real adapter and never throws, whatever the real-rail variables hold; for any environment that fails them, it throws.

## Testing strategy
- Property 1 against the handler on PGlite with a fake x402 adapter and a fake clock (`createTestDb({ driver: "pglite" })`, since it's sequential), 200 runs.
- Property 2 with fast-check bodies and headers, 500 runs, against the same fake adapter, which records every call.
- Property 3 on `railOptionsFor` with generated environments, 1,000 runs; no I/O.
- Examples, named by requirement ID: TN-1 (off without real mode, the payer variables, or the workspace; the page hides the card), TN-3 (the response fields; the card's link only for a BaseScan URL), TN-4 (the card's copy in both themes), TN-6 (the envelope denies a second payment past $0.05 in a day), TN-9 (setup twice creates one workspace; the database refuses a second), TN-10 (`ops:check` counts).
- `@live`: one press against `pnpm dev` with `RAIL_MODE=real` settles on Base Sepolia and `lookup()` finds it.
