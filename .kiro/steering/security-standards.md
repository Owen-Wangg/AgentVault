---
inclusion: always
---

# Security Standards

These rules apply to every file in the repo. When a rule conflicts with convenience, the rule wins. When unsure, fail closed.

## 1. Money is integer micros
- Every monetary value is a `bigint` count of **micros**: 1 USD = 1,000,000 micros. This matches USDC's 6 decimal places and represents sub-cent MPP and x402 charges exactly.
- Field names: `amount_micros` in the database and JSON, `amountMicros` in TypeScript. Type: the branded `Micros` type from `@/core/money`.
- Floats never touch money. Banned on any amount: `parseFloat`, `Number(...)`, unary `+`, `.toFixed()`, `Math.round/floor/ceil`, `/` on `number`, and `number`-typed amount fields.
- JSON on the wire carries amounts as **decimal strings of integer micros** (`"1500"`), because JSON has no `bigint`.
- Conversion to rail units (Stripe cents) happens only inside `src/rails/**`, through `toRailUnits()`. The server counts amounts with `chargeableMicros()`, which never counts less than requested. Details in `money-arithmetic.md`.
- Negative amounts are rejected at the boundary. Refunds are a separate operation, not a negative charge.

## 2. Checks before any payment executes
Every pay or high-privilege tool request goes through these steps, in this order, inside **one database transaction**:
1. **Authenticate** the agent: bearer API key, hashed with SHA-256 and compared with `crypto.timingSafeEqual`.
2. **Validate** the request with Zod. Reject unknown fields.
3. **Lock** the agent's envelope row (`SELECT … FOR UPDATE`) so concurrent requests can't both pass a cap, then claim the `Idempotency-Key`.
4. **Load state**: rolling window spend, call velocity, session taint, task scope.
5. **Evaluate** with the pure function `evaluate()` from `@/core/policy`. Result: `allow`, `hold`, or `deny` with reason codes.
6. **Audit**: append the decision to `audit_events` *before* executing.
7. **Reserve** the amount in `spend_reservations` if the decision is `allow`, then **commit**. The rail call happens after the commit, never while holding the lock.
8. **Execute** on the rail only if the decision is `allow`, using an idempotency key.
9. **Audit** the rail result: `settled` with the rail reference, `failed` with the typed code, or `unknown`.

Rules:
- **Fail closed.** Any error in steps 1–7 means no execution. A rail is never called without a prior audit row.
- **Precedence:** any `deny` reason beats any `hold` reason, which beats `allow`.
- **Frozen agents:** the frozen flag is read after the envelope lock. Every request from a frozen agent is `deny` with `AGENT_FROZEN`.
- **Idempotency:** a repeated `Idempotency-Key` with the same body returns the original result and never charges twice. The same key with a different body returns HTTP 422. Keys are kept for 24 hours per agent.
- **Uncertain outcomes keep the money counted.** A rail timeout or unreadable response is recorded as `unknown`, and the reservation stays until the reconciler resolves it. Only a confirmed failure releases a reservation. The reconciler only looks outcomes up and never starts a new payment.
- LLM output (such as a Gemini drift score) is **advisory only**. It may add a `hold`, but it can never turn a `deny` or `hold` into an `allow`.

## 3. Untrusted input and taint tracking
- Agents get web content only through `/api/v1/fetch`, which labels each response by origin:
  - `trusted`: the origin is on the workspace allow-list.
  - `untrusted`: anything else, including vendor docs, scraped pages, and tool output from unknown sources.
- Reading `untrusted` content **taints the session**. Taint is sticky: it lasts until the session ends. Nothing an agent sends can clear it.
- **High-privilege tools** are frozen in a tainted session. A call to any of them returns `hold` with `HELD_TAINTED` and goes to the approvals inbox:
  - `stripe.refund`
  - `wire_transfer`
  - `payout.create`
  - `payee.update`
  - Any tool flagged `privileged: true` in the tool registry.
