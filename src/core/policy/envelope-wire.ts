import { z } from "zod";
import { MicrosSchema, toMicrosString } from "@/core/money";
import type { Envelope, Limits } from "./types";

/**
 * The envelope on the wire, as the editor sends it to
 * PUT /api/v1/agents/:id/envelope (telemetry-dashboard UI-8). Amounts are
 * micros strings (security-standards §1). Strict: unknown fields fail.
 */

/** Vendor and tool names as the registry and requests use them, like "nimbus-weather" or "stripe.refund". */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const Name = z.string().regex(NAME_PATTERN, "Use letters, digits, and . _ : - (at most 100 characters)");

/** At most this many names in an allow-list or keys in a limit map. */
export const MAX_ENTRIES = 100;
/**
 * The highest calls-per-minute limit the editor accepts (UI-8). Above
 * this, a runaway agent wouldn't be frozen before it filled the log.
 */
export const MAX_CALLS_PER_MINUTE = 1_000;

const WireLimitsSchema = z.strictObject({
  txMaxMicros: MicrosSchema.optional(),
  windowCapsMicros: z.strictObject({ minute: MicrosSchema.optional(), hour: MicrosSchema.optional(), day: MicrosSchema.optional() }).optional(),
  callsPerMinute: z.number().int().min(0).max(MAX_CALLS_PER_MINUTE).optional(),
  approvalThresholdMicros: MicrosSchema.optional(),
});

/**
 * A limit map. `z.record` silently skips an own "__proto__" key (the
 * Phase 4 bug), so such a map is rejected on the raw input.
 */
const LimitsMapSchema = z
  .custom<Record<string, unknown>>(
    (v) => typeof v === "object" && v !== null && !Array.isArray(v) && !Object.hasOwn(v, "__proto__"),
    'Limits must be an object, and "__proto__" can\'t be a vendor or tool name',
  )
  .refine((v) => Object.keys(v).length <= MAX_ENTRIES, `At most ${MAX_ENTRIES} entries`)
  .pipe(z.record(Name, WireLimitsSchema));

const AllowListSchema = z.union([
  z.literal("*"),
  z
    .array(Name)
    .max(MAX_ENTRIES)
    .refine((names) => new Set(names).size === names.length, "Each name may appear once"),
]);

export const EnvelopeWireSchema = z.strictObject({
  limits: WireLimitsSchema,
  vendorLimits: LimitsMapSchema,
  toolLimits: LimitsMapSchema,
  allowedVendors: AllowListSchema,
  allowedTools: AllowListSchema,
  /** The version the editor loaded. A save over a newer version is a conflict. */
  expectedVersion: z.number().int().min(1),
});

export type EnvelopeWire = z.input<typeof EnvelopeWireSchema>;

/**
 * What PUT /api/v1/agents/:id/envelope accepts (UI-8): the wire envelope,
 * with the agent's own calls-per-minute limit required, so a saved envelope
 * always freezes a runaway agent. Per-vendor and per-tool limits stay optional.
 */
export const EnvelopeUpdateSchema = EnvelopeWireSchema.extend({
  limits: WireLimitsSchema.extend({ callsPerMinute: z.number().int().min(0).max(MAX_CALLS_PER_MINUTE) }),
});

/** Drop undefined fields, to fit exactOptionalPropertyTypes. */
function limitsOf(parsed: z.output<typeof WireLimitsSchema>): Limits {
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

/** The envelope a parsed wire body describes. */
export function envelopeFromWire(parsed: z.output<typeof EnvelopeWireSchema>): Omit<Envelope, "agentId"> {
  const map = (m: Record<string, z.output<typeof WireLimitsSchema>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, limitsOf(v)]));
  return {
    limits: limitsOf(parsed.limits),
    vendorLimits: map(parsed.vendorLimits),
    toolLimits: map(parsed.toolLimits),
    allowedVendors: parsed.allowedVendors === "*" ? "*" : [...parsed.allowedVendors],
    allowedTools: parsed.allowedTools === "*" ? "*" : [...parsed.allowedTools],
  };
}

export type WireLimits = z.input<typeof WireLimitsSchema>;

function limitsToWire(limits: Limits): WireLimits {
  const out: WireLimits = {};
  if (limits.txMaxMicros !== undefined) out.txMaxMicros = toMicrosString(limits.txMaxMicros);
  if (limits.callsPerMinute !== undefined) out.callsPerMinute = limits.callsPerMinute;
  if (limits.approvalThresholdMicros !== undefined) out.approvalThresholdMicros = toMicrosString(limits.approvalThresholdMicros);
  if (limits.windowCapsMicros) {
    const caps: NonNullable<WireLimits["windowCapsMicros"]> = {};
    for (const w of ["minute", "hour", "day"] as const) {
      const cap = limits.windowCapsMicros[w];
      if (cap !== undefined) caps[w] = toMicrosString(cap);
    }
    out.windowCapsMicros = caps;
  }
  return out;
}

/** An envelope in wire form, for the editor's initial values. */
export function envelopeToWire(envelope: Omit<Envelope, "agentId">, version: number): EnvelopeWire {
  const map = (m: Record<string, Limits>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, limitsToWire(v)]));
  return {
    limits: limitsToWire(envelope.limits),
    vendorLimits: map(envelope.vendorLimits),
    toolLimits: map(envelope.toolLimits),
    allowedVendors: envelope.allowedVendors === "*" ? "*" : [...envelope.allowedVendors],
    allowedTools: envelope.allowedTools === "*" ? "*" : [...envelope.allowedTools],
    expectedVersion: version,
  };
}
