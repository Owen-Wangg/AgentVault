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
- **Hooks.** 7 hooks: test-on-save, no-float-money, spec-trace, post-task-verify, devlog, guard-shell (PreToolUse; AgentVault's own taint idea applied to Kiro's shell access), and kiro-dir-guard (protects against the `.gitignore` disqualification rule). Five start disabled until project setup (Phase 2) creates their scripts.

## 2026-11-14

- **Spec gap-closing for audit-and-approvals.** Added requirement IDs for spend reservations (RES), uncertain rail outcomes, and canonical JSON (CJ). A rail timeout is now recorded as `unknown` and the reservation stays counted until a reconciler resolves it with a read-only `lookup()`. Only a confirmed failure releases money.
- **Audit log hardening in the spec.** A statement-level `TRUNCATE` trigger (row triggers never fire on `TRUNCATE`) and an HMAC-signed chain head, so rows deleted from the end of the chain are detected. The sandbox resets by creating a new workspace, never by deleting audit rows.
- **What writing the spec caught:**
  - An approval recheck that reused the original idempotency key would have returned the stored "held" response forever, so approved requests would never run.
  - Vercel Hobby only allows daily cron jobs, so the reconciler also runs after each request using Next.js `after()`.
  - A 0.01 USDC rail minimum in steering would have rejected the sandbox's $0.0015 payment.
  - Refunds round down at the rail, so the envelope now counts the full requested refund (MON-11).
  - The scenario seeds now make each demo produce exactly one intended reason code.
- **Steering and planning.** Added an always-included `git-commits.md` steering file for commit format. Added `docs/PLAN.md` with dependency-ordered phases and a scope-cut order. "Task" now always means a `tasks.md` entry, which matches Kiro's task UI.
