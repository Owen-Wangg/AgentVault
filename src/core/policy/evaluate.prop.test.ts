import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Micros, micros, sum } from "@/core/money";
import {
  AGENT_ID,
  POLICY_MAX,
  SESSION_ID,
  TOOLS,
  VENDORS,
  envelopeArb,
  evaluateInputArb,
  limitKeys,
  limitsArb,
  microsWithEdges,
} from "@/core/testing/arbitraries";
import { baseInput } from "@/core/testing/policy-fixtures";
import { combine, evaluate, intentRule, taintRule } from "./evaluate";
import { REASON_CODES, isDenyReason, isHoldReason } from "./reasons";
import { allowListRule, frozenRule, txMaxRule, velocityRule, windowCapRule } from "./rules";
import { EvaluateInputSchema } from "./schemas";
import type { Decision, Envelope, EvaluateInput, Limits, Window } from "./types";
import { WINDOWS } from "./types";

const RUNS = { numRuns: 1000 };
const SEVERITY: Record<Decision["decision"], number> = { allow: 0, hold: 1, deny: 2 };
const codes = (d: Decision) => d.reasons.map((r) => r.code);

// ---------------------------------------------------------------------------
// Property 5: caps hold over sequences
// ---------------------------------------------------------------------------

const WINDOW_SECONDS: Record<Window, number> = { minute: 60, hour: 3_600, day: 86_400 };

interface Step {
  /** Seconds since the previous step. Biased to land on window boundaries. */
  dt: number;
  vendor: string;
  tool: string;
  amount: Micros;
}

interface Executed {
  t: number;
  vendor: string;
  tool: string;
  amount: Micros;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  dt: fc.oneof(
    { arbitrary: fc.constant(0), weight: 4 },
    { arbitrary: fc.nat({ max: 10 }), weight: 4 },
    { arbitrary: fc.constantFrom(59, 60, 61, 3_599, 3_600, 86_399, 86_400), weight: 2 },
  ),
  vendor: fc.constantFrom(...VENDORS),
  tool: fc.constantFrom(...TOOLS),
  amount: microsWithEdges(POLICY_MAX),
});

const inWindow = (now: number, w: Window) => (e: { t: number }) => now - e.t < WINDOW_SECONDS[w];

const own = (map: Record<string, Limits>, key: string): Limits | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/**
 * Run a sequence the way the server would: compute window state from the
 * history, evaluate, and record allowed requests as executed. Every call
 * counts toward calls per minute, including denied and held ones.
 */
function simulate(envelope: Envelope, steps: readonly Step[]): Executed[] {
  const calls: { t: number }[] = [];
  const executed: Executed[] = [];
  let now = 0;
  steps.forEach((step, i) => {
    now += step.dt;
    const spend = (match: (e: Executed) => boolean) =>
      Object.fromEntries(WINDOWS.map((w) => [w, sum(executed.filter(inWindow(now, w)).filter(match).map((e) => e.amount))])) as Record<
        Window,
        Micros
      >;
    const input: EvaluateInput = {
      request: {
        kind: "pay",
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        vendor: step.vendor,
        vendorCategory: "weather",
        tool: step.tool,
        amountMicros: step.amount,
        idempotencyKey: `key-${i}`,
      },
      envelope,
      window: {
        spentMicros: spend(() => true),
        vendorSpentMicros: spend((e) => e.vendor === step.vendor),
        toolSpentMicros: spend((e) => e.tool === step.tool),
        callsLastMinute: calls.filter(inWindow(now, "minute")).length,
      },
      session: { sessionId: SESSION_ID, agentFrozen: false, taintedAt: null, taintSourceUrl: null, sessionSpentMicros: micros(0n) },
      scope: { taskId: "task-1", allowedVendorCategories: ["weather"], allowedTools: [...TOOLS], budgetMicros: POLICY_MAX },
      tool: { name: step.tool, privileged: false, rail: null },
    };
    const decision = evaluate(input);
    expect(codes(decision)).not.toContain("INVALID_REQUEST");
    calls.push({ t: now });
    if (decision.decision === "allow") executed.push({ t: now, vendor: step.vendor, tool: step.tool, amount: step.amount });
  });
  return executed;
}

