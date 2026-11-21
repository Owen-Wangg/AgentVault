# How Kiro was used (draft)

Draft for the Devpost write-up. Every example below comes from `docs/KIRO_LOG.md`, which has the seeds and numbers.

## At a glance

- **Specs.** Nine specs, each with EARS requirements that have IDs, a design with numbered correctness properties, and a task list. Writing them caught design bugs before any code, such as a row lock held across a blockchain payment and a payout that read its destination too early. Every test name starts with the requirement ID it covers.
- **Steering.** Eight files. What worked best was pairing each rule with a check: "no floats for money" with a hook, "the core does no I/O" with an ESLint rule, and "Kiroween mode is cosmetic" with a property test.
- **Hooks.** Seven. A shell guard applies AgentVault's own idea to Kiro and blocked it several times. A traceability check found 29 requirement IDs that no design or task named.
- **Property-based tests.** 19 files, written from the designs' properties. They found real bugs, such as a vendor named `__proto__` whose $0 daily cap disappeared during parsing. Each safeguard was also broken on purpose to prove a test catches it.
- **MCP, both directions.** Kiro paid through AgentVault's own MCP server, fell for the poisoned page, and was held, with no tool to approve itself. Vercel's and Neon's MCP servers let Kiro read deployment logs and free-plan usage, read-only.
- **Custom agent and the CLI.** A least-privilege security-reviewer agent, built in the Kiro CLI, ran two full reviews and a follow-up, and every finding was fixed or decided in its own commits.
- **Powers.** Stripe (account and API data during testing, its docs, and the Connect payout design) and Neon (usage checks against the free plan).

The Official Rules (section 4) list eight questions the write-up should answer. Where each is answered:

| Rules question | Section below |
|---|---|
| Kiro IDE, CLI, Web, Crew | Which Kiro apps |
| Custom agents | Subagents and custom agents |
| Agent hooks | Hooks |
| Spec-driven development, and how it compared to vibe coding | Specs first, code second |
| Steering docs, and the strategy that made the biggest difference | Steering |
| MCP | MCP, both directions |
| Property-based testing | Property-based tests that found real bugs |
| Kiro powers | Powers |

## Which Kiro apps

Most of the work was done in the Kiro IDE on Windows. The Kiro CLI (3.0.0) was used for the custom agent: `kiro-cli agent validate` and `kiro-cli agent list` checked its config, and the agent then ran as a sub-agent for the security review below. The CLI felt much faster and more autonomous than the IDE, and it was nicer for quickly running terminal commands. The IDE's workflow felt more structured and visual, which was good for walking through the specs and reviewing diffs inline. The project's MCP server works with any MCP client, and `docs/MCP.md` also covers Claude Desktop.

## Subagents and custom agents

**`security-reviewer`** (`.kiro/agents/security-reviewer.json`) is a custom agent made in the Kiro CLI. It is built the way AgentVault treats its own agents: least privilege, and file contents are data.

- **Permissions.** It can read the repo, except `.env` files, `.pem` and `.key` files, `node_modules`, and `.next`. Its only write access is new Markdown files under `docs/security/`. Shell, web fetch, web search, MCP, and sub-agents are denied.
- **Context.** The security, product, structure, and money steering files load as resources, so `security-standards.md` is its checklist, in order: money, the nine-step payment flow, fail closed, taint and scope, approvals, audit log, auth and secrets, trust boundaries, web hardening, dependencies.
- **Prompt.** It must treat the deliberately poisoned vendor page and invoice as data and report any embedded instruction as a finding. It must cite a file and line for every finding, say what it could not check, never print a secret value, and never overwrite an earlier report.

The first full review ran as a sub-agent and saved `docs/security/2026-11-18-full-review.md`: no critical or high findings, two medium (raw URLs with query strings written to the append-only audit log, and `clientIp` trusting forwarded headers off Vercel) and seven low. It also confirmed or corrected four findings from an earlier chat pass, and it said which files it had not read and that it could not run `pnpm audit`. The fixes went in as separate commits: security headers on every route, URLs stripped of query strings and credentials in fetch events, proxy IP headers trusted only behind a proxy that sets them, `AGENT_FROZEN` on early refusals, no stored GitHub tokens and shorter sessions, no vendor redirects and capped vendor reads, and all-visitor caps on scenario runs, event streams, and approval listing.

