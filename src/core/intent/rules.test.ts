import { describe, expect, it } from "vitest";
import { MAX_MICROS, micros } from "@/core/money";
import { TaskScopeSchema } from "@/core/policy/schemas";
import { baseInput, usd } from "@/core/testing/policy-fixtures";
import { UNKNOWN_CATEGORY, intentRules } from "./rules";
import type { TaskScope } from "./types";

const m = micros;
const codes = (reasons: readonly { code: string }[]) => reasons.map((r) => r.code);

const SCOPE: TaskScope = {
  taskId: "task-1",
  allowedVendorCategories: ["weather", "maps"],
  allowedTools: ["x402.pay", "stripe.refund"],
  budgetMicros: usd(1n),
};

function check(change: (input: ReturnType<typeof baseInput>) => void = () => {}, scope: TaskScope = SCOPE) {
  const input = baseInput();
  change(input);
  return intentRules(input, scope, input.request.vendorCategory);
}

describe("INT-1: task scope", () => {
  it.each(["taskId", "allowedVendorCategories", "allowedTools", "budgetMicros"] as const)("INT-1: a scope without %s is invalid input", (field) => {
    const scope: Record<string, unknown> = { ...SCOPE };
    delete scope[field];
    expect(TaskScopeSchema.safeParse(scope).success).toBe(false);
  });

  it("INT-1: a budget must be bigint micros", () => {
    expect(TaskScopeSchema.safeParse({ ...SCOPE, budgetMicros: 1_000_000 }).success).toBe(false);
    expect(TaskScopeSchema.safeParse(SCOPE).success).toBe(true);
  });
});

describe("INT-2, INT-5, INT-6: vendor category", () => {
  it("INT-2: a vendor category in scope passes", () => {
    expect(check()).toEqual([]);
  });

  it("INT-2: a vendor category outside the scope is denied with the expected and actual categories", () => {
    expect(check((i) => (i.request.vendorCategory = "compute"))).toEqual([
      { code: "DENY_INTENT_DRIFT", detail: { check: "vendor_category", expected: "weather,maps", actual: "compute" } },
    ]);
  });

  it("INT-6: an unknown vendor is denied", () => {
    expect(codes(check((i) => (i.request.vendorCategory = UNKNOWN_CATEGORY)))).toEqual(["DENY_INTENT_DRIFT"]);
  });

  it("INT-6: an unknown vendor is denied even by a task that lists the unknown category", () => {
    const scope = { ...SCOPE, allowedVendorCategories: ["weather", UNKNOWN_CATEGORY] };
    expect(check((i) => (i.request.vendorCategory = UNKNOWN_CATEGORY), scope)).toEqual([
      { code: "DENY_INTENT_DRIFT", detail: { check: "vendor_category", expected: "weather", actual: "unknown" } },
    ]);
  });

  it("INT-5: the rule uses the category it is given, not anything else in the request", () => {
    const input = baseInput();
    input.request.vendorCategory = "weather";
    expect(codes(intentRules(input, SCOPE, "compute"))).toEqual(["DENY_INTENT_DRIFT"]);
  });

  it("INT-2: a task with no categories allows no vendor", () => {
    expect(codes(check(() => {}, { ...SCOPE, allowedVendorCategories: [] }))).toEqual(["DENY_INTENT_DRIFT"]);
  });

  it("INT-2: categories match exactly, not by prefix or case", () => {
    for (const category of ["Weather", "weather ", "weath"]) {
      expect(codes(check((i) => (i.request.vendorCategory = category)))).toEqual(["DENY_INTENT_DRIFT"]);
    }
  });
});

describe("INT-3: tools", () => {
  it("INT-3: a tool outside the task's tools is denied", () => {
    expect(check((i) => (i.request.tool = "wire_transfer"))).toEqual([
      { code: "DENY_INTENT_DRIFT", detail: { check: "tool", expected: "x402.pay,stripe.refund", actual: "wire_transfer" } },
    ]);
  });

  it("INT-2, INT-3: a wrong category and a wrong tool give one reason each", () => {
    const reasons = check((i) => {
      i.request.vendorCategory = "compute";
      i.request.tool = "mpp.pay";
    });
    expect(reasons.map((r) => r.detail?.check)).toEqual(["vendor_category", "tool"]);
  });
});

describe("INT-4: task budget", () => {
  it("INT-4: spend that reaches the budget exactly passes", () => {
    expect(check((i) => {
      i.session.sessionSpentMicros = m(400_000n);
      i.request.amountMicros = m(600_000n);
    })).toEqual([]);
  });

  it("INT-4: one micro over the budget is denied with the budget and the spend so far", () => {
    expect(
      check((i) => {
        i.session.sessionSpentMicros = m(400_000n);
        i.request.amountMicros = m(600_001n);
      }),
    ).toEqual([{ code: "OVER_TASK_BUDGET", detail: { budgetMicros: "1000000", spentMicros: "400000" } }]);
  });

  it("INT-4: spend already over the budget denies even a zero amount", () => {
    expect(codes(check((i) => {
      i.session.sessionSpentMicros = m(1_000_001n);
      i.request.amountMicros = m(0n);
    }))).toEqual(["OVER_TASK_BUDGET"]);
  });

  it("INT-4: amounts near MAX_MICROS don't overflow the comparison", () => {
    const scope = { ...SCOPE, budgetMicros: MAX_MICROS };
    expect(check((i) => {
      i.session.sessionSpentMicros = MAX_MICROS;
      i.request.amountMicros = m(0n);
    }, scope)).toEqual([]);
    expect(codes(check((i) => {
      i.session.sessionSpentMicros = MAX_MICROS;
      i.request.amountMicros = m(1n);
    }, scope))).toEqual(["OVER_TASK_BUDGET"]);
  });

  it("INT-2, INT-4: every failing check is reported", () => {
    expect(codes(check((i) => {
      i.request.vendorCategory = "compute";
      i.request.tool = "payout.create";
      i.request.amountMicros = usd(2n);
    }))).toEqual(["DENY_INTENT_DRIFT", "DENY_INTENT_DRIFT", "OVER_TASK_BUDGET"]);
  });
});
