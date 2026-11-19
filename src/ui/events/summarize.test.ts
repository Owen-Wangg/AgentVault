import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_MICROS, type Micros, fromDecimalString, micros } from "@/core/money";
import { microsWithEdges } from "@/core/testing/arbitraries";
import { type AuditEventMessage, addCapped, feedRows, filterRows, isCapped, summarize } from "./summarize";

const NOW = Date.UTC(2026, 10, 24, 12, 0);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

let seq = 0;
function ev(type: string, payload: unknown, msAgo = 60_000): AuditEventMessage {
  seq += 1;
  return { workspace_id: "w", seq, type, created_at: iso(msAgo), payload, prev_hash: "", hash: "" };
}
const decision = (decision: "allow" | "hold" | "deny", amount: string, codes: string[] = [], msAgo?: number, agent = "a1") =>
  ev(
    "decision",
    {
      agent_id: agent,
      request: { vendor: "nimbus-weather", tool: "x402.pay", amount_micros: amount, counted_micros: amount, session_id: "s", idempotency_key: "k" },
      decision,
      reasons: codes.map((code) => ({ code, detail: { limit: "1", __proto__: "x" } })),
    },
    msAgo,
  );
const rail = (decisionSeq: number, status: "settled" | "failed" | "unknown", settled?: string, msAgo?: number) =>
  ev("rail_result", { status, rail: "mock", decision_seq: decisionSeq, ...(settled ? { settled_micros: settled } : {}) }, msAgo);

describe("advisory drift score on a decision", () => {
  const scored = (score: unknown) =>
    ev("decision", { agent_id: "a1", request: { vendor: "gpu-cloud", tool: "x402.pay", amount_micros: "250000", advisory_drift_score: score }, decision: "hold", reasons: [{ code: "ADVISORY_DRIFT" }] });

  it("AGT-16: a row carries the score the live agent sent", () => {
    expect(feedRows([scored(85)])[0]?.advisoryDriftScore).toBe(85);
    expect(feedRows([decision("allow", "1500")])[0]).not.toHaveProperty("advisoryDriftScore");
  });

  it.each([101, -1, 7.5, "85", null])("AGT-16: a malformed score (%j) is dropped and the row still shows", (score) => {
    const [row] = feedRows([scored(score)]);
    expect(row?.decision).toBe("hold");
    expect(row).not.toHaveProperty("advisoryDriftScore");
  });
});

describe("payee changes in the feed", () => {
  const change = (decisionSeq: number, oldRef: string | null) =>
    ev("payee_updated", { vendor: "acme-supplies", rail: "stripe", old_ref: oldRef, new_ref: "acct_1AttackerSandbox", decision_seq: decisionSeq });

  it("PO-12: a payee_updated event attaches the old and new destinations to its decision row", () => {
    const d = decision("allow", "0");
    const [row] = feedRows([d, rail(d.seq, "settled"), change(d.seq, "acct_1AcmeSupplies")]);
    expect(row?.payeeChange).toEqual({ rail: "stripe", oldRef: "acct_1AcmeSupplies", newRef: "acct_1AttackerSandbox" });
    expect(row?.railStatus).toBe("settled");
  });

  it("PO-12: a first destination has no old reference, and a malformed event is skipped", () => {
    const d = decision("allow", "0");
    expect(feedRows([d, change(d.seq, null)])[0]?.payeeChange).toEqual({ rail: "stripe", oldRef: null, newRef: "acct_1AttackerSandbox" });
    const d2 = decision("allow", "0");
    expect(feedRows([d2, ev("payee_updated", { decision_seq: d2.seq, new_ref: 5 })])[0]).not.toHaveProperty("payeeChange");
  });
});

describe("payout destinations in the feed", () => {
  const payout = (decisionSeq: number, status: "settled" | "failed" | "unknown", to: unknown) =>
    ev("rail_result", { status, rail: "stripe", decision_seq: decisionSeq, payout_to: to, ...(status === "settled" ? { settled_micros: "900000000" } : {}) });

  it("PO-24: a settled payout's row says where the money went", () => {
    const d = decision("allow", "900000000");
    expect(feedRows([d, payout(d.seq, "settled", "acct_1AcmeSupplies")])[0]?.payoutTo).toBe("acct_1AcmeSupplies");
  });

  it("PO-24: a payout that failed or isn't known yet names no destination, and a malformed one is skipped", () => {
    for (const status of ["failed", "unknown"] as const) {
      const d = decision("allow", "900000000");
      expect(feedRows([d, payout(d.seq, status, "acct_1AcmeSupplies")])[0]).not.toHaveProperty("payoutTo");
    }
    const d = decision("allow", "900000000");
    const [row] = feedRows([d, payout(d.seq, "settled", 42)]);
    expect(row).not.toHaveProperty("payoutTo");
    expect(feedRows([decision("allow", "1500")])[0]).not.toHaveProperty("payoutTo");
  });
});

