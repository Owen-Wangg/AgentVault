# Social Blitz post: requirements and talking points

## What the rules require (Official Rules, section 4, read 2026-11-16)

- The post must **start with `#KiroweenHackathon26`**, before any other text.
- It must share **your favorite thing about Kiro** and **how it changed the way you approached development**.
- Any public social platform (X, LinkedIn, Instagram, TikTok, and others), posted during the Submission Period (until Dec 4, 2026, 2:00 PM PT).
- Put the post's URL in the submission form. The profile should match your other submission details.
- Judged by the Kiro team on "original thoughts vs AI writing", insights about Kiro, and the quality of any image or video. Only 5 win.

Because the judging rewards original writing, write the post in your own words. The points below are true and specific to this project; pick one or two.

## Talking points (all from KIRO_LOG.md)

- **Specs found bugs before code existed.** Writing the spec for the money core showed that banker's rounding could round a charge down in the agent's favor, and that holding a row lock during a blockchain payment would stall every other request from that agent.
- **A hook that applies the project's idea to Kiro itself.** AgentVault stops an agent from doing risky things after it reads untrusted input. The guard-shell hook does the same for Kiro's own shell: no recursive force deletes, no force pushes, no reading `.env` files. It blocked Kiro several times.
- **Property tests from the spec.** Each design lists correctness properties, and Kiro turned them into fast-check tests. One generated a vendor named `__proto__` and found a payment allowed past a $0 daily cap, because Zod's `z.record` silently drops that key.
- **Kiro as the agent.** Kiro connected to the project's own MCP server, paid for a forecast, read a poisoned page, and asked for a $480 refund. AgentVault held it, and Kiro had no tool to approve it.
- **The spec caught a demo bug before the scenario existed.** While planning the Payee hijack, writing the spec showed that in a shared sandbox one visitor approving the hijack would redirect every later visitor's payout until the nightly reset. Each run now gets its own supplier.
- **Probes before adapters.** The payout-rails spec required measuring each rail first. PayPal's real behavior contradicted its docs (a resent batch is refused, not replayed), and the design changed before any adapter code was written.
- **Kiro reading its own hosting bill.** Through the Neon MCP server, Kiro read the project's compute usage. From that and the published free-plan rates, it estimated that one forgotten dashboard tab could use up the free plans before judging ends. The fix (pause the live stream when nobody is watching) went into the spec first.
- **What changed in how you work:** for example, writing requirements with IDs first and letting every test name start with one, or breaking each safeguard on purpose to prove a test catches it.

## Asset ideas

A 10 to 20 second screen clip of the Payee hijack (both holds, deny the account change, approve the payout, "Paid out to" the supplier), the held $480 refund, the runaway loop's freeze, or the Kiro chat calling the MCP tools.
