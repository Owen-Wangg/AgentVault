import { BILLING_ENVELOPE, BILLING_TASK, WEATHER_ENVELOPE, WEATHER_TASK } from "@/agents/scripted/scenarios";
import type { Envelope } from "@/core/policy";

/**
 * What every new sandbox workspace starts with (AUD-9). The envelopes and
 * tasks are the demo-agents scenarios' own, so the dashboard shows the
 * same limits the scenarios run under. Scenario runs create their own
 * fresh agents and tasks (demo-agents AGT-2); these seeded agents have no
 * usable API key.
 */

// 2: vendors carry payment URLs (rail-adapters RAIL-23).
export const SEED_VERSION = 2;

export interface SeedVendor {
  name: string;
  /** "app" means the deployment's own origin, where the demo vendor pages live. */
  origin: "app" | string;
  category: string;
  trusted: boolean;
  /** Paid endpoints on the vendor's origin, by rail (rail-adapters RAIL-23). The mock rail ignores them. */
  x402Path?: string;
  mppPath?: string;
}

/** Every vendor the scenarios pay, with the category the intent rules read (INT-5). */
export const SEED_VENDORS: readonly SeedVendor[] = [
  { name: "nimbus-weather", origin: "app", category: "weather", trusted: false, x402Path: "/vendor/api/weather", mppPath: "/vendor/api/report" },
  // No payment URLs: the drift scenario's GPU payment is denied before any rail runs.
  { name: "gpu-cloud", origin: "app", category: "compute", trusted: false },
];

export const SEED_TASKS = [
  { key: "weather", ...WEATHER_TASK },
  { key: "billing", ...BILLING_TASK },
] as const;

export const SEED_AGENTS: readonly { name: string; envelope: Omit<Envelope, "agentId"> }[] = [
  { name: "weather-agent", envelope: WEATHER_ENVELOPE },
  { name: "billing-agent", envelope: BILLING_ENVELOPE },
];