describe("feed rows", () => {
  it("UI-6: one row per decision, newest first, with the rail outcome attached and amounts as exact micros", () => {
    const d1 = decision("allow", "1500");
    const d2 = decision("deny", "480000000", ["OVER_TX_MAX"]);
    const r1 = rail(d1.seq, "unknown");
    const rows = feedRows([d1, d2, r1, ev("taint", { agent_id: "a1", url: "https://x" })]);
    expect(rows.map((r) => [r.seq, r.decision, r.amountMicros, r.railStatus])).toEqual([
      [d2.seq, "deny", 480_000_000n, undefined],
      [d1.seq, "allow", 1500n, "unknown"],
    ]);
    expect(rows[0]!.reasons).toEqual([{ code: "OVER_TX_MAX", detail: { limit: "1" } }]);
  });

  it("UI-6: skips events it can't read instead of failing the page", () => {
    const rows = feedRows([ev("decision", { decision: "allow" }), ev("decision", null), decision("allow", "1.5"), decision("hold", "10")]);
    expect(rows.map((r) => r.decision)).toEqual(["hold"]);
  });

  it("UI-6: filters by agent, decision, and reason", () => {
    const rows = feedRows([
      decision("allow", "1", [], 1, "a1"),
      decision("deny", "2", ["VENDOR_NOT_ALLOWED"], 1, "a2"),
      decision("hold", "3", ["HELD_TAINTED", "NEEDS_APPROVAL"], 1, "a1"),
    ]);
    expect(filterRows(rows, { agentId: "a1" }).map((r) => r.amountMicros)).toEqual([3n, 1n]);
    expect(filterRows(rows, { decision: "deny" }).map((r) => r.agentId)).toEqual(["a2"]);
    expect(filterRows(rows, { reason: "NEEDS_APPROVAL" }).map((r) => r.decision)).toEqual(["hold"]);
    expect(filterRows(rows, {})).toHaveLength(3);
  });
});

