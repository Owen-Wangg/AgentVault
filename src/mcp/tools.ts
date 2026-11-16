import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AgentApiError, AgentClient, type DecisionResult, type FetchResult } from "@/agents/client";
import { type Micros, fromDecimalString, toMicrosString } from "@/core/money";
import { type UiKey, reasonText, t } from "@/ui/copy";

/**
 * The AgentVault MCP tools (mcp-server MCP-1 to MCP-5, MCP-7, MCP-11,
 * MCP-12), shared by the stdio server and /api/mcp. Each tool call
 * becomes one request to AgentVault's agent API through AgentClient, so
 * it gets exactly the checks, audit trail, and idempotency an HTTP agent
 * gets. The transport decides where those requests go: over HTTPS for
 * stdio, or straight to the route handlers for /api/mcp.
 *
 * There is no approve, deny, or unfreeze tool (MCP-11): agent keys can't
 * do those (HITL-10), and leaving them out keeps the model from trying.
 *
 * Results are written for the client's model in the default theme's
 * copy. They never carry the API key.
 */

export const TOOL_NAMES = ["agentvault_pay", "agentvault_fetch", "agentvault_request_tool"] as const;

export interface McpToolOptions {
  /** AgentVault's origin, for API requests and the dashboard link in held results. */
  baseUrl: string;
  /** The agent API key. Without one, every tool call fails with an authentication error and sends nothing (MCP-7). */
  apiKey: string | undefined;
  /** Where API requests go. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch, for generated idempotency keys. */
  now?: () => number;
  /** Per API request. Defaults to AgentClient's 15 s. */
  timeoutMs?: number;
}

/** Generated idempotency keys repeat within this window, so a resent call is a replay (PXY-12). */
export const IDEMPOTENCY_BUCKET_MS = 60_000;

const SessionId = z.uuid().describe("The AgentVault session this agent works in. Its task sets the vendors, tools, and budget allowed.");
const IdempotencyKey = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, "must be 1 to 255 printable characters")
  .refine((key) => !key.toLowerCase().startsWith("approval:"), "must not start with approval:")
  .optional()
  .describe("Reuse the same key to retry the same request. Omit it to have one generated from the input.");

const PayInput = z.strictObject({
  vendor: z.string().min(1).max(200).describe("The vendor's name in AgentVault, like nimbus-weather."),
  amount: z.string().min(1).max(40).describe('Dollars as a decimal string with at most 6 decimal places, like "0.0015".'),
  rail: z.enum(["x402", "mpp"]).optional().describe("x402 (USDC) or mpp (Stripe). Defaults to x402."),
  session_id: SessionId,
  idempotency_key: IdempotencyKey,
});

const FetchInput = z.strictObject({
  url: z.string().min(1).max(2048).describe("The http or https URL to read."),
  session_id: SessionId,
});

const RequestToolInput = z.strictObject({
  tool: z.string().regex(/^[\x21-\x7e]{1,100}$/, "must be 1 to 100 printable characters").describe("The tool, like stripe.refund, wire_transfer, payout.create, or payee.update."),
  args: z
    .record(z.string(), z.unknown())
    .describe('The tool\'s arguments, like { "vendor": "nimbus-weather", "amount": "480", "payment_ref": "pi_123" }. Give amounts in dollars as "amount".'),
  session_id: SessionId,
  idempotency_key: IdempotencyKey,
});

const DecisionOutput = z.object({
  decision: z.enum(["allow", "hold", "deny"]),
  reasons: z.array(z.string()).describe("Reason codes, like HELD_TAINTED."),
  explanation: z.string(),
  idempotency_key: z.string().describe("The key this request used. Reuse it to retry."),
  approval_id: z.string().optional(),
  approve_at: z.string().optional().describe("Where a person approves or denies a held request."),
  rail_status: z.enum(["settled", "failed", "unknown"]).optional(),
  rail_ref: z.string().optional(),
});

const FetchOutput = z.object({
  label: z.enum(["trusted", "untrusted"]),
  url: z.string(),
  notice: z.string(),
  body: z.string(),
});

/** JSON with sorted keys, so the same input always hashes the same. Not for audit hashing. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The idempotency key for a call that didn't send one: a hash of the tool,
 * its input, and the current minute. The same call resent within the
 * minute replays the first result instead of paying twice; the same input
 * in a later minute is a new request.
 */
export function generatedIdempotencyKey(tool: string, input: unknown, nowMs: number): string {
  const bucket = Math.floor(nowMs / IDEMPOTENCY_BUCKET_MS);
  return `mcp_${createHash("sha256").update(stableJson({ tool, input, bucket })).digest("hex").slice(0, 40)}`;
}

const text = (s: string) => ({ type: "text" as const, text: s });

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [text(message)] };
}

/** What went wrong, for a call that got no decision. Only codes, never the key or a stack. */
function failureOf(error: unknown): CallToolResult {
  if (error instanceof AgentApiError) {
    if (error.status === 401) return errorResult(t("mcp.authError", "default"));
    if ([400, 403, 404, 409, 413, 422].includes(error.status)) return errorResult(`${t("mcp.rejected", "default")} (${error.status} ${error.code})`);
  }
  return errorResult(t("mcp.unavailable", "default"));
}

