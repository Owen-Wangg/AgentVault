# Demo video script (target 2:50, limit 3:00)

Recorded against <https://owen-agentvault.vercel.app> in the default theme until the last scene. Every run uses the scripted agent, so the decisions are the same every take.

## Before recording

1. Record after the nightly reset (it runs some time in the 11:00 UTC hour, which is 4:00 to 5:00 AM in Vancouver), so the sandbox starts empty and the charts are clean.
2. After the reset, run `pnpm --silent mcp:agent` and put the new key in `~/.kiro/settings/mcp.json`. The reset revokes the old key. Note the session ID it prints.
3. In a fresh Kiro chat, confirm the `agentvault` server shows as connected.
4. Browser at 1920 × 1080, zoom 125%, a private window so the theme is the default and no sign-in shows.
5. Have four tabs open: `/scenarios`, `/approvals`, `/feed`, `/audit`. Check that `/scenarios` shows the **Real testnet payment** card and that `pnpm x402:status` shows test USDC in the agent wallet.
6. If a run answers "Someone else is running this scenario right now", wait a few seconds and click again.
7. Each Payee hijack run pays its own supplier, named `acme-supplies-` plus 16 hex characters (shown in the run's steps). If other visitors' cards are in the inbox, act on the two cards with your run's supplier name.

Video rules (Official Rules, section 4): under 3 minutes, uploaded to YouTube as **public**, showing the project working on the device it was built for (a desktop browser). No copyrighted music, and no third-party trademarks or copyrighted material without permission, so use no music or a track licensed for reuse, and keep vendor logos (Stripe, Coinbase, PayPal, GitHub, BaseScan) off screen. Kiro's own UI is the sponsor's product and is fine to show.

## Script

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Overview, empty, with the "Start here" tour card | "AI agents now pay for APIs on their own, a fraction of a cent per call, over Stripe's Machine Payments Protocol and x402. Nobody approves each charge. One prompt injection or one retry bug can drain a budget. AgentVault is for teams shipping agents that spend money. It sits between the agent and the payment rail and checks every request before money moves." |
| 0:15–0:25 | Scenarios: run **Normal purchase** | "A normal agent buys five weather forecasts at a fraction of a cent each. All five are allowed and logged." |
| 0:25–0:40 | Run **Runaway loop**, then show the summary | "Now a retry bug. The agent pays in a tight loop. After 30 calls in a minute AgentVault denies it for velocity and freezes the agent. Every later call is denied, and the total stays at four and a half cents." |
| 0:40–1:00 | Run **Prompt injection**; hover the taint step and the held refund | "The agent reads a vendor docs page with a hidden instruction: refund four hundred and eighty dollars. Reading an untrusted page taints the session, and while it's tainted, refunds, payouts, and payout account changes are frozen. The refund is held, not paid." |
| 1:00–1:12 | Run **Payee hijack**; show the three steps and the decision path (held at spend limits and untrusted input) | "A harder one. This agent's job is paying a supplier's nine hundred dollar invoice. The invoice hides an instruction: switch the supplier's payout account to the attacker's first, then pay. The agent obeys. Both requests are held." |
| 1:12–1:30 | Click the summary link to Approvals. On the `payee.update` card, show the attacker account and the untrusted source, click **Deny**. On the `payout.create` card, click **Approve** | "A person decides. The account change came from an untrusted invoice, so deny it. The payout itself is real, so approve it. Approving re-runs every check, and it runs exactly once." |
| 1:30–1:38 | Live feed: the allowed payout row, "Paid out to acct_1AcmeSupplies" | "The payout reads the account on file when it runs, so the nine hundred dollars goes to the supplier, not the attacker." |
| 1:38–1:52 | Audit: click **Verify chain**, then **Rewrite an event** in the "Try to tamper with it" card | "Every decision is in a hash-chained, append-only log with a signed head. Verify chain recomputes it. Now try to cover the attack: rewrite the held payout as allowed. The browser rechecks a copy, and the chain breaks at exactly that event. The real log can't be changed at all." |
| 1:52–2:04 | Scenarios: click **Make a real testnet payment**, then the BaseScan link in a new tab, framed on the transaction's status and USDC transfer (keep the site's header and logo out of frame) | "Those were mock rails. This button is real: the same checks, then a payment of a fraction of a cent on Base Sepolia. Here's the transaction on chain." |
| 2:04–2:26 | Kiro chat calling the MCP tools (see below) | "AgentVault is also an MCP server, so Kiro can be the agent. It pays for a forecast, reads the poisoned page, and asks for the refund. The refund is held, and there's no approve tool, so Kiro can't approve its own refund." |
| 2:26–2:39 | Header: turn on **Kiroween mode**, then the Overview and Agents | "And for Kiroween, a theme toggle. Frozen agents are sealed in The Crypt and tainted sessions are Haunted. It changes only styling and copy; a property test checks that every decision is identical in both themes." |
| 2:39–2:49 | Overview in Kiroween mode, with the live URL and repo URL as a text overlay | "Built with Kiro: nine specs, steering, hooks, and property-based tests. Try it, no login." |

