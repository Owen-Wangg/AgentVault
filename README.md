# AgentVault

AgentVault is a security proxy between AI agents and payment rails (Stripe MPP and x402). Every payment and high-privilege tool call is checked against spend limits, untrusted-input (taint) rules, and the task's declared scope before any money moves.

**Live sandbox:** <https://owen-agentvault.vercel.app> (no login and no real money: mock rails, plus one real Base Sepolia testnet payment)

![The live feed after a Payee hijack run: the injected payout account change (payee.update) and the $900 payout are both held because the session read an untrusted invoice; after a person denied the change and approved the payout, it was paid out to the supplier's account on file](docs/images/payee-hijack-feed.png)

## Why

Agents can now pay for APIs on their own: they answer an HTTP `402 Payment Required` challenge and pay per call, sometimes a fraction of a cent. Payment controls built for people assume someone approves each purchase. An agent that is prompt-injected by a scraped page, or stuck in a retry loop, can drain a budget one small charge at a time.

## Try it in 60 seconds

1. Open [Scenarios](https://owen-agentvault.vercel.app/scenarios) and click **Run** on **Prompt injection**. The scripted agent reads a vendor docs page with a hidden instruction to refund $480. The read taints the session, and the refund is held with `HELD_TAINTED` and `NEEDS_APPROVAL`.
2. Follow the summary's link to [Approvals](https://owen-agentvault.vercel.app/approvals) and click **Approve**. AgentVault re-runs every check with the approval attached, and the refund runs once on the mock rail ("Approved. The request ran.").
3. Open [Audit](https://owen-agentvault.vercel.app/audit) and click **Verify chain**. Every decision, taint, and approval is in a hash-chained log, and the check reports "Chain verified." Then click **Rewrite an event**: your browser rewrites the newest held decision (here, the $480 refund) as allowed in a copy of the page, rechecks it with the same chain code, and shows the chain breaking at that event. The stored log never changes.

4. On Scenarios, click **Make a real testnet payment**. That's the one thing on the site that isn't a mock: AgentVault's demo agent pays the weather vendor $0.0015 over x402 on Base Sepolia, through the same checks, and the card links the transaction on BaseScan. It's test USDC with no real value, limited to 2 payments per visitor an hour and 20 a day for everyone.

Each run also shows its latest decision as a path through the checks (agent, spend limits, task scope, untrusted input) to the payment rail, so you can see which check stopped it. The other scenarios on the same page are below. Their vendors are demo APIs built into AgentVault (under `app/vendor/`), such as Nimbus Weather, which sells forecasts for $0.0015 a call. Weather is only a stand-in: the same checks apply to any API an agent pays for.

| Scenario | What the agent does | Decision |
|---|---|---|
| Normal purchase | Buys five weather forecasts at $0.0015 each | 5 × `allow` |
| Runaway loop | A retry bug pays in a tight loop | 30 allowed, then `deny` with `VELOCITY_EXCEEDED`, and the agent is frozen (`AGENT_FROZEN`) |
| Prompt injection | Reads the poisoned docs page, then asks for the $480 refund | `hold` with `HELD_TAINTED`, `NEEDS_APPROVAL` |
| Intent drift | Its task is weather data, but it pays a GPU vendor | `allow`, then `deny` with `DENY_INTENT_DRIFT` |
| Payee hijack | Its task is paying a supplier's $900 invoice. The invoice hides an instruction to switch the supplier's payout account to an attacker's first, and the agent obeys | `payee.update` → `hold` with `HELD_TAINTED`; the $900 `payout.create` → `hold` with `HELD_TAINTED`, `NEEDS_APPROVAL` |

In the Payee hijack, deny the account change and approve the payout: the payout reads the supplier's account on file when it runs, and the live feed shows "Paid out to acct_1AcmeSupplies". Approve both, and it would go to the attacker. Each run gets its own supplier row, so one visitor's approvals can't redirect another visitor's payout.

Normal purchase, Prompt injection, and Intent drift also have a **Run with live AI agent** button, which runs Gemini (free tier, rate-limited) in place of the script. The model chooses its own requests and AgentVault's rules still decide each one. A real model may not follow the injected instruction, and then there is nothing to hold; the scripted run always shows the hold.

The sandbox is shared, runs on mock rails only, and starts fresh every night, some time in the 11:00 UTC hour.

## What it checks

- **Spend envelopes:** per-agent limits per transaction, per minute, hour, and day, calls per minute, an approval threshold, and vendor and tool allow-lists, with optional per-vendor and per-tool limits.
- **Taint tracking:** agents read the web through `/api/v1/fetch`, which labels each page trusted or untrusted by origin. Reading untrusted content taints the session for good, and `stripe.refund`, `wire_transfer`, `payout.create`, `paypal.payout`, and `payee.update` then need a person's approval.
- **Intent scope:** each task declares its vendor categories, tools, and budget. Anything outside them is denied (`DENY_INTENT_DRIFT`, `OVER_TASK_BUDGET`).
- **Approvals:** held requests wait in an inbox for 15 minutes. Approving re-runs the whole check, and an approval runs at most once.
- **Audit log:** append-only (Postgres triggers reject `UPDATE`, `DELETE`, and `TRUNCATE`), hash-chained per workspace, with an HMAC-signed chain head so a deleted tail is detected.
- **Advisory drift score:** the live Gemini agent can send a drift score. A high score adds an `ADVISORY_DRIFT` hold; no score can remove a hold or a deny.

Deny beats hold, and hold beats allow. If AgentVault can't evaluate or audit a request, the request doesn't run.

## How a payment is decided

```
agent ──► /api/v1/pay, /tool, /fetch  (bearer API key, Zod-validated)
             │
             ▼  one Postgres transaction
          lock the agent's envelope row ─► claim the Idempotency-Key
          load window spend, velocity, session taint, task scope
          evaluate()  (pure function in src/core)  ─► allow | hold | deny
          append the decision to the audit log
          reserve the amount (allow only) ─► commit
             │
             ▼  after the commit, no lock held
          rail: mock | x402 (Base Sepolia) | Stripe MPP (test mode)
                | Stripe Connect payouts (test mode) | PayPal payouts (sandbox)
          append the result: settled, failed, or unknown
```

- **Payouts** (`payout.create` on Stripe Connect, `paypal.payout` on PayPal) send money to the vendor's payout destination stored in AgentVault, read when the payout runs, never one from the agent's request. Only `payee.update` can change it, and that change is checked against the rail (an open, test-mode Stripe recipient account, or a PayPal sandbox address) before it's stored. Payouts are credits: the payee's amount rounds down to the cent, and the envelope counts the full amount.

- Money is `bigint` micros everywhere (1 USD = 1,000,000), so sub-cent charges are exact. Floats never touch an amount.
- An unknown rail outcome keeps the reservation counted until the reconciler (run after requests and by a daily cron) looks it up. Only a confirmed failure releases money.
- `src/core` (policy, money, taint, intent, audit math) has no I/O, so it is covered by fast-check property tests.

Stack: Next.js (App Router) on Vercel, Neon Postgres with Drizzle, Zod, Auth.js (GitHub), Tailwind, Recharts, the official MCP SDK, and `@google/genai`.

## MCP server

Any MCP client (Kiro, Claude Desktop) can route payments through AgentVault with three tools: `agentvault_pay`, `agentvault_fetch`, and `agentvault_request_tool`. It runs over stdio (`pnpm --silent mcp`) or Streamable HTTP at `/api/mcp`. There are no approve or unfreeze tools; a person does those in the dashboard. Setup is in [docs/MCP.md](docs/MCP.md).

## Run it locally

Windows PowerShell, Node 22+, pnpm 12:

```powershell
pnpm install
Copy-Item .env.example .env.local   # then set DATABASE_URL, AUDIT_HEAD_KEY, and CRON_SECRET
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Use `pnpm dev` for local scenario runs: under `pnpm start`, the injection scenario's fetch of `localhost` is refused by the SSRF rules. GitHub sign-in, x402, Stripe, and Gemini are optional; [docs/SETUP.md](docs/SETUP.md) covers each one.

Checks:

| Command | What it runs |
|---|---|
| `pnpm verify` | Typecheck, lint, and about 1,580 Vitest unit, property, and integration tests. Integration tests use PGlite unless `DATABASE_URL_TEST` is set |
| `pnpm check:money` | Flags float operations on money |
| `pnpm test:e2e` | Playwright: the prompt-injection and payee-hijack paths, a first visit (the tour, the header theme switch, the decision path, and the tamper demo), plus layout at 375 and 1920 px and keyboard navigation in both themes |
| `pnpm test:live` | `@live` tests against Base Sepolia, Stripe test mode (MPP and Connect), the PayPal sandbox, and Gemini (needs their keys) |

## Limits

- **Testnets, test mode, and sandboxes only.** Rail settings are checked on every payment: an `sk_live_` Stripe key, an x402 network other than Base Sepolia (`eip155:84532`), or a `PAYPAL_ENV` set to anything but `sandbox` fails the check and nothing is paid, even in mock mode. The PayPal host is a fixed sandbox URL, and any Stripe object returned with `livemode: true` is treated as an invalid response.
- **The live sandbox uses mock rails; the testnet button is real.** The scenarios, approvals, and MCP agents run on mock rails. The **Real testnet payment** button runs in a separate public testnet workspace with `RAIL_MODE=real`: the visitor chooses nothing about the payment, which is always one $0.0015 x402 payment on Base Sepolia, and limits are checked before anything is created. An allowed payment goes to the vendor's registered payment URL, never one the agent sends. In the `@live` tests, a $0.0015 x402 payment through the full guarded flow settles on Base Sepolia, a guarded $1.00 `payout.create` settles as a Stripe Connect test-mode transfer, and a guarded $1.00 `paypal.payout` reaches `SUCCESS` in the PayPal sandbox; the Stripe MPP adapter is tested against Stripe test mode. Real rails run only outside the public sandbox. The only other workspace with vendors is the testnet one, whose agent has no key anyone holds, so an outside agent can't make a real payment over the HTTP API yet.
- **Payout minimums are 1 cent on both payout rails** (measured). A PayPal sandbox payout costs the sender a $0.25 fee and usually takes 15 to 30 seconds to settle.
- The mock rail keeps its records in one process's memory.

## How it was built

Built with Kiro for Kiroween 2026: nine specs in [.kiro/specs](.kiro/specs), steering in [.kiro/steering](.kiro/steering), and hooks in [.kiro/hooks](.kiro/hooks). The development log is [docs/KIRO_LOG.md](docs/KIRO_LOG.md).

## License

[Apache-2.0](LICENSE)
