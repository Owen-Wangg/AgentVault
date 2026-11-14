import { z } from "zod";
import { MAX_MICROS, type Micros } from "@/core/money";
import { HOLD_REASONS } from "./reasons";

/**
 * Zod schemas for `evaluate()` input. The server has already parsed the wire
 * format (amounts as strings, see `MicrosSchema`), so amounts here are
 * in-memory bigints. Anything that fails these schemas is denied with
 * INVALID_REQUEST (ENV-15). Objects are strict: an unknown field is a wiring
 * mistake, and the engine fails closed on it.
 */

/** An in-memory amount: a bigint from 0 to MAX_MICROS. A `number` fails (MON-4). */
export const MicrosValueSchema = z
  .bigint()
  .min(0n)
  .max(MAX_MICROS)
  .transform((v) => v as Micros);

const Id = z.string().min(1);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WindowSchema = z.enum(["minute", "hour", "day"]);

const PerWindowMicros = z.strictObject({
  minute: MicrosValueSchema,
  hour: MicrosValueSchema,
  day: MicrosValueSchema,
});

export const LimitsSchema = z.strictObject({
  txMaxMicros: MicrosValueSchema.optional(),
  windowCapsMicros: z
    .strictObject({
      minute: MicrosValueSchema.optional(),
      hour: MicrosValueSchema.optional(),
      day: MicrosValueSchema.optional(),
    })
    .optional(),
  callsPerMinute: Count.optional(),
  approvalThresholdMicros: MicrosValueSchema.optional(),
});

const Ids = z.array(Id).readonly();
const AllowList = z.union([z.literal("*"), Ids]);

/**
 * Per-vendor or per-tool limits. `z.record` silently skips an own
 * "__proto__" key, so a limit stored under it would vanish without being
 * validated or enforced. Reject such a map on the raw input instead.
 */
const LimitsByKey = z
  .custom<Record<string, unknown>>(
    (v) => typeof v === "object" && v !== null && !Object.hasOwn(v, "__proto__"),
    "Limits must be an object, and \"__proto__\" can't be a vendor or tool name",
  )
  .pipe(z.record(z.string(), LimitsSchema));

export const EnvelopeSchema = z.strictObject({
  agentId: Id,
  limits: LimitsSchema,
  vendorLimits: LimitsByKey,
  toolLimits: LimitsByKey,
  allowedVendors: AllowList,
  allowedTools: AllowList,
});

export const WindowStateSchema = z.strictObject({
  spentMicros: PerWindowMicros,
  vendorSpentMicros: PerWindowMicros,
  toolSpentMicros: PerWindowMicros,
  callsLastMinute: Count,
});

export const PayRequestSchema = z.strictObject({
  kind: z.enum(["pay", "tool"]),
  agentId: Id,
  sessionId: Id,
  vendor: Id,
  vendorCategory: Id,
  tool: Id,
  amountMicros: MicrosValueSchema,
  idempotencyKey: Id,
});

export const SessionStateSchema = z.strictObject({
  sessionId: Id,
  agentFrozen: z.boolean(),
  taintedAt: z.iso.datetime({ offset: true }).nullable(),
  taintSourceUrl: z.string().nullable(),
  sessionSpentMicros: MicrosValueSchema,
});

export const TaskScopeSchema = z.strictObject({
  taskId: Id,
  allowedVendorCategories: Ids,
  allowedTools: Ids,
  budgetMicros: MicrosValueSchema,
});

export const ToolDefSchema = z.strictObject({
  name: Id,
  privileged: z.boolean(),
  rail: z.enum(["stripe", "x402", "mock"]).nullable(),
});

export const EvaluateInputSchema = z
  .strictObject({
    request: PayRequestSchema,
    envelope: EnvelopeSchema,
    window: WindowStateSchema,
    session: SessionStateSchema,
    scope: TaskScopeSchema,
    tool: ToolDefSchema,
    // Hold codes only: a deny code here is a wiring mistake and fails closed (HITL-3).
    approvedHoldReasons: z.array(z.enum(HOLD_REASONS)).readonly().optional(),
  })
  .superRefine((input, ctx) => {
    // Pieces loaded for a different agent or session must never be combined.
    if (input.request.agentId !== input.envelope.agentId) {
      ctx.addIssue({ code: "custom", path: ["envelope", "agentId"], message: "Envelope belongs to a different agent" });
    }
    if (input.request.sessionId !== input.session.sessionId) {
      ctx.addIssue({ code: "custom", path: ["session", "sessionId"], message: "Session state belongs to a different session" });
    }
    // Otherwise a privileged tool could be evaluated with another tool's (unprivileged) flag.
    if (input.request.tool !== input.tool.name) {
      ctx.addIssue({ code: "custom", path: ["tool", "name"], message: "Tool definition is for a different tool" });
    }
  });
