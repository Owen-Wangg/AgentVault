# How Kiro was used (draft)

Draft for the Devpost write-up. Every example below comes from `docs/KIRO_LOG.md`, which has the seeds and numbers.

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
| Kiro powers | Powers and plugins |

## Which Kiro apps

All of the work was done in the Kiro IDE on Windows. <!-- Owen: add CLI, Web, or Crew if you tried any, and how they differed. --> The project's MCP server works with any MCP client, and `docs/MCP.md` also covers Claude Desktop.

## Subagents and custom agents

No custom agents were created for this project. Kiro's built-in introspect subagent checked Kiro's own docs: that a hook's `timeout` belongs on the hook and not the action, and how Kiro confirms and permits MCP tool calls. <!-- Owen: correct this if you made or used a custom agent. -->

## Powers and plugins

The Stripe and Neon plugins were installed. The Stripe plugin's account tools were never authenticated, so nothing read or changed the Stripe account through them. The Neon plugin's MCP server was used once, read-only, to check the project's compute and network usage against the Free plan for the judging period. The Stripe plugin's best-practices skill set the payout-rails Connect design: Accounts v2 recipient accounts, a capability check before each transfer, and no legacy account types. Its docs search, along with docs.stripe.com's Markdown pages, stood in for the Stripe CLI, which isn't installed. Other Stripe research used the published `mppx` and `stripe` packages, and Neon work used the Neon console and `DATABASE_URL_TEST`. <!-- Owen: check that this matches how you think of the plugins. --> Vercel's official MCP server was connected and used read-only (see MCP below).

## Specs first, code second

AgentVault has eight specs in `.kiro/specs/` (money-and-policy-core, audit-and-approvals, rail-adapters, taint-and-intent, telemetry-dashboard, demo-agents, mcp-server, payout-rails). Each has EARS requirements with IDs (`ENV-3`, `TAINT-6`, `HITL-2`), a design with numbered correctness properties, and a task list. Test names start with the requirement ID they cover, so `grep ENV-8` finds the rule, the design, the task, and the tests.

Writing the specs caught design bugs before any code existed:

- **Rounding that favored the agent.** The first plan used banker's rounding to convert micros to Stripe cents. It can round a debit down, so an agent could spend slightly more than its cap. The spec now requires directional rounding: debits round up, refunds round down.
- **A lock held across a blockchain call.** Holding the envelope row lock during an x402 payment would block every other request from that agent for seconds. The design changed to spend reservations committed before the rail call.
- **A demo that couldn't show its own point.** If the prompt-injection task didn't allow `stripe.refund`, intent scope would deny the refund before the taint rule ever ran. The task now allows it, so the hold comes from taint.
- **An approval that could never run.** An approval re-run that reused the original idempotency key would replay the stored "held" response forever. Re-runs use `approval:<id>`.
- **Platform limits.** Vercel Hobby only allows daily cron jobs, so the reconciler also runs after each request with Next.js `after()`.
- **A payout that rounded the wrong way.** `payout.create` was first registered as a debit. A payout sends money out, so the payee's amount must round down to the cent while the envelope counts the full amount.
- **A destination read too early.** If a payout took its destination when it was requested, denying an injected payee change wouldn't help: the held payout would still carry the attacker's account. The spec has payouts read the destination when they run, so denying the change and approving the payout pays the supplier.
- **One visitor's approval leaking into another's demo.** In the shared sandbox, one visitor approving the hijack would leave the supplier pointing at the attacker until the nightly reset. Each payee hijack run now gets its own supplier row.

**Compared to vibe coding.** <!-- Owen: this paragraph is yours to write; some true points to draw on: --> Payment code fails quietly: a rounding direction or a missing lock produces a wrong number, not an error. Vibe coding would have produced working-looking code with those bugs in it. With specs, each rule had an ID, a planned property, and a task before any code, so Kiro implemented one task at a time against a fixed target, and the post-task hook ran the full suite after each one.

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
| spec-trace | Save of a `requirements.md` | Lists requirement IDs with no task or no planned test. It found 13 taint-and-intent IDs and 15 demo-agents IDs that the designs never named, and the new PO-25 missing from the payout-rails tasks and testing strategy. |
| devlog | End of a turn | Appends to `docs/KIRO_LOG.md`, the raw material for this write-up. |

## Property-based tests that found real bugs

Each design's correctness properties became fast-check tests. Some found bugs in code that unit tests had passed:

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
- **The theme boundary.** Kiroween mode must change only styling and copy. A property runs two sandboxes in lockstep, one per theme, and requires identical responses and audit events. A response made to depend on the cookie's length failed it on the first case.

## MCP, both directions

- **Kiro calling AgentVault.** The project's own MCP server (`src/mcp`) ran from Kiro's user-level config over stdio. From a Kiro chat, `agentvault_pay` paid $0.0015 to the weather vendor (allowed), `agentvault_fetch` read the poisoned docs page (labeled untrusted, session tainted), and `agentvault_request_tool` asked for the $480 refund (held with `HELD_TAINTED` and `NEEDS_APPROVAL`). A person then approved it in the dashboard. During that run Kiro noticed that the hold message said "over the approval threshold" while ENV-8 holds at or above it, and the copy was fixed.
- **Kiro debugging the deployment.** The live Gemini run failed on Vercel but not locally. Each run now reports where its time went, and the failed run showed the agent's turn took 754 ms while five parallel drift scores got no answer within 20 s. That led to one retry on timeouts and 5xx errors. With Vercel's MCP server connected (read-only calls, each approved by hand), Kiro found the project and read its runtime logs to confirm the fix: the live normal purchase then finished on Vercel with 5 payments allowed in about 9 s.
- **The introspect subagent** checked Kiro's own docs, for example that a hook's `timeout` belongs on the hook and not the action, and how MCP tool permissions work.

## The live AI agent

The optional Gemini agent (`gemini-3.5-flash-lite`, free tier) runs three scenarios with real model choices, and AgentVault's rules still decide every request. In the live drift run the model sometimes buys GPU time, which is denied with `DENY_INTENT_DRIFT` and `ADVISORY_DRIFT` (score 100). In the live injection run the model reads the poisoned page but has never asked for the $480 refund, so the demo uses the scripted run for the hold. <!-- If the more trusting injection prompt is adopted, say so here. -->

## What Kiro got wrong

- **Parallel batches.** Several times, two edits to one file, or a mutation check's backup and its edit, went out in the same parallel batch. Once the backup captured the mutated file, the restore left the bug in place, and I changed a test twice before reading the code and finding the mutation. The tests caught it before any commit. The working rule is now one dependent step per call.
- **Shell quoting.** PowerShell expanded `${…}` inside a replacement string and turned two `aria-label`s into `" bot"`. A component test's accessible-name query caught it.
- **Calling a failure a one-off.** The end-to-end test's reload loop was first dismissed as a one-off. It came back; the test's dev server now builds into its own folder, which fixed the failures seen so far. The cause is still unknown.
- **Mis-decoded characters.** To commit one change in `copy.ts` apart from another, Kiro rebuilt the file from `git show` output read through PowerShell, which mis-decoded six ellipsis characters, and committed that. A follow-up commit restored them from the earlier commit's bytes. The working rule is now to write `git show` to a file and read it as UTF-8.
- **False reports.** The first two traceability rechecks reported every requirement as untested, because of a regex quoting mistake and then a search of file names instead of contents.

## Numbers

About 1,480 Vitest tests (unit, property, and integration) and 8 Playwright tests; Lighthouse accessibility, best practices, and SEO 100 on the overview in both themes.
