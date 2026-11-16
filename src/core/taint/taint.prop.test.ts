import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_MICROS, type Rail, micros } from "@/core/money";
import { evaluate } from "@/core/policy/evaluate";
import type { EvaluateInput } from "@/core/policy/types";
import { evaluateInputArb, withoutApproval } from "@/core/testing/arbitraries";
import { isHighPrivilege } from "./rules";
import { type FetchOutcome, type TaintState, afterFetch } from "./session";

const RUNS = { numRuns: 1000 };

type Op = { kind: "fetch"; outcome: FetchOutcome } | { kind: "request"; input: EvaluateInput };

const fetchOp: fc.Arbitrary<Op> = fc
  .oneof(
    fc.constant<FetchOutcome>({ ok: false }),
    fc.record({
      ok: fc.constant(true as const),
      label: fc.constantFrom("trusted" as const, "untrusted" as const),
      url: fc.constantFrom("https://docs.stripe.com/", "https://agentvault.example/vendor/docs/integration"),
      contentSha256: fc.constant("ab".repeat(32)),
      at: fc.constantFrom("2026-11-21T10:00:00.000Z", "2026-11-21T10:05:00.000Z"),
    }),
  )
  .map((outcome) => ({ kind: "fetch" as const, outcome }));

const requestOp: fc.Arbitrary<Op> = evaluateInputArb().map((input) => ({ kind: "request" as const, input }));