describe("policy properties", () => {
  // Property 5, caps hold over sequences (ENV-1, ENV-2): for any envelope and
  // any sequence of requests, where each allowed request updates the window
  // state, the sum of allowed amounts in any window never exceeds that
  // window's cap. Checked at every level (agent, vendor, tool), along with
  // the per-transaction maximum and calls per minute.
  it("ENV-1, ENV-2, ENV-3, ENV-9: allowed spend never exceeds any cap over a request sequence", () => {
    fc.assert(
      fc.property(envelopeArb(), fc.array(stepArb, { maxLength: 40 }), (envelope, steps) => {
        const executed = simulate(envelope, steps);
        executed.forEach((e, i) => {
          // Everything executed up to and including e. Steps can share a timestamp, so use order, not time.
          const upToE = executed.slice(0, i + 1);
          const scoped: [Limits | undefined, (x: Executed) => boolean][] = [
            [envelope.limits, () => true],
            [own(envelope.vendorLimits, e.vendor), (x) => x.vendor === e.vendor],
            [own(envelope.toolLimits, e.tool), (x) => x.tool === e.tool],
          ];
          for (const [limits, match] of scoped) {
            if (!limits) continue;
            if (limits.txMaxMicros !== undefined) expect(e.amount <= limits.txMaxMicros).toBe(true);
            for (const w of WINDOWS) {
              const cap = limits.windowCapsMicros?.[w];
              if (cap === undefined) continue;
              const windowTotal = sum(upToE.filter((x) => inWindow(e.t, w)(x) && match(x)).map((x) => x.amount));
              expect(windowTotal <= cap).toBe(true);
            }
          }
          const callLimits = [envelope.limits, own(envelope.vendorLimits, e.vendor), own(envelope.toolLimits, e.tool)]
            .map((l) => l?.callsPerMinute)
            .filter((c): c is number => c !== undefined);
          // Allowed calls are a subset of all calls, so this bound is implied by ENV-3.
          for (const limit of callLimits) expect(upToE.filter(inWindow(e.t, "minute")).length).toBeLessThanOrEqual(limit);
        });
      }),
      RUNS,
    );
  });

  // Property 6, precedence (ENV-12): if `reasons` contains any deny code,
  // `decision === "deny"`. Also: hold reasons alone give hold, and allow
  // has no reasons.
  it("ENV-12: the decision always follows the reason precedence", () => {
    fc.assert(
      fc.property(evaluateInputArb(), (input) => {
        const d = evaluate(input);
        const hasDeny = d.reasons.some((r) => isDenyReason(r.code));
        const hasHold = d.reasons.some((r) => isHoldReason(r.code));
        expect(d.decision).toBe(hasDeny ? "deny" : hasHold ? "hold" : "allow");
        if (d.decision === "allow") expect(d.reasons).toEqual([]);
      }),
      RUNS,
    );
  });

  it("ENV-12: combine applies precedence to any list of reasons", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...REASON_CODES).map((code) => ({ code }))), (reasons) => {
        const d = combine(reasons);
        const expected = reasons.some((r) => isDenyReason(r.code)) ? "deny" : reasons.length > 0 ? "hold" : "allow";
        expect(d.decision).toBe(expected);
        expect(d.reasons).toEqual(expected === "allow" ? [] : reasons);
      }),
      RUNS,
    );
  });

  // Property 7, determinism (ENV-13): `evaluate(x)` deep-equals `evaluate(x)`.
  // Also for a structured clone of x, so the result can't depend on object identity.
  it("ENV-13: the same input always gives the same decision", () => {
    fc.assert(
      fc.property(evaluateInputArb(), (input) => {
        const first = evaluate(input);
        expect(evaluate(input)).toEqual(first);
        expect(evaluate(structuredClone(input))).toEqual(first);
      }),
      RUNS,
    );
  });

  // Property 8, monotonicity (ENV-14): for any input with decision `deny`,
  // lowering any cap keeps the decision `deny`. Adding a cap where there
  // was none counts as lowering it. Checked in its stronger form: lowering
  // caps never makes any decision looser.
  it("ENV-14: lowering caps never loosens a decision", () => {
    const withLoweredCaps = evaluateInputArb().chain((input) =>
      lowerEnvelope(input.envelope).map((envelope) => [input, { ...input, envelope }] as const),
    );
    fc.assert(
      fc.property(withLoweredCaps, ([original, lowered]) => {
        const before = evaluate(original);
        const after = evaluate(lowered);
        if (before.decision === "deny") expect(after.decision).toBe("deny");
        expect(SEVERITY[after.decision]).toBeGreaterThanOrEqual(SEVERITY[before.decision]);
      }),
      RUNS,
    );
  });

  // ENV-11: every reason a rule finds on its own appears in the decision.
  it("ENV-11: every rule's reasons appear in the decision", () => {
    fc.assert(
      fc.property(evaluateInputArb(), (input) => {
        const d = evaluate(input);
        for (const rule of [frozenRule, txMaxRule, windowCapRule, velocityRule, allowListRule, intentRule, taintRule]) {
          for (const reason of rule(input)) expect(d.reasons).toContainEqual(reason);
        }
      }),
      RUNS,
    );
  });

  // Valid input never takes the INVALID_REQUEST path, so the catch-all in
  // evaluate() can't hide a rule that throws.
  it("ENV-15: schema-valid input never yields INVALID_REQUEST", () => {
    fc.assert(
      fc.property(evaluateInputArb(), (input) => {
        expect(codes(evaluate(input))).not.toContain("INVALID_REQUEST");
      }),
      RUNS,
    );
  });

  // ENV-15: evaluate() never throws, and anything the schema rejects is
  // denied with INVALID_REQUEST only.
  it("ENV-15: never throws on arbitrary or corrupted input, and fails closed", () => {
    const paths = [
      ["request", "amountMicros"],
      ["request", "vendor"],
      ["envelope", "limits"],
      ["envelope", "allowedTools"],
      ["window", "callsLastMinute"],
      ["window", "spentMicros"],
      ["session", "agentFrozen"],
      ["scope", "budgetMicros"],
      ["scope", "allowedVendorCategories"],
      ["tool", "name"],
      ["tool", "privileged"],
    ] as const;
    const corrupted = fc.tuple(evaluateInputArb(), fc.constantFrom(...paths), fc.anything()).map(([input, [a, b], value]) => {
      const copy = structuredClone(input) as unknown as Record<string, Record<string, unknown>>;
      copy[a]![b] = value;
      return copy as unknown;
    });
    fc.assert(
      fc.property(fc.oneof(fc.anything(), corrupted), (value) => {
        const d = evaluate(value as EvaluateInput);
        if (!EvaluateInputSchema.safeParse(value).success) {
          expect(d.decision).toBe("deny");
          expect(codes(d)).toEqual(["INVALID_REQUEST"]);
        }
      }),
      RUNS,
    );
  });

  it("ENV-15: the base fixture is valid input", () => {
    expect(EvaluateInputSchema.safeParse(baseInput()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generators for property 8
// ---------------------------------------------------------------------------

/** Keep a cap, lower it, or (if unset) maybe add one. */
const lowerMicros = (current: Micros | undefined): fc.Arbitrary<Micros | undefined> =>
  current === undefined
    ? fc.oneof(fc.constant(undefined), microsWithEdges(POLICY_MAX))
    : fc.oneof(fc.constant(current), fc.bigInt({ min: 0n, max: current }).map(micros));

const lowerCount = (current: number | undefined): fc.Arbitrary<number | undefined> =>
  current === undefined ? fc.oneof(fc.constant(undefined), fc.nat({ max: 40 })) : fc.oneof(fc.constant(current), fc.nat({ max: current }));

/** Build an object without the keys whose value is undefined (exactOptionalPropertyTypes). */
function defined<T extends object>(o: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const lowerLimits = (l: Limits): fc.Arbitrary<Limits> =>
  fc
    .record({
      txMaxMicros: lowerMicros(l.txMaxMicros),
      minute: lowerMicros(l.windowCapsMicros?.minute),
      hour: lowerMicros(l.windowCapsMicros?.hour),
      day: lowerMicros(l.windowCapsMicros?.day),
      callsPerMinute: lowerCount(l.callsPerMinute),
      approvalThresholdMicros: lowerMicros(l.approvalThresholdMicros),
    })
    .map(({ minute, hour, day, ...rest }) => {
      const caps = defined<Partial<Record<Window, Micros>>>({ minute, hour, day });
      return defined<Limits>({ ...rest, windowCapsMicros: Object.keys(caps).length > 0 || l.windowCapsMicros ? caps : undefined });
    });

/** Lower existing per-key limits, and maybe add limits for keys that had none. */
const lowerByKey = (map: Record<string, Limits>, keys: readonly string[]): fc.Arbitrary<Record<string, Limits>> =>
  fc
    .tuple(
      ...keys.map((k) => {
        const current = own(map, k);
        return current ? lowerLimits(current).map((l) => [k, l] as const) : fc.option(limitsArb().map((l) => [k, l] as const), { nil: undefined });
      }),
    )
    .map((entries) => Object.fromEntries(entries.filter((e) => e !== undefined)));

const lowerEnvelope = (e: Envelope): fc.Arbitrary<Envelope> =>
  fc
    .tuple(lowerLimits(e.limits), lowerByKey(e.vendorLimits, limitKeys(VENDORS)), lowerByKey(e.toolLimits, limitKeys(TOOLS)))
    .map(([limits, vendorLimits, toolLimits]) => ({ ...e, limits, vendorLimits, toolLimits }));