- The audit event for a taint records the source URL and a SHA-256 hash of the content, never the raw content.
- Never execute, `eval`, or render as HTML any fetched content. Display it as escaped text.

## 4. Intent scope
- Every agent session runs under a **task** with a declared scope: allowed vendor categories, allowed tools, and a task budget in micros.
- A payment to a vendor outside the scope's categories, or a tool outside its tool list, is `deny` with `DENY_INTENT_DRIFT`.
- Spend beyond the task budget is `deny` with `OVER_TASK_BUDGET`.

## 5. Human-in-the-loop approvals
- A `hold` creates an approval record with an expiry (default 15 minutes).
- Approving **re-runs** the full check (steps 3–9) with the approval attached. If the request now fails another rule, it does not execute.
- An approval executes at most once. Approve-after-expiry and double-approve are rejected.
- Outside the sandbox, only a signed-in member of the workspace can approve, deny, or unfreeze. In the public sandbox anyone may, and the sandbox only ever uses mock rails.
- Approval and unfreeze endpoints reject agent API keys (any bearer header) with HTTP 403, in every workspace including the sandbox. The MCP server has no approve or unfreeze tools.
- Expiry is applied whenever approvals are read or acted on, and each expired approval gets exactly one `approval_expired` audit event.

## 6. Audit log
- `audit_events` is append-only. A row-level Postgres trigger rejects `UPDATE` and `DELETE`, and a statement-level trigger rejects `TRUNCATE`.
- Each row stores `prev_hash` and `hash = sha256(prev_hash || canonical_json(event))`, chained per workspace. The canonical JSON rules are CJ-1 to CJ-8 in `audit-and-approvals/requirements.md`.
- Each append also updates the workspace's HMAC-signed chain head (`audit_heads`), so rows deleted from the end of the chain are detected.
- `verifyChain()` must detect any edited, deleted, or reordered row, or a missing tail, and report the first broken row.
- Never delete audit rows to reset anything. The sandbox is reset by creating a new sandbox workspace.
- Never log secrets, API keys, full card data, wallet private keys, or raw fetched content.

## 7. Secrets and environments
- Secrets live only in environment variables (`.env.local` locally, Vercel settings in production). Commit only `.env.example` with placeholders.
- **Testnet and test mode only.** Code must refuse to start if `STRIPE_SECRET_KEY` starts with `sk_live_`, or if the x402 network is not `eip155:84532`.
- The agent wallet private key is a testnet-only key. Never log it or send it to the client.
- Nothing secret goes in the client bundle. Only `NEXT_PUBLIC_*` variables reach the browser, and none of them may be secret.

## 8. Trust boundaries
- Validate with Zod at every boundary: HTTP requests, rail responses, MCP tool inputs, LLM tool-call arguments, and environment variables at startup.
- Use parameterized queries only (Drizzle does this). No string-built SQL.
- Rate-limit public endpoints (sandbox, scenario runner).
- Return generic error messages to clients. Put details in the server log, without secrets.

## Examples

Bad:
```ts
const total = parseFloat(req.body.amount) * 100; // float money, unvalidated
if (session.tainted && tool === "stripe.refund") console.warn("risky"); // warns but executes
await stripe.refunds.create({ payment_intent: id }); // no audit row first
```

Good:
```ts
const body = PayRequestSchema.parse(await req.json());   // amount_micros: "1500" -> 1500n
const decided = await withEnvelopeLock(agent.id, async (tx, state) => {
  const decision = evaluate(body, state.envelope, state.window, state.session, state.scope);
  const seq = await appendEvent(tx, { type: "decision", decision, request: body });
  const reservation = decision.decision === "allow" ? await reserve(tx, body, seq) : null;
  return { decision, reservation };
}); // committed: the lock is released before any network call
if (!decided.reservation) return decided.decision;
return executeOnRail(body, decided.reservation, { idempotencyKey: body.idempotencyKey }); // settles, releases, or keeps it as unknown
```
