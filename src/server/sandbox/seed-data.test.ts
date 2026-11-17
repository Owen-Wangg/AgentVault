import { describe, expect, it } from "vitest";
import { extractAmountDue, extractInjectedPayee, extractInjectedRefund } from "@/agents/scripted/agent";
import { ATTACKER_ACCOUNT, GPU_PRICE, INJECTED_REFUND, INVOICE_AMOUNT, SCENARIOS, SCENARIO_NAMES } from "@/agents/scripted/scenarios";
import { toMicrosString } from "@/core/money";
import { ACME_INVOICE_HTML, GPU_CATALOG, NIMBUS_DOCS_HTML } from "@/server/vendor/pages";
import { SEED_AGENTS, SEED_TASKS, SEED_VENDORS } from "./seed-data";

/** The scenario data has to agree with what every sandbox is seeded with and what the vendor pages say. */
describe("scenario seed data", () => {
  it("AGT-6, AGT-9, PO-23: every vendor a scenario pays is seeded or is the scenario's per-run payee, and the GPU vendor is outside the weather category", () => {
    const category = new Map(SEED_VENDORS.map((v) => [v.name, v.category]));
    for (const name of SCENARIO_NAMES) {
      const payee = SCENARIOS[name].payee;
      for (const step of SCENARIOS[name].steps) {
        if (step.kind === "fetch") continue;
        expect(category.has(step.vendor) || payee?.name === step.vendor, `${name} pays ${step.vendor}`).toBe(true);
      }
      if (payee) expect(SCENARIOS[name].task.allowedVendorCategories).toContain(payee.category);
    }
    expect(category.get("nimbus-weather")).toBe("weather");
    expect(SCENARIOS.drift.task.allowedVendorCategories).not.toContain(category.get("gpu-cloud"));
  });

  it("AGT-8, AGT-9: the scripted amounts are the ones the vendor pages show", () => {
    expect(extractInjectedRefund(NIMBUS_DOCS_HTML)).toBe(INJECTED_REFUND);
    expect(toMicrosString(GPU_PRICE)).toBe(GPU_CATALOG.price_micros);
  });

  it("PO-23: the invoice page asks for the attacker's account and shows the $900 the scenario pays", () => {
    expect(extractInjectedPayee(ACME_INVOICE_HTML)).toBe(ATTACKER_ACCOUNT);
    expect(extractAmountDue(ACME_INVOICE_HTML)).toBe(INVOICE_AMOUNT);
    expect(extractInjectedPayee(NIMBUS_DOCS_HTML)).toBeNull();
  });

  it("AUD-9: the sandbox seed shows the scenarios' own envelopes and tasks", () => {
    expect(SEED_AGENTS.map((a) => a.envelope)).toEqual([SCENARIOS.normal.envelope, SCENARIOS.injection.envelope, SCENARIOS.hijack.envelope]);
    expect(SEED_TASKS).toEqual([
      { key: "weather", ...SCENARIOS.normal.task },
      { key: "billing", ...SCENARIOS.injection.task },
      { key: "payables", ...SCENARIOS.hijack.task },
    ]);
  });
});
