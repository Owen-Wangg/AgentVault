import { z } from "zod";
import { type Micros, MicrosSchema, micros } from "@/core/money";
import { PAYOUT_RAILS, isDestinationFor } from "@/rails/destination";
import { idempotencyKeyOf, invalidIdempotencyKey, json, parseBody, withAgent } from "@/server/http/agent-route";
import { type GuardedBody, runGuardedRequest } from "@/server/payments/guarded";
import { AdvisoryDriftScoreSchema, type PayDeps, defaultPayDeps, scheduleReconcile } from "@/server/payments/pay-handler";
import { PAY_TOOLS, findTool } from "./registry";

/**
 * POST /api/v1/tool (taint-and-intent TAINT-6 to TAINT-9). Body:
 * `{ tool, session_id, args }` with header `Idempotency-Key`. Every
 * request goes through runGuardedRequest, so tools get the same envelope,
 * intent, and taint checks and the same audit trail as payments.
 *
 * Each registered tool has a strict argument schema. A tool that isn't in
 * the registry still needs a vendor and an amount, so the request can be
 * audited, and is then denied with TOOL_NOT_ALLOWED (TAINT-8). Plain
 * payments (x402.pay, mpp.pay) belong on /api/v1/pay and get 400 here.
 */

export type ToolDeps = PayDeps;
export const defaultToolDeps = defaultPayDeps;

const Vendor = z.string().min(1).max(200);
/** A rail or payee reference such as a PaymentIntent ID: letters, digits, `_`, and `-`. */
const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, "must be 1 to 255 letters, digits, _ or -");
const Money = { vendor: Vendor, amount_micros: MicrosSchema };

/** What each registered tool takes, mapped to the guarded request. */
const TOOL_ARGS = {
  "stripe.refund": z
    .strictObject({ ...Money, payment_ref: Ref })
    .transform((a) => ({ vendor: a.vendor, amountMicros: a.amount_micros, args: { payment_ref: a.payment_ref } })),
  wire_transfer: z.strictObject(Money).transform((a) => ({ vendor: a.vendor, amountMicros: a.amount_micros })),
  "payout.create": z.strictObject(Money).transform((a) => ({ vendor: a.vendor, amountMicros: a.amount_micros })),
  // payout-rails PO-14: the same arguments as payout.create.
  "paypal.payout": z.strictObject(Money).transform((a) => ({ vendor: a.vendor, amountMicros: a.amount_micros })),
  // Moves no money, so it has no amount. PO-10: payee_ref must fit the rail, which defaults to stripe.
  "payee.update": z
    .strictObject({ vendor: Vendor, payee_ref: z.string().max(254), rail: z.enum(PAYOUT_RAILS).default("stripe") })
    .refine((a) => isDestinationFor(a.rail, a.payee_ref), {
      path: ["payee_ref"],
      message: "must be a Stripe account ID (acct_ followed by letters and digits) or, with rail paypal, a PayPal sandbox address (@personal.example.com or @business.example.com)",
    })
    .transform((a) => ({ vendor: a.vendor, amountMicros: micros(0n), args: { payee_ref: a.payee_ref, rail: a.rail } })),
} satisfies Record<string, z.ZodType<{ vendor: string; amountMicros: Micros; args?: Record<string, string> }>>;

/** For a tool the registry doesn't know: enough to audit the request, which is then denied. */
const UNKNOWN_TOOL_ARGS = z
  .looseObject(Money)
  .transform((a) => ({ vendor: a.vendor, amountMicros: a.amount_micros }));

export const ToolBodySchema = z.strictObject({
  tool: z.string().regex(/^[\x21-\x7e]{1,100}$/, "must be 1 to 100 printable characters"),
  session_id: z.uuid(),
  // Checked per tool below. Not z.record: it silently drops an own "__proto__" key, and the
  // strict per-tool schemas should see and reject every key the agent sent.
  args: z.unknown(),
  advisory_drift_score: AdvisoryDriftScoreSchema.optional(),
});

function argsSchemaFor(tool: string) {
  return Object.hasOwn(TOOL_ARGS, tool) ? TOOL_ARGS[tool as keyof typeof TOOL_ARGS] : UNKNOWN_TOOL_ARGS;
}

export function handleTool(request: Request, deps: ToolDeps = defaultToolDeps()): Promise<Response> {
  // PXY-2, PXY-3: authenticate before reading anything else.
  return withAgent(request, deps.openDb, "tool", async (db, agent) => {
    const idempotencyKey = idempotencyKeyOf(request);
    if (!idempotencyKey) return invalidIdempotencyKey();

    const parsed = await parseBody(request, ToolBodySchema);
    if (!parsed.ok) return parsed.response;
    const { tool, session_id: sessionId, args, advisory_drift_score: score } = parsed.value;

    if (PAY_TOOLS.includes(tool)) {
      return json(400, { error: "INVALID_REQUEST", issues: [{ path: "tool", message: "Payments go through /api/v1/pay" }] });
    }
    const registered = findTool(tool);
    if (registered && !Object.hasOwn(TOOL_ARGS, registered.name)) throw new Error(`No argument schema for registered tool ${registered.name}`);

    const toolArgs = argsSchemaFor(tool).safeParse(args);
    if (!toolArgs.success) {
      return json(400, {
        error: "INVALID_REQUEST",
        issues: toolArgs.error.issues.map((i) => ({ path: ["args", ...i.path.map(String)].join("."), message: i.message })),
      });
    }

    const body: GuardedBody = { tool, sessionId, ...toolArgs.data, ...(score !== undefined ? { advisoryDriftScore: score } : {}) };
    const result = await runGuardedRequest({ agent, idempotencyKey, body }, { db, key: deps.key(), now: deps.now, railFor: deps.railFor });
    scheduleReconcile(deps, agent.id);
    return json(result.status, result.body);
  });
}
