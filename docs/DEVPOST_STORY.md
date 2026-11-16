# Devpost project story (draft)

Paste into the Devpost "About the project" fields. The Kiro section is in `docs/KIRO_WRITEUP.md`.

**Tagline (under 200 characters):** A security proxy for AI agents that spend money: spend limits, taint tracking, and human approval checked before every x402 or Stripe MPP payment.

**Try it:** <https://owen-agentvault.vercel.app> (no login, mock rails)

**Submission form checklist** (Official Rules, section 4, read 2026-11-16):
- Category: **Frankenstein** (one category only). Bonus prizes to tick: Best Student Project (Frankenstein), Best Demo (automatic), Bonus Blog Prize, Social Blitz.
- Best Student Project needs your LinkedIn profile, student email, year and degree, and school name. Proof of enrollment may be requested.
- Public GitHub repo URL, live app URL, public YouTube video URL (under 3 minutes), the Kiro write-up, and the blog and social post URLs.
- No login is needed for judging; say so in the credentials field. Sign-in with GitHub is optional and only gives a personal workspace.
- The rules say the app must stay available, free and unrestricted, **until the Judging Period ends on January 29, 2027**.
- Pre-existing code must be disclosed. Everything here was written during the Submission Period, using open-source libraries.

## Inspiration

Stripe's Machine Payments Protocol and x402 let an AI agent answer an HTTP `402 Payment Required` and pay per call, sometimes a tenth of a cent. That's useful, and it removes the person who used to approve each purchase. Card limits and fraud checks assume a human at checkout. An agent that reads a poisoned web page, or loops on a retry bug, can spend a budget one small charge at a time, faster than anyone would notice.

We wanted the agent equivalent of a firewall: a place where every payment and every risky tool call is checked against rules the agent can't talk its way around.

## What it does

AgentVault sits between agents and payment rails. Agents call its API (or its MCP server) instead of paying directly, and every request is decided before money moves:

- **Spend envelopes.** Per-agent limits per transaction, per minute, hour, and day, calls per minute, vendor and tool allow-lists, and an approval threshold. A runaway loop is denied for velocity and the agent is frozen.
- **Taint tracking.** Agents read the web through AgentVault, which labels each page trusted or untrusted by origin. Once a session reads untrusted content, refunds, payouts, wire transfers, and payee changes are frozen until a person approves them. This is the defense against prompt injection: the agent may be fooled, but the refund still doesn't run.
- **Intent scope.** Each task declares the vendor categories, tools, and budget it needs. A weather task that tries to buy GPU time is denied as intent drift.
- **Human approvals.** Held requests wait in an inbox. Approving re-runs every check, and an approval runs at most once.
- **Tamper-evident audit log.** Every decision is in an append-only, hash-chained log with a signed head. "Verify chain" recomputes it.
- **Live dashboard** with spend, blocked spend, a live feed, approvals, and agents, plus a Kiroween theme that changes only styling and copy.
- **MCP server,** so Kiro or Claude Desktop can pay through AgentVault. It has no approve tool, so an agent can't approve its own refund.

The public sandbox runs four scripted scenarios (normal purchase, runaway loop, prompt injection, intent drift), and three of them can also run with a live Gemini agent that makes its own choices.

## How we built it

- **Next.js on Vercel** (region `pdx1`), **Neon Postgres** in us-west-2, **Drizzle**, and **Zod** at every boundary.
- **Money is `bigint` micros** (1 USD = 1,000,000), so sub-cent charges are exact. Conversions to Stripe cents round against the agent: debits up, refunds down.
- **Each payment is one database transaction:** lock the agent's envelope row, claim the idempotency key, load the state, run a pure `evaluate()` function, write the audit row, and reserve the amount. The rail call happens after the commit, so no lock is held during a payment. If any step fails, nothing is paid.
- **Rails:** x402 on Base Sepolia (USDC) and Stripe MPP in test mode, each verified with real test payments, plus a mock rail for the sandbox.
- **Testing:** about 1,270 Vitest tests, many of them fast-check property tests of the design's correctness properties, and Playwright for the judge's path. Each safeguard was broken on purpose to confirm a test catches it.
- **Built with Kiro:** seven specs, steering, seven hooks, and MCP. Details in the Kiro write-up.

## Challenges we ran into

- **Uncertain payment outcomes.** A blockchain payment can time out after the money moved. AgentVault records it as `unknown` and keeps the amount counted until a reconciler proves the outcome. For x402 that meant deriving the authorization nonce from the reservation ID, so the payment can be found on chain later by its key alone.
- **Concurrency.** 50 parallel payments against a $0.045 cap must allow exactly 30. Without the row lock, 37 got through. That only showed on real Postgres.
- **A parser that dropped limits.** Zod silently skips a `__proto__` key, so a vendor limit under that name vanished and the payment was allowed. A property test found it.
- **Measuring the rails.** The x402 facilitator's minimum on Base Sepolia turned out to be $0.001, which we measured by paying at several prices. Base Sepolia's 0.2-second blocks and 200-block log limit shaped the lookup code.
- **Live AI on a free tier.** The live agent shares 15 requests a minute with every visitor, so runs are capped, scored in parallel, and retried once on timeouts.

## Accomplishments that we're proud of

- The prompt-injection demo works end to end: the scripted agent obeys the hidden instruction, and the $480 refund is still held for a person. Kiro, connected over MCP, got the same hold.
- Real sub-cent x402 payments ($0.0015) settled on Base Sepolia, and real Stripe MPP test payments with a refund, each found again by the read-only lookup the reconciler uses.
- Property tests that found real bugs, including one that would have let a limit disappear.
- Lighthouse accessibility, best practices, and SEO scores of 100 on the overview in both themes.

## What we learned

- An LLM can help judge intent, but it can't be the one that says yes. AgentVault lets a model's drift score add a hold, never remove one.
- "We don't know if it paid" is its own state, and treating it as "failed" is how money leaks.
- Writing specs before code caught design bugs that would have been expensive later, such as a lock held across a blockchain call.

## What's next for AgentVault

- Connect the guarded flow to the real rails' payment URLs, so agents' x402 and MPP payments run for real through AgentVault. Today the live site uses mock rails, and in real mode an agent's payment fails closed.
- Self-serve sessions for outside agents, beyond the setup script.
- Per-vendor call counts, alerts, and a badge for pending approvals.

## Built with

TypeScript, Next.js, React, Vercel, Neon, PostgreSQL, Drizzle ORM, Zod, Auth.js, Tailwind CSS, Recharts, x402, Coinbase CDP, Base Sepolia, Stripe, MPP, Model Context Protocol, Gemini, Vitest, fast-check, Playwright, Kiro
