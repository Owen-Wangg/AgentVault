import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toDecimalString, toMicrosString } from "@/core/money";
import { envelopeToWire } from "@/core/policy";
import { envelopeArb, microsWithEdges } from "@/core/testing/arbitraries";
import { EMPTY_LIMITS, type EnvelopeForm, EnvelopeFormSchema, formToWire, wireToForm } from "./envelope-form";

// The agent's own calls-per-minute limit is required (UI-8), so every valid form sets it.
const LIMITS = { ...EMPTY_LIMITS, callsPerMinute: "30" };
const base: EnvelopeForm = { limits: { ...LIMITS }, vendorLimits: [], toolLimits: [], allowAllVendors: true, vendors: "", allowAllTools: false, tools: "x402.pay\nmpp.pay" };

const errorsOf = (form: EnvelopeForm) => {
  const r = EnvelopeFormSchema.safeParse(form);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("envelope form", () => {
  it("UI-8: decimal dollars become exact micros strings, and empty fields mean no limit", () => {
    const form: EnvelopeForm = { ...base, limits: { ...EMPTY_LIMITS, txMax: "0.0015", capDay: " 20 ", callsPerMinute: "30" } };
    expect(errorsOf(form)).toEqual([]);
    expect(formToWire(form, 3)).toEqual({
      limits: { txMaxMicros: "1500", windowCapsMicros: { day: "20000000" }, callsPerMinute: 30 },
      vendorLimits: {},
      toolLimits: {},
      allowedVendors: "*",
      allowedTools: ["x402.pay", "mpp.pay"],
      expectedVersion: 3,
    });
  });

  it("UI-8: refuses amounts it can't store exactly, with a message saying what to type", () => {
    for (const txMax of ["0.0000001", "-1", "1e3", "$5", "1,000", "abc", "5."]) {
      expect(errorsOf({ ...base, limits: { ...LIMITS, txMax } }), txMax).toEqual([
        "limits.txMax: Enter dollars with up to 6 decimal places, like 5 or 0.0015",
      ]);
    }
    expect(errorsOf({ ...base, limits: { ...LIMITS, callsPerMinute: "2.5" } })[0]).toMatch(/^limits.callsPerMinute: Enter a whole number/);
  });

  it("UI-8: requires the agent's own calls-per-minute limit, from 0 to 1,000, but not per vendor or tool", () => {
    expect(errorsOf({ ...base, limits: { ...EMPTY_LIMITS } })).toEqual(["limits.callsPerMinute: Required: a whole number from 0 to 1000"]);
    expect(errorsOf({ ...base, limits: { ...LIMITS, callsPerMinute: "0" } })).toEqual([]);
    expect(errorsOf({ ...base, limits: { ...LIMITS, callsPerMinute: "1000" } })).toEqual([]);
    expect(errorsOf({ ...base, limits: { ...LIMITS, callsPerMinute: "1001" } })[0]).toMatch(/^limits.callsPerMinute: Enter a whole number from 0 to 1000/);
    expect(errorsOf({ ...base, vendorLimits: [{ name: "nimbus-weather", limits: { ...EMPTY_LIMITS } }] })).toEqual([]);
  });

  it("UI-8: checks names in allow-lists and limit rows, and refuses duplicates", () => {
    expect(errorsOf({ ...base, allowAllTools: false, tools: "x402.pay\n\n  mpp.pay  \n" })).toEqual([]);
    expect(errorsOf({ ...base, tools: "x402.pay\nx402.pay" })).toEqual(["tools: Each name may appear once"]);
    expect(errorsOf({ ...base, tools: "__proto__" })[0]).toMatch(/^tools: "__proto__"/);
    const row = { name: "nimbus-weather", limits: { ...EMPTY_LIMITS } };
    expect(errorsOf({ ...base, vendorLimits: [row, { ...row }] })).toEqual(["vendorLimits.1.name: This name already has limits"]);
    expect(errorsOf({ ...base, toolLimits: [{ ...row, name: "" }] })[0]).toMatch(/^toolLimits.0.name/);
  });

  // UI-8, UI-11: typing a stored amount back in dollars gives the same
  // micros, so opening and saving the editor never changes a limit.
  it("UI-8: any amount shown as dollars converts back to the same micros", () => {
    fc.assert(
      fc.property(microsWithEdges(), (m) => {
        const form: EnvelopeForm = { ...base, limits: { ...LIMITS, approvalThreshold: toDecimalString(m) } };
        expect(errorsOf(form)).toEqual([]);
        expect(formToWire(form, 1).limits.approvalThresholdMicros).toBe(toMicrosString(m));
      }),
      { numRuns: 1000 },
    );
  });

  it("UI-8: loading an envelope into the form and saving it unchanged sends the same envelope", () => {
    fc.assert(
      fc.property(envelopeArb(), (e) => {
        const clean = (l: readonly string[] | "*") => (l === "*" ? "*" : l.filter((n) => n !== "__proto__"));
        const limits = { ...e.limits, callsPerMinute: e.limits.callsPerMinute ?? 30 };
        const wire = envelopeToWire({ ...e, limits, allowedVendors: clean(e.allowedVendors), allowedTools: clean(e.allowedTools) }, 2);
        const form = wireToForm(wire);
        expect(errorsOf(form)).toEqual([]);
        const saved = formToWire(form, 2);
        // An empty caps object and no caps mean the same thing; the form can't tell them apart.
        const normalize = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/,?"windowCapsMicros":\{\}/g, "").replace(/\{,/g, "{"));
        expect(normalize(saved)).toEqual(normalize(wire));
      }),
      { numRuns: 1000 },
    );
  });
});