describe("taint properties", () => {
  // Property 1, no privileged execution after taint (TAINT-5, TAINT-6): for
  // any sequence of fetches and tool requests in which at least one
  // untrusted fetch happens, no privileged tool request after it reaches
  // `allow` unless an approval for `HELD_TAINTED` is attached.
  // About a third of the generated requests are approval re-runs (HITL-2).
  it("TAINT-5, TAINT-6: after an untrusted fetch, no privileged tool request is allowed without an approval", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fetchOp, requestOp), { minLength: 1, maxLength: 20 }), (ops) => {
        let taint: TaintState = { taintedAt: null, taintSourceUrl: null, taintContentSha256: null };
        let sawUntrusted = false;
        for (const op of ops) {
          if (op.kind === "fetch") {
            taint = afterFetch(taint, op.outcome);
            if (op.outcome.ok && op.outcome.label === "untrusted") sawUntrusted = true;
            continue;
          }
          const input: EvaluateInput = {
            ...op.input,
            session: { ...op.input.session, taintedAt: taint.taintedAt, taintSourceUrl: taint.taintSourceUrl },
          };
          const decision = evaluate(input);
          const held = decision.reasons.some((r) => r.code === "HELD_TAINTED");
          const taintApproved = input.approvedHoldReasons?.includes("HELD_TAINTED") ?? false;
          if (sawUntrusted && isHighPrivilege(input.tool) && !taintApproved) {
            expect(decision.decision).not.toBe("allow");
            expect(held).toBe(true);
          } else {
            // TAINT-7: without a taint, or for an ordinary tool, the taint rule adds nothing.
            // HITL-2: with the taint approved, HELD_TAINTED is dropped.
            expect(held).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });

  // Property 1 again, on requests that every other rule allows, so the
  // taint rule is the only thing between the request and `allow`.
  it("TAINT-6: a high-privilege request that would otherwise be allowed is held once the session is tainted", () => {
    const permissive = evaluateInputArb().map((input): EvaluateInput => ({
      ...withoutApproval(input),
      request: { ...input.request, vendorCategory: "weather" },
      envelope: { ...input.envelope, limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
      window: { ...input.window, callsLastMinute: 0 },
      session: { ...input.session, agentFrozen: false, sessionSpentMicros: micros(0n), taintedAt: null, taintSourceUrl: null },
      scope: { ...input.scope, allowedVendorCategories: ["weather"], allowedTools: [input.request.tool], budgetMicros: MAX_MICROS },
    }));
    fc.assert(
      fc.property(permissive, (input) => {
        expect(evaluate(input)).toEqual({ decision: "allow", reasons: [] });
        const tainted = { ...input, session: { ...input.session, taintedAt: "2026-11-21T10:00:00.000Z", taintSourceUrl: "https://example.com/" } };
        const decision = evaluate(tainted);
        if (isHighPrivilege(input.tool)) expect(decision).toMatchObject({ decision: "hold", reasons: [{ code: "HELD_TAINTED" }] });
        else expect(decision).toEqual({ decision: "allow", reasons: [] });
      }),
      RUNS,
    );
  });

  // payout-rails property 4, taint holds payouts on every rail (PO-19):
  // after any untrusted fetch, no payout.create, paypal.payout, or
  // payee.update reaches `allow` without an approval, whatever its rail or
  // the registry's flag. Half the inputs pass every other rule, so the
  // taint rule is the only thing between them and `allow`.
  it("PO-18, PO-19: in a tainted session, payouts and payee changes are held on every rail, whatever the privileged flag", () => {
    const payoutInput = fc
      .tuple(
        evaluateInputArb(),
        fc.constantFrom("payout.create", "paypal.payout", "payee.update"),
        fc.boolean(),
        fc.constantFrom<Rail | null>("stripe", "x402", "mock", "paypal", null),
        fc.boolean(),
      )
      .map(([input, name, privileged, rail, otherwisePermissive]): EvaluateInput => {
        const base: EvaluateInput = {
          ...withoutApproval(input),
          request: { ...input.request, tool: name },
          tool: { name, privileged, rail },
          session: { ...input.session, taintedAt: "2026-11-21T10:00:00.000Z", taintSourceUrl: "https://agentvault.example/vendor/docs/invoice" },
        };
        if (!otherwisePermissive) return base;
        return {
          ...base,
          request: { ...base.request, vendorCategory: "suppliers" },
          envelope: { ...base.envelope, limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
          window: { ...base.window, callsLastMinute: 0 },
          session: { ...base.session, agentFrozen: false, sessionSpentMicros: micros(0n) },
          scope: { ...base.scope, allowedVendorCategories: ["suppliers"], allowedTools: [name], budgetMicros: MAX_MICROS },
        };
      });
    fc.assert(
      fc.property(payoutInput, (input) => {
        const decision = evaluate(input);
        expect(decision.decision).not.toBe("allow");
        expect(decision.reasons.map((r) => r.code)).toContain("HELD_TAINTED");
      }),
      RUNS,
    );
  });

  // TAINT-9 (HITL-2): an approved HELD_TAINTED request executes only if all
  // other rules still pass. Checked on requests that every other rule
  // allows, then with exactly one other rule broken.
  it("TAINT-9: an approved tainted request is allowed only while every other rule passes", () => {
    const TAINTED = { taintedAt: "2026-11-21T10:00:00.000Z", taintSourceUrl: "https://example.com/" };
    const breakOne = fc.constantFrom<[string, (i: EvaluateInput) => EvaluateInput]>(
      ["frozen", (i) => ({ ...i, session: { ...i.session, agentFrozen: true } })],
      ["tx max", (i) => ({ ...i, envelope: { ...i.envelope, limits: { txMaxMicros: micros(0n) } } })],
      ["tool not allowed", (i) => ({ ...i, envelope: { ...i.envelope, allowedTools: [] } })],
      ["intent drift", (i) => ({ ...i, scope: { ...i.scope, allowedTools: [] } })],
      ["task budget", (i) => ({ ...i, scope: { ...i.scope, budgetMicros: micros(0n) } })],
      ["velocity", (i) => ({ ...i, envelope: { ...i.envelope, limits: { callsPerMinute: 0 } } })],
    );
    const permissivePrivileged = evaluateInputArb()
      .filter((input) => input.request.amountMicros > 0n)
      .map((input): EvaluateInput => ({
        ...withoutApproval(input),
        request: { ...input.request, vendorCategory: "weather" },
        envelope: { ...input.envelope, limits: {}, vendorLimits: {}, toolLimits: {}, allowedVendors: "*", allowedTools: "*" },
        window: { ...input.window, callsLastMinute: 0 },
        session: { ...input.session, agentFrozen: false, sessionSpentMicros: micros(0n), ...TAINTED },
        scope: { ...input.scope, allowedVendorCategories: ["weather"], allowedTools: [input.request.tool], budgetMicros: MAX_MICROS },
        tool: { ...input.tool, privileged: true },
      }));
    fc.assert(
      fc.property(permissivePrivileged, breakOne, (input, [, broken]) => {
        expect(evaluate(input)).toMatchObject({ decision: "hold", reasons: [{ code: "HELD_TAINTED" }] });
        const approved: EvaluateInput = { ...input, approvedHoldReasons: ["HELD_TAINTED"] };
        expect(evaluate(approved)).toEqual({ decision: "allow", reasons: [] });
        const failing = evaluate(broken(approved));
        expect(failing.decision).toBe("deny");
        expect(failing.reasons.map((r) => r.code)).not.toContain("HELD_TAINTED");
      }),
      RUNS,
    );
  });
});