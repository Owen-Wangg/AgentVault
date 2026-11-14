import fc from "fast-check";
import type { TaskScope } from "@/core/intent/types";
import { MAX_MICROS, type Micros, micros } from "@/core/money";
import type { Envelope, EvaluateInput, Limits, PayRequest, Window, WindowState } from "@/core/policy/types";
import type { SessionState } from "@/core/taint/types";

/** Edge values from testing-standards.md: zero, one micro, either side of one cent, and the maximum. */
export const MICROS_EDGE_VALUES: readonly Micros[] = [0n, 1n, 9_999n, 10_000n, MAX_MICROS].map(micros);

/** Any amount from 0 to `max` (default MAX_MICROS), uniformly distributed. */
export const anyMicros = (max: Micros = MAX_MICROS): fc.Arbitrary<Micros> =>
  fc.bigInt({ min: 0n, max }).map(micros);

/** Amounts with the edge values (up to `max`) mixed in, so boundaries get hit in every run. */
export const microsWithEdges = (max: Micros = MAX_MICROS): fc.Arbitrary<Micros> => {
  const edges = MICROS_EDGE_VALUES.filter((e) => e <= max);
  return fc.oneof({ arbitrary: anyMicros(max), weight: 4 }, { arbitrary: fc.constantFrom(...edges), weight: 1 });
};

// ---------------------------------------------------------------------------
// Policy inputs
// ---------------------------------------------------------------------------

/**
 * Policy amounts default to at most $10, so request amounts, spend, and caps
 * land close enough together that limits actually bind. Spend also mixes in
 * the full range, so overflow near MAX_MICROS is exercised.
 */
export const POLICY_MAX: Micros = micros(10_000_000n);

/**
 * Small pools so that allow-lists and per-vendor and per-tool limits match
 * often. They include names that collide with Object.prototype members, so
 * a lookup that walks the prototype chain shows up as a failure.
 */
export const VENDORS = ["nimbus-weather", "gpu-cloud", "stripe", "constructor", "__proto__"] as const;
export const TOOLS = ["x402.pay", "mpp.pay", "stripe.refund", "toString"] as const;
export const AGENT_ID = "agent-1";
export const SESSION_ID = "session-1";

const policyMicros = (): fc.Arbitrary<Micros> => microsWithEdges(POLICY_MAX);

export const windowCapsArb = (): fc.Arbitrary<Partial<Record<Window, Micros>>> =>
  fc.record({ minute: policyMicros(), hour: policyMicros(), day: policyMicros() }, { requiredKeys: [] });

/** Limits with any subset of fields set. */
export const limitsArb = (): fc.Arbitrary<Limits> =>
  fc.record(
    {
      txMaxMicros: policyMicros(),
      windowCapsMicros: windowCapsArb(),
      callsPerMinute: fc.nat({ max: 40 }),
      approvalThresholdMicros: policyMicros(),
    },
    { requiredKeys: [] },
  );

/** A record keyed by some of `keys`. Built with Object.fromEntries, so "__proto__" becomes an own key. */
const limitsByKey = (keys: readonly string[]): fc.Arbitrary<Record<string, Limits>> =>
  fc
    .uniqueArray(fc.tuple(fc.constantFrom(...keys), limitsArb()), { selector: ([k]) => k, maxLength: keys.length })
    .map((entries) => Object.fromEntries(entries));

const allowListArb = (pool: readonly string[]): fc.Arbitrary<readonly string[] | "*"> =>
  fc.oneof(fc.constant("*" as const), fc.subarray([...pool]));

export const envelopeArb = (agentId: string = AGENT_ID): fc.Arbitrary<Envelope> =>
  fc.record({
    agentId: fc.constant(agentId),
    limits: limitsArb(),
    vendorLimits: limitsByKey(VENDORS),
    toolLimits: limitsByKey(TOOLS),
    allowedVendors: allowListArb(VENDORS),
    allowedTools: allowListArb(TOOLS),
  });

const spendArb = (): fc.Arbitrary<Micros> =>
  fc.oneof({ arbitrary: policyMicros(), weight: 9 }, { arbitrary: microsWithEdges(), weight: 1 });

const perWindowArb = (): fc.Arbitrary<Record<Window, Micros>> =>
  fc.record({ minute: spendArb(), hour: spendArb(), day: spendArb() });

export const windowStateArb = (): fc.Arbitrary<WindowState> =>
  fc.record({
    spentMicros: perWindowArb(),
    vendorSpentMicros: perWindowArb(),
    toolSpentMicros: perWindowArb(),
    callsLastMinute: fc.nat({ max: 50 }),
  });

export const payRequestArb = (agentId: string = AGENT_ID, sessionId: string = SESSION_ID): fc.Arbitrary<PayRequest> =>
  fc.record({
    kind: fc.constantFrom("pay" as const, "tool" as const),
    agentId: fc.constant(agentId),
    sessionId: fc.constant(sessionId),
    vendor: fc.constantFrom(...VENDORS),
    vendorCategory: fc.constantFrom("weather", "compute", "payments", "unknown"),
    tool: fc.constantFrom(...TOOLS),
    amountMicros: policyMicros(),
    idempotencyKey: fc.uuid(),
  });

export const sessionStateArb = (sessionId: string = SESSION_ID): fc.Arbitrary<SessionState> =>
  fc.record({
    sessionId: fc.constant(sessionId),
    agentFrozen: fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }),
    taintedAt: fc.constantFrom(null, "2026-11-16T12:00:00.000Z"),
    taintSourceUrl: fc.constantFrom(null, "https://vendor.example/docs/integration"),
    sessionSpentMicros: spendArb(),
  });

export const taskScopeArb = (): fc.Arbitrary<TaskScope> =>
  fc.record({
    taskId: fc.constant("task-1"),
    allowedVendorCategories: fc.subarray(["weather", "compute", "payments"]),
    allowedTools: fc.subarray([...TOOLS]),
    budgetMicros: policyMicros(),
  });

/** A complete, valid input for `evaluate()`. */
export const evaluateInputArb = (): fc.Arbitrary<EvaluateInput> =>
  fc.record({
    request: payRequestArb(),
    envelope: envelopeArb(),
    window: windowStateArb(),
    session: sessionStateArb(),
    scope: taskScopeArb(),
  });
