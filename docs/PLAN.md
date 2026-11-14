# Global Plan

Each spec's `tasks.md` starts with a "Global plan mapping" line that points here.

**Naming:** "Task N" always means a row in this plan. The numbered entries inside a spec's `tasks.md` are called **items** (for example, "audit-and-approvals item 2"). A Task can cover items from several specs.

Deployment target: Vercel **Hobby**. Cron jobs run at most once per day (see `tech.md`).

| Task | Date | Work | Status |
|---|---|---|---|
| 1 | Nov 13 | Planning: research, 7 specs, steering, hooks | Done |
| 2 | Nov 14 | Project setup (checklist below) | Not started |
| 3 | Nov 15 | money-and-policy-core items 1–2 | |
| 4 | Nov 16–17 | money-and-policy-core items 3–6 | |
| 5 | Nov 18 | audit-and-approvals items 1–3 | |
| 6 | Nov 19 | audit-and-approvals items 4–6; rail-adapters items 1–2 | |
| 7 | Nov 20–21 | taint-and-intent items 1–6 | |
| 8 | Nov 22 | audit-and-approvals items 7–9 | |
| 9 | Nov 23 | telemetry-dashboard item 1 | |
| 10 | Nov 23–25 | telemetry-dashboard items 2–7 | |
| 11 | Nov 25–26 | demo-agents items 1–4 | |
| 12 | Nov 26–27 | rail-adapters items 3–5 | |
| 13 | Nov 27–28 | rail-adapters items 6–8 | |
| 14 | Nov 29 | telemetry-dashboard item 8 | |
| 15 | Nov 29–30 | mcp-server items 1–4 | |
| 16 | Nov 30 (optional, cut first) | demo-agents items 5–6; taint-and-intent item 7 | |
| 17 | Dec 1 | telemetry-dashboard item 9 | |

Submission target: Dec 3. Deadline: Dec 4, 2:00 PM PT.

## Task 1: Planning (done)
- Research notes and decisions in `docs/KIRO_LOG.md`
- Seven specs in `.kiro/specs/`, steering in `.kiro/steering/`, seven hooks in `.kiro/hooks/` (five disabled until Task 2)

## Task 2: Project setup
No product features and no database. The schema is audit-and-approvals item 2 (Task 5).

- [ ] 2.1 Install pnpm and scaffold Next.js (App Router) with TypeScript `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` (`tech.md`)
- [ ] 2.2 Create the folder layout from `structure.md`, with the `@/` import alias
- [ ] 2.3 Add ESLint, including a rule that blocks `src/core/**` from importing `src/server`, `src/rails`, `app/`, and I/O modules (`structure.md` layering rules)
- [ ] 2.4 Add Vitest and fast-check, `src/core/testing/arbitraries.ts` with the money generators from `testing-standards.md`, and one smoke test
- [ ] 2.5 Add `package.json` scripts: `dev`, `build`, `typecheck`, `lint`, `test`, `test:live`
- [ ] 2.6 Write the hook scripts, each with tests:
  - `scripts/guard-shell.mjs`: blocks recursive force deletes, `git push --force`, `git reset --hard`, and reading `.env` files; exits 2 to block
  - `scripts/check-kiro-not-ignored.mjs`: fails if `.kiro` or any file in it is gitignored
  - `scripts/check-money.ts`: flags `parseFloat`, `toFixed`, `Number()` on amounts, and `number`-typed `*Micros` fields
- [ ] 2.7 Enable the five disabled hooks once their scripts pass
- [ ] 2.8 Add a versioned `commit-msg` git hook (`.githooks/commit-msg`, set up through `core.hooksPath` in a `prepare` script) that enforces `git-commits.md`
- [ ] 2.9 Add `LICENSE` (Apache-2.0, copyright Owen Wang), `.gitignore` (ignores `.env*` except `.env.example`, never `.kiro`), and `.env.example` with placeholders
- [ ] 2.10 Write `docs/SETUP.md`: install Node 22 and pnpm, install dependencies, run the dev server and tests (PowerShell commands)

Done when `pnpm typecheck`, `pnpm lint`, and `pnpm test --run` pass, and each enabled hook has run once without errors.
