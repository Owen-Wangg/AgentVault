import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { type Micros, fromDecimalString, toMicrosString } from "@/core/money";

/**
 * The live agent's tools (demo-agents AGT-12): fetch_url, pay, and
 * request_tool, each one AgentVault API call. Every argument the model
 * sends is validated with Zod before anything is called (AGT-13).
 *
 * Amounts are dollar strings ("0.0015"), parsed exactly with
 * fromDecimalString. A JSON number is rejected, so a float never becomes
 * money (security-standards §1).
 */

export const TOOL_NAMES = ["fetch_url", "pay", "request_tool"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const DOLLARS = /^\d{1,9}(\.\d{1,6})?$/;

const Dollars = z
  .string()
  .regex(DOLLARS, 'must be a dollar amount as a string, like "0.0015" or "480.00"')
  .transform((s, ctx): Micros => {
    try {
      return fromDecimalString(s);
    } catch {
      ctx.addIssue({ code: "custom", message: "is not a valid dollar amount" });
      return z.NEVER;
    }
  });

/** Vendor names in the registry are lowercase words with hyphens, like nimbus-weather. */
const Vendor = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a vendor name from the catalog, like nimbus-weather");
/** Same as the tool route's references (src/server/tools/tool-handler.ts). */
const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, "must be 1 to 255 letters, digits, _ or -");

const FetchArgs = z.strictObject({ url: z.string().min(1).max(2048) });
const PayArgs = z.strictObject({ vendor: Vendor, amount_usd: Dollars });
const RequestToolArgs = z.strictObject({
  tool: z.string().regex(/^[a-z0-9_.]{1,64}$/, "must be a tool name like stripe.refund"),
  vendor: Vendor,
  amount_usd: Dollars,
  payment_ref: Ref.optional(),
  payee_ref: Ref.optional(),
});

export type ToolCall =
  | { name: "fetch_url"; url: URL }
  | { name: "pay"; vendor: string; amountMicros: Micros }
  | { name: "request_tool"; tool: string; vendor: string; amountMicros: Micros; args: Record<string, string> };

export type ParsedCall = { ok: true; call: ToolCall } | { ok: false; error: string };

const issuesOf = (error: z.ZodError) => error.issues.map((i) => `${i.path.map(String).join(".") || "args"} ${i.message}`).join("; ");

/**
 * AGT-13: validate one function call from the model. `vendorOrigin` is
 * the deployment's origin: fetch_url may only read pages there, so a
 * prompt can't make the server fetch arbitrary hosts on the demo's behalf.
 */
export function parseToolCall(name: string, args: unknown, vendorOrigin: string): ParsedCall {
  switch (name) {
    case "fetch_url": {
      const a = FetchArgs.safeParse(args);
      if (!a.success) return { ok: false, error: issuesOf(a.error) };
      let url: URL;
      try {
        url = new URL(a.data.url, vendorOrigin);
      } catch {
        return { ok: false, error: "url is not a valid URL" };
      }
      if (url.origin !== new URL(vendorOrigin).origin || url.username || url.password) {
        return { ok: false, error: `url must be a page on ${new URL(vendorOrigin).origin}` };
      }
      return { ok: true, call: { name, url } };
    }
    case "pay": {
      const a = PayArgs.safeParse(args);
      if (!a.success) return { ok: false, error: issuesOf(a.error) };
      return { ok: true, call: { name, vendor: a.data.vendor, amountMicros: a.data.amount_usd } };
    }
    case "request_tool": {
      const a = RequestToolArgs.safeParse(args);
      if (!a.success) return { ok: false, error: issuesOf(a.error) };
      const { tool, vendor, amount_usd: amountMicros, payment_ref: paymentRef, payee_ref: payeeRef } = a.data;
      // The tool route's per-tool schemas decide which of these the tool takes.
      const toolArgs: Record<string, string> =
        tool === "payee.update"
          ? { vendor, ...(payeeRef ? { payee_ref: payeeRef } : {}) }
          : { vendor, amount_micros: toMicrosString(amountMicros), ...(paymentRef ? { payment_ref: paymentRef } : {}) };
      return { ok: true, call: { name, tool, vendor, amountMicros, args: toolArgs } };
    }
    default:
      return { ok: false, error: `unknown tool ${JSON.stringify(name.slice(0, 64))}; use fetch_url, pay, or request_tool` };
  }
}

/** The declarations sent to Gemini. Strings only, so amounts arrive as text. */
export const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "fetch_url",
    description: "Read a web page through AgentVault. Returns the page text and whether AgentVault trusts its origin.",
    parametersJsonSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The full URL of the page." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "pay",
    description: "Pay a vendor for one API call with x402, through AgentVault. Returns AgentVault's decision: allow, hold, or deny.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "The vendor's name from the catalog, like nimbus-weather." },
        amount_usd: { type: "string", description: 'The price in US dollars as a decimal string, like "0.0015".' },
      },
      required: ["vendor", "amount_usd"],
      additionalProperties: false,
    },
  },
  {
    name: "request_tool",
    description:
      "Run a privileged billing tool through AgentVault, such as stripe.refund. Returns AgentVault's decision: allow, hold (waiting for a person), or deny.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The tool name, like stripe.refund." },
        vendor: { type: "string", description: "The vendor the tool acts for, like nimbus-weather." },
        amount_usd: { type: "string", description: 'The amount in US dollars as a decimal string, like "25.00".' },
        payment_ref: { type: "string", description: "For stripe.refund: the payment to refund, like pi_123." },
        payee_ref: { type: "string", description: "For payee.update: the new payee." },
      },
      required: ["tool", "vendor", "amount_usd"],
      additionalProperties: false,
    },
  },
];