/** A decision as the tool result (MCP-3, MCP-4, MCP-12). Decisions are results, not errors. */
export function decisionResult(d: DecisionResult, idempotencyKey: string, baseUrl: string): CallToolResult {
  const parts = d.reasons.map((r) => reasonText(r.code, "default"));
  const add = (key: UiKey) => parts.push(t(key, "default"));
  if (d.decision === "allow") add("mcp.allowed");
  if (d.decision === "hold") add("mcp.held");
  if (d.decision === "deny") add("mcp.denied");
  if (d.railStatus === "failed") add("mcp.railFailed");
  if (d.railStatus === "unknown") add("mcp.unknown");
  const result: z.infer<typeof DecisionOutput> = {
    decision: d.decision,
    reasons: d.reasons.map((r) => r.code),
    explanation: parts.join(" "),
    idempotency_key: idempotencyKey,
    ...(d.approvalId ? { approval_id: d.approvalId, approve_at: new URL("/approvals", baseUrl).toString() } : {}),
    ...(d.railStatus ? { rail_status: d.railStatus } : {}),
    ...(d.railRef ? { rail_ref: d.railRef } : {}),
  };
  return { content: [text(JSON.stringify(result, null, 2))], structuredContent: result };
}

/** A fetched page as the tool result, with its label first (MCP-5). */
export function fetchResult(page: FetchResult): CallToolResult {
  const notice = t(page.label === "trusted" ? "mcp.trusted" : "mcp.untrusted", "default");
  const result: z.infer<typeof FetchOutput> = { label: page.label, url: page.url, notice, body: page.body };
  return {
    content: [text(`[${page.label.toUpperCase()}] ${notice}\nURL: ${page.url}`), text(page.body)],
    structuredContent: result,
  };
}

class InvalidAmount extends Error {}

const dollars = (amount: string): Micros => {
  try {
    return fromDecimalString(amount);
  } catch {
    throw new InvalidAmount();
  }
};

/**
 * Tool arguments as the API takes them: a dollar `amount` becomes
 * `amount_micros`. Anything else is passed on for the server's strict
 * per-tool schema to check.
 */
function toolArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(args, "amount")) return args;
  if (Object.hasOwn(args, "amount_micros")) throw new InvalidAmount();
  const { amount, ...rest } = args;
  if (typeof amount !== "string") throw new InvalidAmount();
  return { ...rest, amount_micros: toMicrosString(dollars(amount)) };
}

export function createAgentVaultMcpServer(options: McpToolOptions): McpServer {
  const server = new McpServer({ name: "agentvault", version: "0.1.0" });
  const now = options.now ?? Date.now;
  const clientFor = (apiKey: string, sessionId: string) =>
    new AgentClient(options.baseUrl, apiKey, sessionId, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });

  /** Runs one call: no key means no request at all (MCP-7); anything thrown becomes an error result. */
  const guard = async (run: (apiKey: string) => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (!options.apiKey) return errorResult(t("mcp.authError", "default"));
    try {
      return await run(options.apiKey);
    } catch (error) {
      if (error instanceof InvalidAmount) return errorResult(t("mcp.invalidAmount", "default"));
      return failureOf(error);
    }
  };

  server.registerTool(
    "agentvault_pay",
    {
      title: "Pay a vendor through AgentVault",
      description:
        "Pay a vendor for an API call. AgentVault checks the agent's spend limits, the task's scope, and the session's taint before any money moves, and answers allow, hold, or deny with the reasons.",
      inputSchema: PayInput,
      outputSchema: DecisionOutput,
    },
    (input) =>
      guard(async (apiKey) => {
        const amount = dollars(input.amount);
        const key = input.idempotency_key ?? generatedIdempotencyKey("agentvault_pay", { ...input, idempotency_key: undefined }, now());
        const tool = input.rail === "mpp" ? "mpp.pay" : "x402.pay";
        const decision = await clientFor(apiKey, input.session_id).pay(input.vendor, amount, key, tool);
        return decisionResult(decision, key, options.baseUrl);
      }),
  );

  server.registerTool(
    "agentvault_fetch",
    {
      title: "Read a web page through AgentVault",
      description:
        "Read a URL through AgentVault, which labels the content trusted or untrusted. Reading untrusted content taints the session: refunds, payouts, wire transfers, and payee changes then need a person's approval.",
      inputSchema: FetchInput,
      outputSchema: FetchOutput,
    },
    (input) => guard(async (apiKey) => fetchResult(await clientFor(apiKey, input.session_id).fetch(input.url))),
  );

  server.registerTool(
    "agentvault_request_tool",
    {
      title: "Request a high-privilege tool through AgentVault",
      description:
        "Ask AgentVault to run a high-privilege tool such as stripe.refund, wire_transfer, payout.create, or payee.update. It gets the same checks as a payment; in a tainted session it is held for a person to approve.",
      inputSchema: RequestToolInput,
      outputSchema: DecisionOutput,
    },
    (input) =>
      guard(async (apiKey) => {
        const args = toolArgs(input.args);
        const key = input.idempotency_key ?? generatedIdempotencyKey("agentvault_request_tool", { ...input, idempotency_key: undefined }, now());
        const decision = await clientFor(apiKey, input.session_id).tool(input.tool, args, key);
        return decisionResult(decision, key, options.baseUrl);
      }),
  );

  return server;
}
