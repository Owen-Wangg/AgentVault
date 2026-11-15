import { type Micros, fromDecimalString } from "@/core/money";
import type { Envelope, ReasonCode } from "@/core/policy";

/**
 * The four demo scenarios as data (demo-agents design, "Scripted
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

export const SCENARIO_NAMES = ["normal", "runaway", "injection", "drift"] as const;
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
  | { kind: "injected-refund"; vendor: string; paymentRef: string };

export interface ExpectedDecision {
  decision: "allow" | "hold" | "deny";
  reasons: readonly ReasonCode[];
}

export interface Scenario {
  name: ScenarioName;
  agentName: string;
  envelope: Omit<Envelope, "agentId">;
  task: ScenarioTask;
  steps: readonly Step[];
  expected: readonly ExpectedDecision[];
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

/** Refunds allowed up to $1,000, approval over $100, and no window caps, so only the taint and approval rules fire on the $480 refund. */
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
};