The second full review, `docs/security/2026-11-19-full-review.md`, re-checked every earlier finding against the code (all fixed or accepted as recorded) and again found nothing critical or high. Its one medium: public dashboard pages read every agent and every decision in the sandbox, which one IP could grow to about 14,000 agents in a day. The fixes bound those reads to the 200 newest agents and add three indexes. The low and info findings were fixed in their own commits too: a per-agent limit of 120 pay, tool, and fetch requests a minute, a required calls-per-minute cap on saved envelopes, payouts with an unreadable destination recorded as failed with the reservation released, a longer per-run supplier name so two runs can't collide, and the no-load CSP on the vendor API.

What went wrong: the first version was Markdown with front matter, which the docs allow, but the CLI's `agent list` and `validate` only read JSON, so I converted it. The agent also listed some files as unread that the earlier pass had covered. And its report corrected my own note that unknown-tool requests skip the velocity count: they count, through the idempotency row.

Kiro's built-in introspect subagent checked Kiro's own docs: that a hook's `timeout` belongs on the hook and not the action, and how Kiro confirms and permits MCP tool calls.

## Powers

Two Kiro powers were installed and authenticated: Stripe and Neon.

- **Stripe.** Its account tools are connected to the project's Stripe test-mode account, and Kiro used them during testing to inspect the account and its API data. Its docs search read Stripe's documentation and helped plan the implementation, along with docs.stripe.com's Markdown pages, and stood in for the Stripe CLI, which isn't installed. Its best-practices skill set the payout-rails Connect design: Accounts v2 recipient accounts, a capability check before each transfer, and no legacy account types.
- **Neon.** Its MCP server was used read-only on Nov 16 and 17 to check the project's compute and network usage against the Free plan for the judging period, and to confirm a lower compute cap (see MCP below).

Other Stripe research used the published `mppx` and `stripe` packages, and Neon work also used the Neon console and `DATABASE_URL_TEST`. Vercel's official MCP server was connected and used read-only (see MCP below).

## Specs first, code second

AgentVault has nine specs in `.kiro/specs/` (money-and-policy-core, audit-and-approvals, rail-adapters, taint-and-intent, telemetry-dashboard, demo-agents, mcp-server, payout-rails, testnet-demo). Each has EARS requirements with IDs (`ENV-3`, `TAINT-6`, `HITL-2`), a design with numbered correctness properties, and a task list. Test names start with the requirement ID they cover, so `grep ENV-8` finds the rule, the design, the task, and the tests.

Writing the specs caught design bugs before any code existed:

- **Rounding that favored the agent.** The first plan used banker's rounding to convert micros to Stripe cents. It can round a debit down, so an agent could spend slightly more than its cap. The spec now requires directional rounding: debits round up, refunds round down.
- **A lock held across a blockchain call.** Holding the envelope row lock during an x402 payment would block every other request from that agent for seconds. The design changed to spend reservations committed before the rail call.
- **A demo that couldn't show its own point.** If the prompt-injection task didn't allow `stripe.refund`, intent scope would deny the refund before the taint rule ever ran. The task now allows it, so the hold comes from taint.
- **An approval that could never run.** An approval re-run that reused the original idempotency key would replay the stored "held" response forever. Re-runs use `approval:<id>`.
- **Platform limits.** Vercel Hobby only allows daily cron jobs, so the reconciler also runs after each request with Next.js `after()`.
- **A payout that rounded the wrong way.** `payout.create` was first registered as a debit. A payout sends money out, so the payee's amount must round down to the cent while the envelope counts the full amount.
- **A destination read too early.** If a payout took its destination when it was requested, denying an injected payee change wouldn't help: the held payout would still carry the attacker's account. The spec has payouts read the destination when they run, so denying the change and approving the payout pays the supplier.
- **Turning on real rails would have broken the sandbox.** While designing the public testnet button, reading the rail setup showed that every request built every real adapter before it knew its workspace. With `RAIL_MODE=real` and any real-rail variable missing, every sandbox request would have failed, even though the sandbox only uses mocks. The testnet-demo spec made the per-workspace choice a requirement (TN-8) and a property test, and breaking it on purpose shrank to `{"RAIL_MODE":"real"}`.
- **One visitor's approval leaking into another's demo.** In the shared sandbox, one visitor approving the hijack would leave the supplier pointing at the attacker until the nightly reset. Each payee hijack run now gets its own supplier row.

**Compared to vibe coding.** This felt far more structured and organized than vibe coding on the fly. When Kiro generated each spec, it asked me a lot of questions, and answering them made clear what I really wanted from the project. It then broke the work into tasks and stages, so I always had a structured goal in mind instead of improvising the next step.

