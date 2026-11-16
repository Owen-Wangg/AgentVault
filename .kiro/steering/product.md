---
inclusion: always
---

# Product: AgentVault

## One-line pitch
AgentVault is a security proxy that sits between AI agents and payment rails (Stripe MPP and x402). It checks every payment and high-privilege tool call against spend limits, untrusted-input (taint) rules, and the task's declared scope before any money moves.

## The problem
AI agents now pay for APIs on their own. Stripe's Machine Payments Protocol (MPP) and the x402 protocol let an agent answer an HTTP `402 Payment Required` challenge and pay per call, sometimes fractions of a cent. Existing payment controls assume a human approves each purchase. An agent that is prompt-injected by a scraped page, or stuck in a retry loop, can drain a budget in seconds, one small charge at a time.

## Who it's for
- **Developers shipping agents that spend money**: they need per-agent budgets and a kill switch.
- **Platform and security teams**: they need an audit trail they can trust and a human approval step for risky actions.
- **Hackathon judges**: they need a public sandbox that shows all of this in under a minute, with no login.

## Core features
1. **Spend envelopes**: per-agent limits (per transaction, rolling per minute, hour, and day, calls per minute, an approval threshold, vendor and tool allow-lists), with optional per-vendor and per-tool limits.
2. **Taint tracking**: content fetched from outside the allow-list marks the session as tainted. While tainted, high-privilege tools (`stripe.refund`, `wire_transfer`, `payout.create`, `payee.update`) are frozen and need human approval.
3. **Intent scope**: each task declares the vendor categories, tools, and budget it may use. Anything outside that scope is denied as intent drift.
4. **Human-in-the-loop approvals**: held requests wait in an inbox. Approving re-runs the policy check.
5. **Tamper-evident audit log**: a hash-chained, append-only log of every decision, with a "Verify chain" button.
6. **Live telemetry dashboard**: spend, blocked spend, live feed, approvals, and agents.
7. **Real rails**: x402 on Base Sepolia and Stripe MPP in test mode, plus mock rails for tests and the sandbox.
8. **MCP server**: lets any MCP client (Kiro, Claude Desktop) route payments through AgentVault.

## Demo scenarios (the scripted agent runs these)
| Scenario | What happens | Expected decision |
|---|---|---|
| Normal purchase | Agent pays per call for weather data over x402 ($0.0015 on the mock rail; $0.01 on Base Sepolia unless sub-cent settlement is confirmed) | `allow`, logged |
| Runaway loop | A retry bug sends hundreds of calls per minute | `deny` with `VELOCITY_EXCEEDED`, agent frozen |
| Prompt injection | Agent reads a poisoned vendor docs page asking for a $480 refund | Session tainted, `stripe.refund` → `hold` with `HELD_TAINTED` |
| Intent drift | Task is "buy weather data," agent tries to pay for GPU compute | `deny` with `DENY_INTENT_DRIFT` |

## Out of scope
- Mainnet funds or live Stripe keys. Everything runs on testnets and Stripe test mode.
- Custody of real user wallets.
- Being a payment processor. AgentVault only decides and forwards.

## Product principles
- **Professional by default.** The default UI is a serious security console. The Kiroween theme is a toggle in Settings that changes styling and copy only, never behavior.
- **Deterministic decisions.** The scope and envelope rules make every final decision. LLM signals are advisory only.
- **Fail closed.** If AgentVault can't evaluate or audit a request, the request does not execute.

## Hackathon context (Kiroween 2026)
- Category: **Frankenstein** (stitching together card rails, stablecoin rails, LLM security, and MCP). Also targeting Best Student Project: Frankenstein, Best Demo, Blog, and Social Blitz.
- Deadline: Dec 4, 2026, 2:00 PM PT. Target submission: Dec 3.
- Judging: Stage One pass/fail on theme fit and Kiro usage. Stage Two weighs five criteria equally (10 points each): Potential Impact, Technological Implementation (Kiro usage), Design, Innovation/Idea, Presentation.
- Compliance: public GitHub repo `Owen-Wangg/AgentVault`, Apache-2.0 license visible in About, `/.kiro` at the root and **never gitignored**, working public URL, demo video under 3 minutes (public on YouTube, no copyrighted music or third-party trademarks), Kiro write-up answering the rules' eight questions.
- The live app must stay available, free and without restriction, until the Judging Period ends (Jan 29, 2027, 1:00 PM PT). Don't let keys, free-tier quotas, or the database lapse before then.
- Bonus prizes: the Social Blitz post must **start** with `#KiroweenHackathon26` and is judged on original writing; the blog post must say it was written as part of the Kiroween 2026 hackathon. Both must be published before the deadline.
- Only open-licensed fonts, icons, and assets. No third-party copyrighted content.