describe("overview", () => {
  it("UI-5: spend is settled rail amounts, blocked is denied amounts, and both respect the range", () => {
    const allowed = decision("allow", "1500");
    const events = [
      allowed,
      rail(allowed.seq, "settled", "1500"),
      decision("deny", "480000000", ["OVER_TX_MAX"]),
      decision("deny", "7", ["OVER_TX_MAX"], 2 * 86_400_000), // two days ago
      rail(allowed.seq, "unknown"),
      rail(allowed.seq, "settled", "2000000", 2 * 86_400_000),
    ];
    const day = summarize(events, "day", NOW);
    expect(day.spendMicros).toBe(1500n);
    expect(day.blockedMicros).toBe(480_000_000n);
    expect(day.decisions).toEqual({ allow: 1, hold: 0, deny: 1 });
    const all = summarize(events, "all", NOW);
    expect(all.spendMicros).toBe(2_001_500n);
    expect(all.blockedMicros).toBe(480_000_007n);
  });

  it("UI-5: counts approvals still pending and agents still frozen", () => {
    const events = [
      ev("approval_created", { approval_id: "p1" }),
      ev("approval_created", { approval_id: "p2" }),
      ev("approval_created", { approval_id: "p3" }),
      ev("approval_decided", { approval_id: "p1", status: "approved" }),
      ev("approval_expired", { approval_id: "p3" }),
      ev("agent_frozen", { agent_id: "a1" }),
      ev("agent_frozen", { agent_id: "a2" }),
      ev("agent_unfrozen", { agent_id: "a1" }),
    ];
    const o = summarize(events, "hour", NOW);
    expect(o.pendingApprovals).toBe(1);
    expect(o.frozenAgents).toEqual(["a2"]);
    expect(o.alerts.map((a) => a.kind)).toEqual(["frozen", "frozen"]);
  });

  it("UI-5: recent alerts are denials, holds, freezes, and taints, newest first, at most 8", () => {
    const events = [decision("allow", "1"), ev("taint", { agent_id: "a1", url: "https://docs.example" }), ...Array.from({ length: 10 }, () => decision("deny", "1", ["OVER_TX_MAX"]))];
    const o = summarize(events, "day", NOW);
    expect(o.alerts).toHaveLength(8);
    expect(o.alerts.every((a) => a.kind === "decision" && a.row.decision === "deny")).toBe(true);
    expect(o.alerts.map((a) => a.seq)).toEqual([...o.alerts.map((a) => a.seq)].sort((x, y) => y - x));
  });

  // UI-5 property: the spend-over-time series adds up to the total spend, so
  // the chart and the KPI card never disagree, for any events and any range.
  it("UI-5: the spend series always adds up to the total spend card", () => {
    const eventArb = fc.record({
      msAgo: fc.oneof(fc.integer({ min: 0, max: 3_600_000 }), fc.integer({ min: 0, max: 30 * 86_400_000 })),
      amount: microsWithEdges(),
      status: fc.constantFrom("settled", "failed", "unknown"),
    });
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), fc.constantFrom("hour", "day", "week", "all"), (items, range) => {
        seq = 0;
        const events = items
          .sort((a, b) => b.msAgo - a.msAgo)
          .map((i) => rail(0, i.status as "settled", i.amount.toString(), i.msAgo));
        const o = summarize(events, range as "hour", NOW);
        const seriesTotal = o.spendSeries.reduce<Micros>((sum, b) => addCapped(sum, b.spendMicros), micros(0n));
        expect(seriesTotal).toBe(o.spendMicros);
        expect(o.spendSeries.length).toBeGreaterThan(0);
        expect(o.spendSeries.every((b, i, all) => i === 0 || b.start > all[i - 1]!.start)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("UI-5: a total past the largest amount stops there instead of throwing (seed 554141298)", () => {
    // Found by the property above: add() range-checks every result, so a
    // range with two maximum-size payments threw and broke the overview.
    const big = MAX_MICROS.toString();
    const events = [rail(0, "settled", big), rail(0, "settled", big), decision("deny", big), decision("deny", big)];
    const o = summarize(events, "day", NOW);
    expect(o.spendMicros).toBe(MAX_MICROS);
    expect(o.blockedMicros).toBe(MAX_MICROS);
    expect(isCapped(o.spendMicros)).toBe(true);
    expect(isCapped(addCapped(micros(1n), micros(2n)))).toBe(false);
  });

  it("UI-11: sums exact sub-cent amounts without rounding", () => {
    const events = Array.from({ length: 3 }, () => decision("deny", fromDecimalString("0.0015").toString()));
    expect(summarize(events, "day", NOW).blockedMicros).toBe(4500n);
  });
});

describe("requested payee on a payee.update decision", () => {
  const change = (args: unknown, tool = "payee.update") =>
    ev("decision", { agent_id: "a1", request: { vendor: "acme-supplies", tool, amount_micros: "0", args }, decision: "hold", reasons: [{ code: "HELD_TAINTED" }] });

  it("UI-25: a held payee.update carries the account the agent asked to switch to", () => {
    expect(feedRows([change({ vendor: "acme-supplies", payee_ref: "acct_1AttackerPayout", rail: "stripe" })])[0]?.requestedPayee).toBe("acct_1AttackerPayout");
  });

  it("UI-25: only payee.update gets one, and decisions without arguments get none", () => {
    expect(feedRows([change({ payee_ref: "acct_1AttackerPayout" }, "payout.create")])[0]).not.toHaveProperty("requestedPayee");
    expect(feedRows([decision("allow", "1500")])[0]).not.toHaveProperty("requestedPayee");
  });

  it.each([42, null, "", "x".repeat(201), ["acct_1"], "not-an-object"])("UI-25: a malformed payee_ref (%j) is dropped and the row still shows", (ref) => {
    const args = ref === "not-an-object" ? "acct_1" : { payee_ref: ref };
    const [row] = feedRows([change(args)]);
    expect(row?.decision).toBe("hold");
    expect(row).not.toHaveProperty("requestedPayee");
  });
});