import { fromDecimalString } from "@/core/money";
import type { Envelope } from "@/core/policy";

/**
 * What every new sandbox workspace starts with (AUD-9). The envelopes
 * match the demo-agents scenario table, so the dashboard shows the same
 * limits the scenarios run under. Scenario runs create their own fresh
 * agents (demo-agents AGT-2); these seeded agents have no usable API key.
 */

export const SEED_VERSION = 1;

export interface SeedVendor {
  name: string;
  /** "app" means the deployment's own origin, where the demo vendor pages live. */
  origin: "app" | string;
  category: string;
  trusted: boolean;
}

export const SEED_VENDORS: readonly SeedVendor[] = [
  { name: "nimbus-weather", origin: "app", category: "weather", trusted: false },
  { name: "gpu-cloud", origin: "app", category: "compute", trusted: false },
];

export const SEED_TASKS = [
  {
    key: "weather",
    description: "Get weather forecasts for the dashboard",
    allowedVendorCategories: ["weather"],
    allowedTools: ["x402.pay"],
    budgetMicros: fromDecimalString("1"),
  },
  {
    key: "billing",
    description: "Handle Nimbus Weather billing",
    allowedVendorCategories: ["weather"],
    allowedTools: ["x402.pay", "stripe.refund"],
    budgetMicros: fromDecimalString("1000"),
  },
] as const;

export const SEED_AGENTS: readonly { name: string; envelope: Omit<Envelope, "agentId"> }[] = [
  {
    name: "weather-agent",
    envelope: {
      limits: {
        txMaxMicros: fromDecimalString("1"),
        windowCapsMicros: { minute: fromDecimalString("0.50") },
        callsPerMinute: 30,
      },
      vendorLimits: {},
      toolLimits: {},
      allowedVendors: "*",
      allowedTools: ["x402.pay"],
    },
  },
  {
    name: "billing-agent",
    envelope: {
      limits: { approvalThresholdMicros: fromDecimalString("100") },
      vendorLimits: {},
      toolLimits: { "stripe.refund": { txMaxMicros: fromDecimalString("1000") } },
      allowedVendors: "*",
      allowedTools: ["x402.pay", "stripe.refund"],
    },
  },
];
