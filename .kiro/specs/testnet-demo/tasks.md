# Tasks: Public testnet payment

Plan (`docs/PLAN.md`): Phase 19's second half.

- [ ] 1. Update steering for a public path to a real rail
  - product.md, security-standards.md, and tech.md: the testnet workspace is the one public, non-sandbox workspace; the sandbox still always uses mock rails
  - _Requirements: TN-1, TN-8_

- [ ] 2. Build the adapters per workspace
  - `railOptionsFor(workspace, env)` in `src/rails/real.ts`, used by every server entry point, and property 3
  - _Requirements: TN-8_

- [ ] 3. Add the testnet workspace and its setup script
  - Migration 0006, `createTestnetWorkspace`, the `testnet_workspace_created` event type, `pnpm testnet:setup`
  - _Requirements: TN-6, TN-9_

- [ ] 4. Build `POST /api/v1/testnet/pay`
  - The handler and route, the limits, and properties 1 and 2
  - _Requirements: TN-1, TN-2, TN-3, TN-5, TN-6, TN-7_

- [ ] 5. Add the card to `/scenarios`
  - `TestnetPaymentCard`, the page's availability check, copy in both themes
  - _Requirements: TN-1, TN-3, TN-4_

- [ ] 6. Operations and docs
  - `pnpm ops:check` testnet counts; `docs/OPERATIONS.md` (wallet balance and refill), SETUP.md, README, the demo script, and the Devpost story
  - _Requirements: TN-10_

- [ ] 7. Turn it on
  - Migration 0006 on the main database, `pnpm testnet:setup --origin https://owen-agentvault.vercel.app`, `RAIL_MODE=real` on Vercel, a deploy, and one real press on the hosted site
  - _Requirements: TN-1, TN-2, TN-3_
