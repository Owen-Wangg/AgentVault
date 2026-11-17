import { type Micros, fromDecimalString } from "@/core/money";
import type { Envelope, ReasonCode } from "@/core/policy";

/**
 * The five demo scenarios as data (demo-agents design, "Scripted
 * scenarios"). Each run gets a fresh agent with `envelope` and a fresh
 * task with `task` (AGT-2). `expected` is the exact decision sequence
 * the run must produce (AGT-5). Every applicable reason is returned
 * (ENV-11), so each seed is set so that only the reason the scenario
 * demonstrates fires.
 *
 * The sandbox seed (src/server/sandbox/seed-data.ts) uses the same
 * envelopes and tasks, so the dashboard shows the limits the scenarios
 * run under.
 */

export const SCENARIO_NAMES = ["normal", "runaway", "injection", "drift", "hijack"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const isScenarioName = (name: string): name is ScenarioName => (SCENARIO_NAMES as readonly string[]).includes(name);

export interface ScenarioTask {
  description: string;
  allowedVendorCategories: readonly string[];
  allowedTools: readonly string[];
  budgetMicros: Micros;
}

export type Step =
  /** An x402.pay payment. With `repeat`, a retry loop that stops after `stopAfterDenies` denies in a row or `max` calls. */
  | { kind: "pay"; vendor: string; amountMicros: Micros; repeat?: { max: number; stopAfterDenies: number } }
  /** Read a page on the vendor origin through /api/v1/fetch. */
  | { kind: "fetch"; path: string }
  /** Obey the refund instruction hidden in the last fetched page, as a naive LLM agent would. */
  | { kind: "injected-refund"; vendor: string; paymentRef: string }
  /** Obey the payout-account change hidden in the last fetched page with payee.update (payout-rails PO-23). */
  | { kind: "injected-payee-change"; vendor: string }
  /** Pay the amount due on the last fetched invoice with payout.create. */
  | { kind: "invoice-payout"; vendor: string };

export interface ExpectedDecision {
  decision: "allow" | "hold" | "deny";
  reasons: readonly ReasonCode[];
}

/**
 * A payee the runner creates for each run (payout-rails design, "One
 * supplier row per run"), so one run's approved payee change can't
 * redirect another run's payout. Steps name it by `name`; the run's row is
 * `name-<run>`.
 */
export interface ScenarioPayee {
  name: string;
  category: string;
  stripeAccount: string;
  paypalReceiver: string;
}

export interface Scenario {
  name: ScenarioName;
  agentName: string;
  envelope: Omit<Envelope, "agentId">;
  task: ScenarioTask;
  steps: readonly Step[];
  expected: readonly ExpectedDecision[];
  payee?: ScenarioPayee;
}

/** One weather forecast on the mock rail (product.md). */
export const WEATHER_PRICE = fromDecimalString("0.0015");
/** The GPU vendor's per-minute price, as its catalog lists it (src/server/vendor/pages.ts, GPU_CATALOG). */
export const GPU_PRICE = fromDecimalString("0.25");
/** The refund the poisoned docs page asks for. */
export const INJECTED_REFUND = fromDecimalString("480");
/** The billing payment the injection scenario's agent is handling. On the mock rail any well-formed reference works. */
export const BILLING_PAYMENT_REF = "pi_mock_billing_500";

/** Payments only, with small caps: tx max $1, $0.50 per minute, 30 calls per minute. Any vendor, so only the task scope blocks the drift. */
export const WEATHER_ENVELOPE: Omit<Envelope, "agentId"> = {
  limits: {
    txMaxMicros: fromDecimalString("1"),
    windowCapsMicros: { minute: fromDecimalString("0.50") },
    callsPerMinute: 30,
  },
  vendorLimits: {},
  toolLimits: {},
  allowedVendors: "*",
  allowedTools: ["x402.pay"],
};

/** Refunds allowed up to $1,000, approval at $100 or more (ENV-8), and no window caps, so only the taint and approval rules fire on the $480 refund. */
export const BILLING_ENVELOPE: Omit<Envelope, "agentId"> = {
  limits: { approvalThresholdMicros: fromDecimalString("100") },
  vendorLimits: {},
  toolLimits: { "stripe.refund": { txMaxMicros: fromDecimalString("1000") } },
  allowedVendors: "*",
  allowedTools: ["x402.pay", "stripe.refund"],
};

export const WEATHER_TASK: ScenarioTask = {
  description: "Get weather forecasts for the dashboard",
  allowedVendorCategories: ["weather"],
  allowedTools: ["x402.pay"],
  budgetMicros: fromDecimalString("1"),
};

/**
 * The injection task must allow stripe.refund. Otherwise DENY_INTENT_DRIFT
 * would deny the refund before the taint rule is visible, and the demo
 * would show the wrong defense.
 */
export const BILLING_TASK: ScenarioTask = {
  description: "Handle Nimbus Weather billing",
  allowedVendorCategories: ["weather"],
  allowedTools: ["x402.pay", "stripe.refund"],
  budgetMicros: fromDecimalString("1000"),
};

/** The supplier the Payee hijack pays, with mock destinations (the sandbox uses mock rails only). */
export const ACME_SUPPLIER: ScenarioPayee = {
  name: "acme-supplies",
  category: "suppliers",
  stripeAccount: "acct_1AcmeSupplies",
  paypalReceiver: "acme-supplies@business.example.com",
};
/** The account the poisoned invoice tells the agent to switch to. */
export const ATTACKER_ACCOUNT = "acct_1AttackerSandbox";
/** The amount due on Acme's November invoice. */
export const INVOICE_AMOUNT = fromDecimalString("900");

/** Payouts up to $1,000 each and payee changes, approval at $100 or more (ENV-8), so only the taint and approval rules fire. */
export const PAYABLES_ENVELOPE: Omit<Envelope, "agentId"> = {
  limits: { approvalThresholdMicros: fromDecimalString("100") },
  vendorLimits: {},
  toolLimits: { "payout.create": { txMaxMicros: fromDecimalString("1000") } },
  allowedVendors: "*",
  allowedTools: ["payout.create", "payee.update"],
};

/** The hijack task must allow payee.update, or DENY_INTENT_DRIFT would deny the change before the taint rule is visible. */
export const PAYABLES_TASK: ScenarioTask = {
  description: "Pay Acme Supplies' November invoice",
  allowedVendorCategories: ["suppliers"],
  allowedTools: ["payout.create", "payee.update"],
  budgetMicros: fromDecimalString("2000"),
};

const times = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

const ALLOW: ExpectedDecision = { decision: "allow", reasons: [] };

export const SCENARIOS: Readonly<Record<ScenarioName, Scenario>> = {
  normal: {
    name: "normal",
    agentName: "scenario-normal-purchase",
    envelope: WEATHER_ENVELOPE,
    task: WEATHER_TASK,
    steps: times(5, { kind: "pay", vendor: "nimbus-weather", amountMicros: WEATHER_PRICE }),
    expected: times(5, ALLOW),
  },
  runaway: {
    name: "runaway",
    agentName: "scenario-runaway-loop",
    envelope: WEATHER_ENVELOPE,
    task: WEATHER_TASK,
    // Denied calls still count toward calls per minute, so the agent stays over the limit while it
    // retries. It gives up after six denies in a row: the velocity deny and five while frozen.
    steps: [{ kind: "pay", vendor: "nimbus-weather", amountMicros: WEATHER_PRICE, repeat: { max: 100, stopAfterDenies: 6 } }],
    expected: [
      ...times(30, ALLOW),
      { decision: "deny", reasons: ["VELOCITY_EXCEEDED"] },
      ...times<ExpectedDecision>(5, { decision: "deny", reasons: ["AGENT_FROZEN", "VELOCITY_EXCEEDED"] }),
    ],
  },
  injection: {
    name: "injection",
    agentName: "scenario-prompt-injection",
    envelope: BILLING_ENVELOPE,
    task: BILLING_TASK,
    steps: [
      { kind: "fetch", path: "/vendor/docs/integration" },
      { kind: "injected-refund", vendor: "nimbus-weather", paymentRef: BILLING_PAYMENT_REF },
    ],
    expected: [{ decision: "hold", reasons: ["HELD_TAINTED", "NEEDS_APPROVAL"] }],
  },
  drift: {
    name: "drift",
    agentName: "scenario-intent-drift",
    envelope: WEATHER_ENVELOPE,
    task: WEATHER_TASK,
    steps: [
      { kind: "pay", vendor: "nimbus-weather", amountMicros: WEATHER_PRICE },
      { kind: "pay", vendor: "gpu-cloud", amountMicros: GPU_PRICE },
    ],
    expected: [ALLOW, { decision: "deny", reasons: ["DENY_INTENT_DRIFT"] }],
  },
  hijack: {
    name: "hijack",
    agentName: "scenario-payee-hijack",
    envelope: PAYABLES_ENVELOPE,
    task: PAYABLES_TASK,
    payee: ACME_SUPPLIER,
    steps: [
      { kind: "fetch", path: "/vendor/docs/invoice" },
      { kind: "injected-payee-change", vendor: "acme-supplies" },
      { kind: "invoice-payout", vendor: "acme-supplies" },
    ],
    // payout-rails PO-23: the payee change moves no money, so only taint holds it; the $900 payout is also over the threshold.
    expected: [
      { decision: "hold", reasons: ["HELD_TAINTED"] },
      { decision: "hold", reasons: ["HELD_TAINTED", "NEEDS_APPROVAL"] },
    ],
  },
};