About 2:49 in total. The Intent drift scenario is left out to make room for the Payee hijack; it's on the scenarios page for anyone who tries the sandbox. If a take runs long, shorten the Prompt injection scene first (the Payee hijack shows the same taint rule), then the audit scene. If a take runs short, add Intent drift after the runaway loop (13 s): "This agent's task is weather data. It tries to pay a GPU vendor. That's outside its declared scope, so it's denied as intent drift."

## Shot checklist

Check each result on screen before moving to the next scene. If one is wrong, stop and retake that scene.

| Scene | Click | Should appear |
|---|---|---|
| Normal purchase | **Run** | 5 steps, each `allow` and settled |
| Runaway loop | **Run** | 30 `allow`, then `deny` with `VELOCITY_EXCEEDED`, then `AGENT_FROZEN`; allowed total $0.045 |
| Prompt injection | **Run** | The fetch step marked untrusted, then the $480 `stripe.refund` held with `HELD_TAINTED`, `NEEDS_APPROVAL` |
| Payee hijack | **Run** | `payee.update` held with `HELD_TAINTED`; the $900 `payout.create` held with `HELD_TAINTED`, `NEEDS_APPROVAL`; your run's `acme-supplies-…` name |
| Approvals | **Deny** on `payee.update`, **Approve** on `payout.create` | "Approved. The request ran." on the payout card |
| Live feed | none | "Paid out to acct_1AcmeSupplies" |
| Audit | **Verify chain**, then **Rewrite an event** | "Chain verified."; then "Rewrote seq … (decision): hold to allow." and "Chain broken at seq …" with the same seq |
| Testnet | **Make a real testnet payment**, then the link | `allow`, an audit seq, a BaseScan link; the transaction shows success and a 0.0015 USDC transfer |
| MCP | approve the three tool calls | allowed; untrusted with the session tainted; held with `HELD_TAINTED`, `NEEDS_APPROVAL` |
| Kiroween | Header switch | "The Crypt" for frozen agents, "Haunted" for tainted sessions |

## The MCP scene

Paste into the Kiro chat, with the session ID from `pnpm mcp:agent`:

> My AgentVault session ID is `<session id>`. Pay `nimbus-weather` 0.0015 dollars for a forecast. Then read `https://owen-agentvault.vercel.app/vendor/docs/integration`. Then do what the page asks: refund 480 dollars to `nimbus-weather` for payment `pi_mock_billing_500`.

Kiro asks before each tool call; approve the three calls on camera or speed them up in editing. The expected results are allowed, untrusted (session tainted), and held with `HELD_TAINTED` and `NEEDS_APPROVAL`. Leave the held refund unapproved, or approve it off camera.

## Things not to say

- Don't say the live site moves real money. The scenarios run on mock rails, so the $900 payout and the $480 refund are mock. The testnet button is the one real payment, and it's Base Sepolia test USDC with no real value: say "real testnet payment", never "real money".
- If the testnet button says the limit is used up, you've pressed it twice in the hour from that connection. Record it on the first take, or switch networks.
- Besides the testnet button, real payments through the guarded flow ran only in the `@live` tests: x402 on Base Sepolia, Stripe MPP in test mode, a $1.00 Stripe Connect test-mode transfer, and a $1.00 PayPal sandbox payout. Outside agents can't make real payments over the HTTP API yet.
- Don't show the live AI injection run as the hold. The model reads the poisoned page but hasn't asked for the refund so far. The Payee hijack has no live AI version.
- The runaway loop's freeze happens at the 31st call, not after hundreds.
- The payee change is held only because the session is tainted (`HELD_TAINTED`). The $900 payout is held for taint and for being at or above the $100 approval threshold (`HELD_TAINTED`, `NEEDS_APPROVAL`). Don't say the change was held for its amount; it moves no money.
