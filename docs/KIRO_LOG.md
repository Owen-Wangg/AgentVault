# Kiro Development Log

Raw notes for the Devpost "How Kiro was used" write-up. The `devlog` hook (Stop trigger) appends to this file.

## 2026-11-13

- **Research and planning with Kiro.** Kiro read the Kiroween 2026 Devpost overview, Stripe's machine payments docs (MPP, x402, Shared Payment Tokens), the Coinbase CDP x402 seller quickstart, Gemini rate-limit docs, and Kiro's own hooks and steering docs. The Devpost Rules page was blocked to fetching, so the judging text was pasted in manually.
- **Research changed the design.** Stripe's docs show MPP sessions charge in sub-cent increments, so integer cents could not represent the core threat (micro-payment drain). The money unit became `bigint` micros (1 USD = 1,000,000, matching USDC's 6 decimals). Stripe's SPT docs confirmed Canada supports SPTs and offer a sandbox test helper, which made a real Stripe test-mode rail possible from a Canadian account.
- **Spec-driven development.** Created 7 feature specs in Kiro's layout (`.kiro/specs/<feature>/requirements|design|tasks.md`) with EARS acceptance criteria and IDs (MON, ENV, PXY, AUD, HITL, TAINT, INT, RAIL, TEL, UI, AGT, MCP). Each design doc lists numbered correctness properties that become fast-check property tests.
- **Writing the specs caught design bugs before any code:**
  - Banker's rounding could round a debit down, which favors the agent. Replaced it with directional rounding (debits round up, credits round down).
  - Holding a database row lock during a blockchain payment would block every other request for that agent for seconds. Replaced it with spend reservations committed before the rail call.
  - The prompt-injection demo task must allow `stripe.refund`. Otherwise intent scope denies the refund first, and the demo would never show the taint defense.
  - The proxied fetch endpoint needed SSRF protection (private IP ranges, redirects, cloud metadata address).
- **Steering.** Foundation files (`product.md`, `tech.md`, `structure.md`) plus `security-standards.md` (always included), `money-arithmetic.md` and `testing-standards.md` (fileMatch), and `validate-mpp.md` (manual slash command, since the IDE no longer creates Manual hooks).
- **Hooks.** 7 hooks: test-on-save, no-float-money, spec-trace, post-task-verify, devlog, guard-shell (PreToolUse; AgentVault's own taint idea applied to Kiro's shell access), and kiro-dir-guard (protects against the `.gitignore` disqualification rule). Five start disabled until Task 2 creates their scripts.
