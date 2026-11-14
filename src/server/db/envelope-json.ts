import { z } from "zod";
import { canonicalJson } from "@/core/audit";
import { MicrosSchema } from "@/core/money";
import type { Envelope, Limits } from "@/core/policy";

/**
 * Envelope columns are jsonb with amounts as micros strings ("1500"),
 * because JSON has no bigint (security-standards §1). Encoding goes
 * through canonical JSON, which turns every bigint into a digit string
 * and rejects floats.
 */

export interface EnvelopeColumns {
  limits: unknown;
  vendorLimits: unknown;
  toolLimits: unknown;
  allowedVendors: unknown;
  allowedTools: unknown;
}

const toJson = (value: unknown): unknown => JSON.parse(canonicalJson(value));

export function encodeEnvelope(envelope: Omit<Envelope, "agentId">): EnvelopeColumns {
  return {
    limits: toJson(envelope.limits),
    vendorLimits: toJson(envelope.vendorLimits),
    toolLimits: toJson(envelope.toolLimits),
    allowedVendors: toJson(envelope.allowedVendors),
    allowedTools: toJson(envelope.allowedTools),
  };
}

const StoredLimits = z.strictObject({
  txMaxMicros: MicrosSchema.optional(),
  windowCapsMicros: z
    .strictObject({ minute: MicrosSchema.optional(), hour: MicrosSchema.optional(), day: MicrosSchema.optional() })
    .optional(),
  callsPerMinute: z.number().int().min(0).optional(),
  approvalThresholdMicros: MicrosSchema.optional(),
});
const StoredAllowList = z.union([z.literal("*"), z.array(z.string().min(1))]);

/** Drop keys whose value is undefined, to fit exactOptionalPropertyTypes. */
function limitsFrom(parsed: z.output<typeof StoredLimits>): Limits {
  const out: Limits = {};
  if (parsed.txMaxMicros !== undefined) out.txMaxMicros = parsed.txMaxMicros;
  if (parsed.callsPerMinute !== undefined) out.callsPerMinute = parsed.callsPerMinute;
  if (parsed.approvalThresholdMicros !== undefined) out.approvalThresholdMicros = parsed.approvalThresholdMicros;
  if (parsed.windowCapsMicros !== undefined) {
    const caps: NonNullable<Limits["windowCapsMicros"]> = {};
    for (const w of ["minute", "hour", "day"] as const) {
      const cap = parsed.windowCapsMicros[w];
      if (cap !== undefined) caps[w] = cap;
    }
    out.windowCapsMicros = caps;
  }
  return out;
}

/**
 * Not z.record: it silently skips an own "__proto__" key, which would drop
 * that limit. Such a key is rejected, as the policy input schema does.
 */
function limitsByKey(value: unknown): Record<string, Limits> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("A limit map must be a JSON object");
  if (Object.hasOwn(value, "__proto__")) throw new Error('"__proto__" can\'t be a vendor or tool name');
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, limitsFrom(StoredLimits.parse(v))]));
}

/** Parse stored envelope columns back into policy types. Throws on anything malformed (fail closed). */
export function decodeEnvelope(agentId: string, columns: EnvelopeColumns): Envelope {
  return {
    agentId,
    limits: limitsFrom(StoredLimits.parse(columns.limits)),
    vendorLimits: limitsByKey(columns.vendorLimits),
    toolLimits: limitsByKey(columns.toolLimits),
    allowedVendors: StoredAllowList.parse(columns.allowedVendors),
    allowedTools: StoredAllowList.parse(columns.allowedTools),
  };
}
