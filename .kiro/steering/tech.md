---
inclusion: always
---

# Technology Stack

## Runtime and language
- **TypeScript** with `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`.
- **Node.js 22+** (required by the CDP x402 SDK).
- **pnpm** (12.x) as the package manager. Do not commit `package-lock.json` or `yarn.lock`. pnpm runs no install scripts unless they're approved in `pnpm-workspace.yaml` (`allowBuilds`). Approve only packages that need one, by name.
- **TypeScript 6.0**, pinned with `~6.0`. TypeScript 7 (the native compiler) is out, but `typescript-eslint`, which `eslint-config-next` depends on, supports only TypeScript below 6.1. Revisit when it adds TypeScript 7 support.
- The developer works on **Windows with PowerShell**. When giving commands, give PowerShell versions where they differ from bash.

## Application
| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router) | Route handlers in `app/api/**` are the proxy |
| Hosting | Vercel | Serverless, no shared memory between instances. Vercel Cron runs the reconciler and the nightly sandbox reset. Hobby allows only daily cron jobs, so nothing may depend on a more frequent schedule |
| Database | Neon Postgres | Use `@neondatabase/serverless` in Pool/WebSocket mode when a transaction is needed. The database is in AWS **us-west-2** (Oregon), so the Vercel function region must be **`pdx1`** (Portland), not the default `iad1`. Each pay request makes several round trips inside a locked transaction |
| ORM | Drizzle ORM + drizzle-kit | Postgres `bigint` columns map to JS `bigint` (`mode: "bigint"`) |
| Validation | Zod | At every trust boundary |
| Auth | Auth.js (NextAuth v5) with GitHub provider | Agents use hashed bearer API keys instead |
| UI | Tailwind CSS + shadcn/ui | Open source, free |
| Charts | Recharts | |
| Icons | lucide-react | ISC license |
| Live updates | Server-sent events (SSE) polling `audit_events` by cursor | No in-memory event bus |

## Payment rails
| Rail | Packages | Mode |
|---|---|---|
| Stripe MPP (card SPTs) | `mppx`, `stripe` | Stripe **test mode** only (`sk_test_`) |
| x402 | `@coinbase/cdp-sdk`, `@x402/core`, `@x402/evm`, Next.js adapter | **Base Sepolia** (`eip155:84532`), `environment: "development"` |
| Stripe Connect payouts | `stripe` REST client (no new package): Accounts v2 recipient accounts, v1 Transfers | Stripe **test mode** only; any object with `livemode: true` is an invalid response |
| PayPal payouts | None: REST over `fetch` (OAuth client credentials, Payouts API) | **Sandbox** only: the host is the constant `https://api-m.sandbox.paypal.com` and `PAYPAL_ENV` must be `sandbox` |
| Mock | Internal | Always available; default for tests and the public sandbox |

Why the payout rails (`.kiro/specs/payout-rails`): `payout.create` and `payee.update` send money out or change where it goes, so they're the tools a prompt injection most wants. Stripe Connect gives them a real test-mode rail on the Stripe account the project already has. PayPal adds a second, unrelated provider for `paypal.payout`, to show the same rules hold on a rail AgentVault didn't start with. PayPal's REST API is small enough that an SDK would add a dependency for no gain.

`RAIL_MODE=mock|real` selects the adapter. The public sandbox always uses `mock`, and its requests build no real adapter, so a missing real-rail variable can't break it. The hosted site runs `RAIL_MODE=real` for the public testnet workspace (`.kiro/specs/testnet-demo`), with the x402 and Stripe variables on Vercel. Real mode applies to every non-sandbox workspace, but personal workspaces have no vendors, so a payment there is denied before any rail. The agent wallet key there is testnet-only, holds a few dollars of test USDC, and is never logged or sent to the browser.

## Agents
- Scripted agent (deterministic, no external calls).
- Optional Gemini agent through `@google/genai`, enabled only when `GEMINI_API_KEY` is set.
- MCP server through the official `@modelcontextprotocol/sdk`.

## Testing
- **Vitest** for unit and integration tests.
- **fast-check** for property-based tests (see `testing-standards.md`).
- **Playwright** for one end-to-end dashboard test.

## Off-limits
- Any floating-point money library or `number`-typed money. Use `bigint` micros (see `security-standards.md`).
- `decimal.js`, `big.js`, `dinero.js`: unnecessary; integer micros cover our needs.
- Mainnet networks, live Stripe keys (`sk_live_`), or real funds.
- In-memory state for limits or events (it breaks across Vercel instances).
- Paid UI kits, fonts, or icon packs. Anything not open-licensed.
- Adding a dependency without saying why in the commit or task notes.
