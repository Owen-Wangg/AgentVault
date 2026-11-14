import fc from "fast-check";
import type { TaskScope } from "@/core/intent/types";
import { MAX_MICROS, type Micros, type Rail, micros } from "@/core/money";
import { HOLD_REASONS, type HoldReason } from "@/core/policy/reasons";
import type { Envelope, EvaluateInput, Limits, PayRequest, Window, WindowState } from "@/core/policy/types";
import type { SessionState, ToolDef } from "@/core/taint/types";

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

/**
 * Names usable as keys of a vendor or tool limit map. The schema rejects a
 * "__proto__" key (see LimitsByKey in policy/schemas.ts), so valid inputs
 * never have one. Requests can still name such a vendor.
 */
export const limitKeys = (names: readonly string[]): readonly string[] => names.filter((n) => n !== "__proto__");

/** A record keyed by some of `keys`, built with Object.fromEntries so every key is an own property. */
const limitsByKey = (keys: readonly string[]): fc.Arbitrary<Record<string, Limits>> =>
  fc
    .uniqueArray(fc.tuple(fc.constantFrom(...limitKeys(keys)), limitsArb()), { selector: ([k]) => k, maxLength: keys.length })
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

/**
 * A tool definition for `name`. The privileged flag is random, including
 * for tools the registry flags, so rules that rely on more than the flag
 * get exercised too.
 */
export const toolDefArb = (name: string): fc.Arbitrary<ToolDef> =>
  fc.record({
    name: fc.constant(name),
    privileged: fc.boolean(),
    rail: fc.constantFrom<Rail | null>("stripe", "x402", "mock", null),
  });

/** Hold codes an approval re-run might carry (HITL-2). Duplicates are allowed: the schema accepts them. */
export const approvedHoldReasonsArb = (): fc.Arbitrary<HoldReason[]> => fc.array(fc.constantFrom(...HOLD_REASONS), { maxLength: 4 });

/**
 * A complete, valid input for `evaluate()`. The tool definition always
 * matches `request.tool`. Most inputs are first runs with no approval
 * attached; about a third are approval re-runs with `approvedHoldReasons`.
 */
export const evaluateInputArb = (): fc.Arbitrary<EvaluateInput> =>
  payRequestArb().chain((request) =>
    fc
      .record({
        request: fc.constant(request),
        envelope: envelopeArb(),
        window: windowStateArb(),
        session: sessionStateArb(),
        scope: taskScopeArb(),
        tool: toolDefArb(request.tool),
        approved: fc.oneof({ arbitrary: fc.constant(undefined), weight: 2 }, { arbitrary: approvedHoldReasonsArb(), weight: 1 }),
      })
      // exactOptionalPropertyTypes: a first run has no approvedHoldReasons key at all.
      .map(({ approved, ...input }): EvaluateInput => (approved === undefined ? input : { ...input, approvedHoldReasons: approved })),
  );

/** The same input as a first run, with no approval attached. */
export function withoutApproval(input: EvaluateInput): EvaluateInput {
  const rest = { ...input };
  delete rest.approvedHoldReasons;
  return rest;
}
