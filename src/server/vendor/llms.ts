import { toDisplay } from "@/core/money";
import { REPORT_DESCRIPTION, REPORT_PATH, REPORT_PRICE } from "./report";

/**
 * The text served at /llms.txt (rail-adapters RAIL-26), for agents and the
 * people who build them. Built from the same constants as the routes, so
 * the paid report's path and price can't drift from the endpoint. It names
 * no secret, key, or account.
 */
export function llmsText(): string {
  return `# AgentVault

> A security proxy between AI agents and payment rails. Every payment and high-privilege tool call is checked against spend limits, untrusted-input (taint) rules, and the task's declared scope before any money moves. Each decision is allow, hold, or deny, with reason codes, and is recorded in a hash-chained audit log.

Everything here runs on testnets, test mode, sandboxes, or mock rails. The public sandbox uses mock rails only, needs no login, and starts fresh every night.

## Agent API

Agents call these with a bearer API key. Pay and tool requests also take an \`Idempotency-Key\` header; a repeat with the same body returns the first result and never pays twice. Amounts are decimal strings of integer micros (1 USD = 1,000,000 micros), for example "1500" for $0.0015.

- [POST /api/v1/pay](/api/v1/pay): pay a vendor over x402 (\`x402.pay\`) or Stripe MPP (\`mpp.pay\`).
- [POST /api/v1/tool](/api/v1/tool): request a high-privilege tool: \`stripe.refund\`, \`wire_transfer\`, \`payout.create\`, \`paypal.payout\`, or \`payee.update\`. In a session that has read untrusted content, these are held for a person to approve.
- [POST /api/v1/fetch](/api/v1/fetch): read a web page through AgentVault. The response is labeled trusted or untrusted by origin, and untrusted content taints the session until it ends.
- [MCP server, Streamable HTTP](/api/mcp): the same three actions as the tools \`agentvault_pay\`, \`agentvault_fetch\`, and \`agentvault_request_tool\`. There are no approve or unfreeze tools; a person does those in the dashboard.

Agent keys can't approve, deny, or unfreeze anything. Those endpoints refuse any bearer header.

## Demo vendor

- [GET ${REPORT_PATH}](${REPORT_PATH}): ${REPORT_DESCRIPTION}, ${toDisplay(REPORT_PRICE)} per call over the Machine Payments Protocol (Stripe test mode). It answers 402 Payment Required with an MPP challenge.
- [GET /openapi.json](/openapi.json): the MPP discovery document for the paid endpoint.
- [GET /vendor/api/weather](/vendor/api/weather): a weather forecast paid per call over x402 on Base Sepolia.

## Try it

- [Scenarios](/scenarios): scripted agents that show a normal purchase, a runaway loop, a prompt injection, intent drift, and a payee hijack.
- [Approvals](/approvals): held requests waiting for a person.
- [Audit](/audit): the audit log and its chain check.

## Source

- [GitHub: Owen-Wangg/AgentVault](https://github.com/Owen-Wangg/AgentVault), Apache-2.0.
`;
}
