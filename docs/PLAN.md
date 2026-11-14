# Plan

**Naming:** a **task** is a numbered entry in a spec's `tasks.md`, for example "audit-and-approvals task 2". A **phase** is a row in this plan; one phase can cover tasks from several specs. Dates are suggestions.

Deployment target: Vercel **Hobby**. Cron jobs run at most once per day (see `tech.md`).

| Phase | Dates | Work | Status |
|---|---|---|---|
| 1 | Nov 13 | Planning: research, 7 specs, steering, hooks | Done |
| 2 | Nov 14 | Project setup (checklist below) | Not started |
| 3 | Nov 15 | money-and-policy-core tasks 1–2 | |
| 4 | Nov 16–17 | money-and-policy-core tasks 3–6 | |
| 5 | Nov 18 | audit-and-approvals tasks 1–3 | |
| 6 | Nov 19–20 | rail-adapters tasks 1–2, then audit-and-approvals tasks 4–6 | |
| 7 | Nov 21–22 | taint-and-intent tasks 1–6 | |
| 8 | Nov 23 | audit-and-approvals tasks 7–9 | |
| 9 | Nov 24 | telemetry-dashboard task 1 | |
| 10 | Nov 24–26 | telemetry-dashboard tasks 2–6 | |
| 11 | Nov 27 | demo-agents tasks 1–4 | |
| 12 | Nov 28 | telemetry-dashboard task 7 | |
| 13 | Nov 28–29 | rail-adapters tasks 3–5 (x402) | |
| 14 | Nov 29–30 | rail-adapters tasks 6–8 (Stripe) | |
| 15 | Nov 30 | telemetry-dashboard task 8 (Kiroween mode) | |
| 16 | Dec 1 | mcp-server tasks 1–4 | |
| 17 | Dec 1 (optional, cut first) | demo-agents tasks 5–6; taint-and-intent task 7 | |
| 18 | Dec 2 | telemetry-dashboard task 9 (polish, nightly reset cron) | |
| — | Dec 3 | Submission: demo video, Kiro write-up, final deploy check | |

Deadline: Dec 4, 2:00 PM PT.

**Scope-cut order** (if behind schedule, cut from the top):
1. Phase 17: the Gemini agent and advisory drift score.
2. mcp-server task 3: the Streamable HTTP transport. stdio stays.
3. Stripe MPP payer side: the payer uses the mock adapter. The MPP vendor endpoint and real test-mode refunds stay.
4. Kiroween mode polish beyond the palette and copy swap (telemetry-dashboard task 8).

Why this order (each phase only depends on earlier ones):
- **Rail adapters before the pay route.** audit-and-approvals task 5 calls the mock rail, so rail-adapters tasks 1–2 come first within Phase 6.
- **Scenarios before the end-to-end test.** The Playwright test in telemetry-dashboard task 7 runs the prompt-injection scenario, so demo-agents tasks 1–4 (Phase 11) come before it.
- **Approvals before sign-in.** audit-and-approvals task 7 (Phase 8) checks for a signed-in workspace member, but GitHub sign-in is telemetry-dashboard task 3 (Phase 10). Task 7 reads the user through a `getSessionUser()` function that returns `null` until Phase 10 replaces it with Auth.js. Tests inject a fake user, so the sandbox, 401, and wrong-workspace paths are all covered in Phase 8.
- **No two phases share a day's main work,** except Phases 9–10, which are small, and the Phase 13–14 boundary, where Stripe setup can start while x402 waits on a faucet.

## Phase 1: Planning (done)
- Research notes and decisions in `docs/KIRO_LOG.md`
- Seven specs in `.kiro/specs/`, steering in `.kiro/steering/`, seven hooks in `.kiro/hooks/` (five disabled until Phase 2)

## Phase 2: Project setup
Setup only: no product features and no database. Every spec task needs it first. The database schema is audit-and-approvals task 2 (Phase 5).

- [ ] 2.1 Install pnpm and scaffold Next.js (App Router) with TypeScript `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` (`tech.md`)
- [ ] 2.2 Create the folder layout from `structure.md`, with the `@/` import alias
- [ ] 2.3 Add ESLint, including a rule that blocks `src/core/**` from importing `src/server`, `src/rails`, `app/`, and I/O modules (`structure.md` layering rules)
- [ ] 2.4 Add Vitest and fast-check, `src/core/testing/arbitraries.ts` with the money generators from `testing-standards.md`, and one smoke test
- [ ] 2.5 Add `package.json` scripts: `dev`, `build`, `typecheck`, `lint`, `test`, `test:live`
- [ ] 2.6 Write the hook scripts, each with tests:
  - `scripts/guard-shell.mjs`: blocks recursive force deletes, `git push --force`, `git reset --hard`, and reading `.env` files; exits 2 to block
  - `scripts/check-kiro-not-ignored.mjs`: fails if `.kiro` or any file in it is gitignored
  - `scripts/check-money.ts`: flags `parseFloat`, `toFixed`, `Number()` on amounts, and `number`-typed `*Micros` fields
- [ ] 2.7 Enable the five disabled hooks once their scripts pass. First confirm that the `shell` matcher in `guard-shell.json` matches Kiro's shell tool name, so the guard actually runs
- [ ] 2.8 Add `.gitattributes` (text files stored with LF) and renormalize the existing files in a separate commit
- [ ] 2.9 Add `LICENSE` (Apache-2.0, copyright Owen Wang), `.gitignore` (ignores `.env*` except `.env.example`, never `.kiro`), and `.env.example` with placeholders
- [ ] 2.10 Write `docs/SETUP.md`: install Node 22 and pnpm, install dependencies, run the dev server and tests (PowerShell commands)

Commit messages follow `.kiro/steering/git-commits.md`; there is no git hook that enforces them.

Done when `pnpm typecheck`, `pnpm lint`, and `pnpm test --run` pass, and each enabled hook has run once without errors.
