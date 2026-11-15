import { z } from "zod";
import { fromDecimalString, fromMicrosString, toDecimalString, toMicrosString } from "@/core/money";
import { type EnvelopeWire, MAX_CALLS_PER_MINUTE, MAX_ENTRIES, NAME_PATTERN, type WireLimits } from "@/core/policy";

/**
 * The envelope editor's form (UI-8). People type amounts as decimal
 * dollars ("0.0015"); they become micros strings through
 * fromDecimalString, never through a number (security-standards §1).
 * An empty field means no limit.
 */

export interface LimitsForm {
  txMax: string;
  capMinute: string;
  capHour: string;
  capDay: string;
  callsPerMinute: string;
  approvalThreshold: string;
}

export interface NamedLimitsForm {
  name: string;
  limits: LimitsForm;
}

export interface EnvelopeForm {
  limits: LimitsForm;
  vendorLimits: NamedLimitsForm[];
  toolLimits: NamedLimitsForm[];
  allowAllVendors: boolean;
  /** One name per line. */
  vendors: string;
  allowAllTools: boolean;
  tools: string;
}

const AMOUNT_HINT = "Enter dollars with up to 6 decimal places, like 5 or 0.0015";

/** "" (no limit) or an exact dollar amount. */
const Dollars = z
  .string()
  .trim()
  .refine((s) => {
    if (s === "") return true;
    try {
      fromDecimalString(s);
      return true;
    } catch {
      return false;
    }
  }, AMOUNT_HINT);

const Calls = z
  .string()
  .trim()
  .refine((s) => s === "" || (/^(0|[1-9][0-9]{0,5})$/.test(s) && BigInt(s) <= BigInt(MAX_CALLS_PER_MINUTE)), `Enter a whole number from 0 to ${MAX_CALLS_PER_MINUTE}`);

const LimitsFormSchema = z.object({ txMax: Dollars, capMinute: Dollars, capHour: Dollars, capDay: Dollars, callsPerMinute: Calls, approvalThreshold: Dollars });

const nameMessage = "Use letters, digits, and . _ : - (at most 100 characters)";

/** The non-empty lines of a list, trimmed. */
export const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

const NameList = z.string().superRefine((text, ctx) => {
  const names = lines(text);
  const bad = names.find((n) => !NAME_PATTERN.test(n));
  if (bad !== undefined) ctx.addIssue({ code: "custom", message: `"${bad.slice(0, 40)}": ${nameMessage}` });
  else if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "Each name may appear once" });
  else if (names.length > MAX_ENTRIES) ctx.addIssue({ code: "custom", message: `At most ${MAX_ENTRIES} names` });
});

const NamedLimitsSchema = z.array(z.object({ name: z.string().trim().regex(NAME_PATTERN, nameMessage), limits: LimitsFormSchema })).max(MAX_ENTRIES);

const uniqueNames = (rows: { name: string }[], ctx: z.RefinementCtx, path: string) => {
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const name = row.name.trim();
    if (seen.has(name)) ctx.addIssue({ code: "custom", path: [path, i, "name"], message: "This name already has limits" });
    seen.add(name);
  });
};

export const EnvelopeFormSchema = z
  .object({
    limits: LimitsFormSchema,
    vendorLimits: NamedLimitsSchema,
    toolLimits: NamedLimitsSchema,
    allowAllVendors: z.boolean(),
    vendors: NameList,
    allowAllTools: z.boolean(),
    tools: NameList,
  })
  .superRefine((form, ctx) => {
    uniqueNames(form.vendorLimits, ctx, "vendorLimits");
    uniqueNames(form.toolLimits, ctx, "toolLimits");
  });

const toMicros = (dollars: string): string | undefined => (dollars.trim() === "" ? undefined : toMicrosString(fromDecimalString(dollars.trim())));
const toDollars = (microsString: string | undefined): string => (microsString === undefined ? "" : toDecimalString(fromMicrosString(microsString)));

function limitsToWire(form: LimitsForm): WireLimits {
  const out: WireLimits = {};
  const txMax = toMicros(form.txMax);
  if (txMax !== undefined) out.txMaxMicros = txMax;
  const threshold = toMicros(form.approvalThreshold);
  if (threshold !== undefined) out.approvalThresholdMicros = threshold;
  if (form.callsPerMinute.trim() !== "") out.callsPerMinute = Number.parseInt(form.callsPerMinute.trim(), 10);
  const caps: NonNullable<WireLimits["windowCapsMicros"]> = {};
  const minute = toMicros(form.capMinute);
  const hour = toMicros(form.capHour);
  const day = toMicros(form.capDay);
  if (minute !== undefined) caps.minute = minute;
  if (hour !== undefined) caps.hour = hour;
  if (day !== undefined) caps.day = day;
  if (Object.keys(caps).length > 0) out.windowCapsMicros = caps;
  return out;
}

function limitsToForm(wire: WireLimits): LimitsForm {
  return {
    txMax: toDollars(wire.txMaxMicros),
    capMinute: toDollars(wire.windowCapsMicros?.minute),
    capHour: toDollars(wire.windowCapsMicros?.hour),
    capDay: toDollars(wire.windowCapsMicros?.day),
    callsPerMinute: wire.callsPerMinute === undefined ? "" : String(wire.callsPerMinute),
    approvalThreshold: toDollars(wire.approvalThresholdMicros),
  };
}

export const EMPTY_LIMITS: LimitsForm = { txMax: "", capMinute: "", capHour: "", capDay: "", callsPerMinute: "", approvalThreshold: "" };

/** A validated form as the PUT body. */
export function formToWire(form: EnvelopeForm, expectedVersion: number): EnvelopeWire {
  const map = (rows: NamedLimitsForm[]) => Object.fromEntries(rows.map((r) => [r.name.trim(), limitsToWire(r.limits)]));
  return {
    limits: limitsToWire(form.limits),
    vendorLimits: map(form.vendorLimits),
    toolLimits: map(form.toolLimits),
    allowedVendors: form.allowAllVendors ? "*" : lines(form.vendors),
    allowedTools: form.allowAllTools ? "*" : lines(form.tools),
    expectedVersion,
  };
}

export function wireToForm(wire: EnvelopeWire): EnvelopeForm {
  const rows = (m: Record<string, WireLimits>) => Object.entries(m).map(([name, limits]) => ({ name, limits: limitsToForm(limits) }));
  return {
    limits: limitsToForm(wire.limits),
    vendorLimits: rows(wire.vendorLimits as Record<string, WireLimits>),
    toolLimits: rows(wire.toolLimits as Record<string, WireLimits>),
    allowAllVendors: wire.allowedVendors === "*",
    vendors: wire.allowedVendors === "*" ? "" : wire.allowedVendors.join("\n"),
    allowAllTools: wire.allowedTools === "*",
    tools: wire.allowedTools === "*" ? "" : wire.allowedTools.join("\n"),
  };
}
