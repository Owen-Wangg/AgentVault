---
inclusion: always
---

# Technology Stack

## Runtime and language
- **TypeScript** with `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`.
- **Node.js 22+** (required by the CDP x402 SDK).
- **pnpm** as the package manager. Do not commit `package-lock.json` or `yarn.lock`.
- The developer works on **Windows with PowerShell**. When giving commands, give PowerShell versions where they differ from bash.

## Application
| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router) | Route handlers in `app/api/**` are the proxy |
| Hosting | Vercel | Serverless, no shared memory between instances. Vercel Cron runs the reconciler and the nightly sandbox reset. Hobby allows only daily cron jobs, so nothing may depend on a more frequent schedule |
| Database | Neon Postgres | Use `@neondatabase/serverless` in Pool/WebSocket mode when a transaction is needed |
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
| Mock | Internal | Always available; default for tests and the public sandbox |

`RAIL_MODE=mock|real` selects the adapter. The public sandbox always uses `mock`.

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