This mattered most for payment code, which fails quietly: a rounding direction or a missing lock produces a wrong number, not an error. Vibe coding would have produced working-looking code with those bugs in it. With specs, each rule had an ID, a planned property, and a task before any code, so Kiro implemented one task at a time against a fixed target, and the post-task hook ran the full suite after each one.

The payout-rails spec also required a probe of each rail before any adapter was written, and the design changed when the probes disagreed with the docs. PayPal refuses a resent `sender_batch_id` instead of returning the original batch, and has no read-only lookup by it, so AgentVault now stores PayPal's own batch ID on the reservation (PO-25) and treats a duplicate refusal as unknown, never as a failure. Stripe answers a reused idempotency key with different parameters with `idempotency_error`, which also means a request under that key already exists, so it's unknown too. The Canadian Stripe sandbox couldn't create recipient accounts until the platform took on loss liability in its Connect platform profile, which only Owen could change in the Dashboard.

Specs kept catching gaps during implementation. While writing `appendEvent`, the design turned out never to check the chain head's HMAC before extending it, so an attacker could delete the tail, roll the head back, and let the next normal append re-sign the forgery. While reading the mcp-server spec, nothing handed MCP clients a session, which led to `pnpm mcp:agent`.

## Steering

Steering files in `.kiro/steering/` held the rules that every change had to follow:

- `security-standards.md` (always included): the nine-step order of a pay request inside one transaction, fail closed, deny beats hold beats allow, LLM output advisory only, test keys and testnets only.
- `money-arithmetic.md` and `testing-standards.md` (file match): `bigint` micros, the banned float patterns, the fast-check generators, `@live` tags, recorded responses.
- `product.md`, `tech.md`, `structure.md`: the pitch and demo table, the stack and its pins (TypeScript 6.0 because `typescript-eslint` doesn't support 7, Vercel region `pdx1` next to Neon in us-west-2), and the layering rule that `src/core` does no I/O.
- `git-commits.md`: the commit format (type, scope, imperative summary, a required body, one logical change per commit).
- `validate-mpp.md`: a manual slash command that runs Stripe's `mppx validate` against the deployment. It found that mppx took the payment realm from the deployment's own hostname instead of the public one.

**The strategy that made the biggest difference:** turning each steering rule into something a tool checks. "Floats never touch money" is in steering, and the no-float-money hook runs `pnpm check:money` on every save. "`src/core` does no I/O" is in steering, and an ESLint rule enforces it. "Kiroween mode changes styling and copy only" is in steering, and a property test runs two sandboxes in lockstep to prove it. Steering told Kiro the rule; the check caught the times it didn't follow it.

The steering changed when the facts did. A measured x402 minimum on Base Sepolia ($0.001) replaced a guessed 0.01 USDC minimum that would have rejected the sandbox's $0.0015 payment. The payout minimums in `money-arithmetic.md` were placeholders until the probes measured 1 cent on both Stripe Connect and PayPal. When the payout rails were added, `security-standards.md` gained two rules first: any Stripe object returned with `livemode: true` is an invalid response, and PayPal calls are refused outside the sandbox host.

## Hooks

Seven hooks in `.kiro/hooks/`:

| Hook | Trigger | What it did on this project |
|---|---|---|
| guard-shell | Before every shell command | AgentVault's own idea applied to Kiro: it blocks recursive force deletes, `git push --force`, `git reset --hard`, and any command that names a `.env` file. It blocked Kiro several times, for example a recursive delete of `test-results/` and a command that named `.env.example`. |
| kiro-dir-guard | Save of `.gitignore` | Fails if `.kiro` or anything in it becomes gitignored, which would break a Devpost rule. |
| no-float-money | Save of a `.ts` file | Runs `pnpm check:money`. It flagged the fake Stripe account's cents fields, which now carry an explicit exemption with a reason. |
| test-on-save | Save in `src/core` | Runs the pure-core unit and property tests. |
| post-task-verify | After a spec task | Runs typecheck, lint, and the full test suite. |
| spec-trace | Save of a `requirements.md` | Lists requirement IDs with no task or no planned test. It found 13 taint-and-intent IDs and 15 demo-agents IDs that the designs never named, and the new PO-25 missing from the payout-rails tasks and testing strategy. A last pass over all nine specs (256 IDs) found AUD-6 with no task and 22 tested IDs that a design named only through a general line. |
| devlog | End of a turn | Appends to `docs/KIRO_LOG.md`, the raw material for this write-up. |

## Property-based tests that found real bugs

Each design's correctness properties became fast-check tests, in 19 property-test files, with fast-check also used in 14 other test files. They cover the requirements where one bad input costs money or trust, and where example tests can't cover the input space: money conversion and rounding, spend caps over whole sequences of requests, the taint and intent rules, approvals (a model-based test with commands), the audit hash chain, each rail adapter's idempotency, the theme boundary, the per-workspace rail choice, and the public testnet endpoint. Some found bugs in code that unit tests had passed:

- **Zod dropped a limit silently.** "Allowed spend never exceeds any cap" failed with seed `-792056920` and shrank to one 1-micro payment to a vendor named `__proto__`, whose day cap was 0, being allowed. `z.record` skips an own `__proto__` key, so the limit vanished during parsing. Limit maps keyed by `__proto__` are now rejected, and the same lesson was applied to audit decoding and tool arguments later.
- **A crash in the overview.** "The chart's buckets add up to the spend card" failed on seed `554141298`: two maximum-size payments made the guarded `add()` throw, which would have taken the overview down.
- **A float bug, shown on purpose.** A fixture converts micros to cents with floats. Property 3 ("a debit never rounds below the amount") fails on it with seed `20261114` and shrinks to `1n`: one micro charged as 0 cents.

## Safeguards broken on purpose

For each safeguard, I broke it in the code, checked that a test failed, and restored it. Some of the more useful results:

- **The envelope lock.** 50 parallel $0.0015 payments against a $0.045 minute cap allow exactly 30. With `FOR UPDATE` removed, 37 are allowed, $0.0105 over the cap. This only shows on real Postgres (Neon), not on in-memory PGlite.
- **Weak tests found by mutation.** The first taint property only checked that a privileged call after a taint is never `allow`. Most generated requests were denied by other rules anyway, so a broken taint rule passed. The test now also requires `HELD_TAINTED`, and a second form generates requests every other rule allows. The model-based approvals test missed an off-by-one in expiry, because random clocks almost never landed exactly on an expiry; a command now jumps to an expiry ± 1 ms, and the mutation fails on the first run (seed `-2124937188`).
- **The reconciler.** Treating an "unknown" rail outcome as failed (which would release money without proof) fails property 6 with seed `2017577166`.
- **The live AI agent.** Making a low drift score drop hold reasons failed taint-and-intent property 3 after 4 cases: a tainted privileged call with score 0. The LLM can add a hold but never remove one.
- **The payout destination.** Taking a payout's destination from the request's arguments instead of the vendor row failed payout-rails property 1 and the PO-4 test. Storing a new payee before the rail checks it failed property 1 and four payee tests.
- **Uncertain payouts.** Mapping PayPal's `PENDING` to failed, which would release a reservation for a payout that may still pay, failed 11 tests, including property 5 and the replay of the recorded probe. Treating Stripe's `idempotency_error` as a confirmed failure failed a contract test and a unit test.
- **The public testnet button.** Creating the session before checking the visitor limits, so a refused press leaves a row behind, failed testnet-demo property 1, which shrank to three presses from one IP. Accepting extra fields in the body failed property 2 with `{"vendor":[]}`: the visitor must never choose anything about a real payment.
- **The theme boundary.** Kiroween mode must change only styling and copy. A property runs two sandboxes in lockstep, one per theme, and requires identical responses and audit events. A response made to depend on the cookie's length failed it on the first case.
- **The tamper demo.** The audit page's "Rewrite an event" rechecks a page of the log in the browser, starting mid-chain from the page's first row. Starting from the genesis hash instead, which would make every page look broken, failed four properties; the first shrank after 3 cases (seed `-1387811573`).
- **The decision path.** The scenarios page shows which check decided a request, ending at the payment rail. Marking the rail "Sent" for held requests too failed the path-consistency property after 7 cases (seed `-560700878`).
- **A CSP violation no test had seen.** Lighthouse on the live overview scored best practices 96, not 100. A browser probe of the page found why: zod 4 tries `Function("")` once to decide whether to compile validators, and the page's nonce-only script policy blocks it, so every page load logged a violation. Nothing broke, since zod falls back, and no unit test runs under the real policy. Zod is now jitless in the browser only, without loosening the policy, and the new test fails without that setting.

## MCP, both directions

- **Kiro calling AgentVault.** The project's own MCP server (`src/mcp`) ran from Kiro's user-level config over stdio. From a Kiro chat, `agentvault_pay` paid $0.0015 to the weather vendor (allowed), `agentvault_fetch` read the poisoned docs page (labeled untrusted, session tainted), and `agentvault_request_tool` asked for the $480 refund (held with `HELD_TAINTED` and `NEEDS_APPROVAL`). A person then approved it in the dashboard. During that run Kiro noticed that the hold message said "over the approval threshold" while ENV-8 holds at or above it, and the copy was fixed.
- **Kiro debugging the deployment.** The live Gemini run failed on Vercel but not locally. Each run now reports where its time went, and the failed run showed the agent's turn took 754 ms while five parallel drift scores got no answer within 20 s. That led to one retry on timeouts and 5xx errors. With Vercel's MCP server connected (read-only calls, each approved by hand), Kiro found the project and read its runtime logs to confirm the fix: the live normal purchase then finished on Vercel with 5 payments allowed in about 9 s.
- **Kiro checking the free plans.** The live app must stay up and free until judging ends on Jan 29. Through the Neon MCP server (read-only), Kiro read the billing period's compute and transfer totals, about 4.8 CU-hours a day, and worked out that the event stream would use up the Free plan before then. That led to a spec change (TEL-6, TEL-7: the stream pauses when the tab is hidden or idle) and a lower compute cap, which a later read confirmed.
- **The introspect subagent** checked Kiro's own docs, for example that a hook's `timeout` belongs on the hook and not the action, and how MCP tool permissions work.

**What MCP made possible.** Without MCP, a coding assistant can only write payment code, not be the agent that pays. Over MCP, Kiro became the system under test: it was given an AgentVault session, fell for the poisoned page like any agent, and was held by the same rules, with no tool to approve itself. The Vercel and Neon servers let Kiro read logs and usage from the editor without anyone pasting credentials into the chat.

## The live AI agent

The optional Gemini agent (`gemini-3.5-flash-lite`, free tier) runs three scenarios with real model choices, and AgentVault's rules still decide every request. In the live drift run the model sometimes buys GPU time, which is denied with `DENY_INTENT_DRIFT` and `ADVISORY_DRIFT` (score 100). In the live injection run the model reads the poisoned page but has never asked for the $480 refund, so the demo uses the scripted run for the hold. I kept the prompt as a developer would plausibly write it rather than tuning it to fall for the injection. AgentVault doesn't depend on the model resisting: had it asked, the refund would have been held.

## What Kiro got wrong

- **Parallel batches.** Several times, two edits to one file, or a mutation check's backup and its edit, went out in the same parallel batch. Once the backup captured the mutated file, the restore left the bug in place, and I changed a test twice before reading the code and finding the mutation. The tests caught it before any commit. The working rule is now one dependent step per call.
- **Shell quoting.** PowerShell expanded `${…}` inside a replacement string and turned two `aria-label`s into `" bot"`. A component test's accessible-name query caught it.
- **Calling a failure a one-off.** The end-to-end test's reload loop was first dismissed as a one-off. It came back; the test's dev server now builds into its own folder, and Playwright writes its output outside the repo. It still came back once. The cause is unknown, but a watcher found a lead: the test server rewrites `next-env.d.ts`, a file in the project root that the normal dev server also writes.
- **Mis-decoded characters.** To commit one change in `copy.ts` apart from another, Kiro rebuilt the file from `git show` output read through PowerShell, which mis-decoded six ellipsis characters, and committed that. A follow-up commit restored them from the earlier commit's bytes. The working rule is now to write `git show` to a file and read it as UTF-8. The same kind of slip happened again later: PowerShell 5 read an edit script without a byte-order mark as ANSI and garbled an ellipsis in the log, so edit scripts now hold only ASCII.
- **Times in the wrong zone.** The audit and agents pages formatted times while the server rendered them, and Vercel's servers run in UTC, so the same payout read 7:43 AM on Audit and 12:43 AM in the live feed. Every test passed, because the tests and the dev server run in local time. The gallery screenshots showed it. Times are now formatted in the browser, and a test checks that the server HTML carries none.
- **False reports.** The first two traceability rechecks reported every requirement as untested, because of a regex quoting mistake and then a search of file names instead of contents.

## Numbers

Nine specs, eight steering files, seven hooks, one custom agent, and about 450 commits. About 1,630 Vitest tests (unit, property, and integration), with 19 property-test files, and 10 Playwright tests. Lighthouse accessibility, best practices, and SEO 100 on all seven dashboard pages in both themes. One real testnet payment button on the hosted site, live since Nov 17.
