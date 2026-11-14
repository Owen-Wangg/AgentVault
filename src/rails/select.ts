import type { Rail } from "@/core/money";
import type { RailConfig } from "./config";
import { MockRail, STRIPE_MINIMUM_CENTS } from "./mock";
import type { RailAdapter } from "./types";

/**
 * Choose the adapter for a tool's registered rail (rail-adapters design,
 * `railFor`). The caller passes the rail, not the tool, because the tool
 * registry lives in src/server, which src/rails may not import.
 *
 * RAIL-2: in mock mode, or for any sandbox workspace, every rail is the
 * mock adapter. The server passes `isSandbox` from the workspace row
 * itself, so a misconfigured RAIL_MODE can't send sandbox requests to a
 * real rail.
 */

export class RailUnavailableError extends Error {
  readonly code = "RAIL_UNAVAILABLE";
  constructor(rail: Rail) {
    super(`No real adapter is configured for the ${rail} rail`);
    this.name = "RailUnavailableError";
  }
}

export type MockRails = Record<Rail, MockRail>;

/** One mock adapter per simulated rail, with that rail's minimum. */
export function createMockRails(config: Pick<RailConfig, "x402MinUnits">): MockRails {
  return {
    stripe: new MockRail("stripe", STRIPE_MINIMUM_CENTS),
    x402: new MockRail("x402", config.x402MinUnits),
    mock: new MockRail("mock", 1n),
  };
}

let shared: MockRails | null = null;

/** The process-wide mock adapters, created on first use. */
export function sharedMockRails(config: Pick<RailConfig, "x402MinUnits">): MockRails {
  shared ??= createMockRails(config);
  return shared;
}

export interface RailForOptions {
  config: RailConfig;
  /** Mock adapters to use. Defaults to the process-wide ones; tests pass their own. */
  mocks?: MockRails;
  /** Real adapters, added in Phases 13 and 14. */
  real?: Partial<Record<Rail, RailAdapter>>;
}

export function railFor(rail: Rail, workspace: { isSandbox: boolean }, options: RailForOptions): RailAdapter {
  const mocks = options.mocks ?? sharedMockRails(options.config);
  // The mock rail has no real counterpart.
  if (options.config.mode === "mock" || workspace.isSandbox || rail === "mock") return mocks[rail];
  const adapter = options.real?.[rail];
  if (!adapter) throw new RailUnavailableError(rail);
  return adapter;
}
