# Requirements: Public testnet payment

## Introduction
The hosted site runs every rail on the mock adapter, so a visitor never sees AgentVault in front of a real rail; real payments happen only in the `@live` tests. This spec adds one button on the scenarios page that makes a real, sub-cent x402 payment on Base Sepolia through the full guarded flow and shows its transaction on BaseScan. It is the only path on the hosted site that reaches a real rail without signing in, so the visitor controls nothing about the payment, and hard limits keep the test wallet funded until judging ends (Jan 29, 2027).

## Glossary
- **Testnet workspace:** a workspace with `public_testnet = true`. Not a sandbox: it uses real rails when `RAIL_MODE=real`, and the nightly reset doesn't touch it. There is at most one.
- **Demo agent:** the testnet workspace's one agent. Its API key is random and never shown; only the server acts as it.
- **Testnet payment:** one `x402.pay` of $0.0015 to `nimbus-weather`, which settles in Base Sepolia test USDC. No real money.

## Requirement 1: The button
**User story:** As a judge, I want to see AgentVault decide and settle a real payment on a real rail, so that I know the hosted demo isn't only mocks.

### Acceptance criteria
- **TN-1** WHERE `RAIL_MODE=real`, the testnet workspace exists, and the x402 payer variables are valid, THE scenarios page SHALL show a "Real testnet payment" card. Otherwise it SHALL NOT show the card, and the endpoint SHALL answer 404 `TESTNET_OFF`.
- **TN-2** WHEN a visitor presses the card's button, THE SYSTEM SHALL run one `x402.pay` of exactly $0.0015 to `nimbus-weather` through the guarded flow (security-standards §2, all nine steps) as the demo agent, in a new session under the testnet workspace's task, with an idempotency key the server generates. The request body SHALL be an empty object; the visitor chooses nothing about the payment.
- **TN-3** WHEN the payment is allowed, THE SYSTEM SHALL send it to the vendor's registered `x402_url` (rail-adapters RAIL-23), and the response SHALL include the decision, its reasons, the rail status, and, once settled, the transaction hash, its BaseScan link, and the decision's audit event `seq`. The card SHALL show them, with the link opening BaseScan.
- **TN-4** THE card SHALL say that the payment uses Base Sepolia test USDC with no real value, and SHALL state the limits. Copy in both themes.

## Requirement 2: Limits
**User story:** As the owner, I want the button to be cheap and hard to abuse, so that the wallet stays funded and the demo agent never freezes for everyone.

### Acceptance criteria
- **TN-5** THE endpoint SHALL allow each IP 2 testnet payments an hour, and all visitors together 6 a minute and 20 per UTC day. A refused request SHALL answer 429 `RATE_LIMITED` (per IP or per minute) or `TESTNET_QUOTA_USED` (the day), and SHALL create no session, append no audit event, and contact no rail.
- **TN-6** THE demo agent's envelope SHALL allow only `x402.pay` to `nimbus-weather`, at most $0.01 per transaction and $0.05 per day, with a calls-per-minute limit of 30. That is above the endpoint's 6 a minute, so `VELOCITY_EXCEEDED` can't freeze the shared agent. The envelope is a second line behind TN-5, not the main control.
- **TN-7** THE endpoint SHALL be human-only, like the scenario runner: any `Authorization` header is 403 `AGENT_KEY_FORBIDDEN`, a cross-site request is 403 `CROSS_ORIGIN`, and any field in the body is 400.

## Requirement 3: Keeping the sandbox mock
**User story:** As the owner, I want turning on real rails to be unable to break the public sandbox.

### Acceptance criteria
- **TN-8** WHEN a request runs in a sandbox workspace, THE SYSTEM SHALL choose the mock adapter without building any real adapter, so a missing or invalid real-rail variable can't make a sandbox request fail. The safety checks that apply in every mode (no live Stripe key, Base Sepolia only, PayPal sandbox only; rail-adapters RAIL-7, RAIL-8, payout-rails PO-17) SHALL still run.

## Requirement 4: Setup and operations
**User story:** As the owner, I want to create the testnet workspace once and know when the wallet needs funds.

### Acceptance criteria
- **TN-9** `pnpm testnet:setup` SHALL create the testnet workspace, its `nimbus-weather` vendor at `APP_ORIGIN` with `x402_url` set, its task, the demo agent, and its envelope in one transaction, appending a `testnet_workspace_created` audit event. Run again, it SHALL change nothing and print the existing workspace. The database SHALL refuse a second testnet workspace.
- **TN-10** `pnpm ops:check` SHALL report the testnet payments made today and in total, and `docs/OPERATIONS.md` SHALL say how to check and refill the agent wallet's test USDC.
