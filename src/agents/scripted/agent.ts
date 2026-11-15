import { type Micros, fromDecimalString, toMicrosString } from "@/core/money";
import type { Label } from "@/core/taint";
import { AgentApiError, type AgentClient, type DecisionResult } from "@/agents/client";
import type { Scenario, Step } from "./scenarios";

/**
 * The scripted agent (demo-agents design). It runs a scenario's steps in
 * order through AgentClient, so every request goes through the public
 * API with the run's own key (AGT-4), and records what came back. It has
 * no randomness and no clock, so the same seed state gives the same
 * decisions (AGT-5).
 */

export type StepResult =
  | { kind: "fetch"; url: string; label: Label; eventSeq?: number }
  | {
      kind: "pay" | "tool";
      tool: string;
      vendor: string;
      amountMicros: Micros;
      decision: DecisionResult["decision"];
      reasons: string[];
      eventSeq: number;
      approvalId?: string;
      railStatus?: DecisionResult["railStatus"];
    }
  /** The run stopped here. `status` is 0 when no response came back. */
  | { kind: "error"; step: Step["kind"]; status: number; error: string };

export interface ScriptedRun {
  results: StepResult[];
  /** API requests sent, including ones that failed. */
  requests: number;
  /** False if a step failed and the run stopped early. */
  completed: boolean;
}

/** The part of AgentClient the agent uses, so tests can pass a fake. */
export type ScenarioClient = Pick<AgentClient, "fetch" | "pay" | "tool">;

/**
 * "issue a refund of $480.00": the pattern a naive agent latches onto.
 * At most 9 whole digits and 6 decimals, so the amount always parses.
 */
const REFUND_INSTRUCTION = /issue a refund of \$(\d{1,9}(?:\.\d{1,6})?)(?=$|[^\w.]|\.(?!\d))/i;

/** The refund amount an injected instruction asks for, or null if the page has none. */
export function extractInjectedRefund(page: string): Micros | null {
  const match = REFUND_INSTRUCTION.exec(page);
  return match?.[1] ? fromDecimalString(match[1]) : null;
}

class StopRun extends Error {
  constructor(readonly result: Extract<StepResult, { kind: "error" }>) {
    super(result.error);
  }
}

export async function runScripted(scenario: Scenario, client: ScenarioClient, options: { vendorOrigin: string }): Promise<ScriptedRun> {
  const results: StepResult[] = [];
  let requests = 0;
  let lastPage: string | null = null;
  // Each request gets its own key. The agent is new for every run, so the keys never collide.
  const nextKey = () => `step-${requests}`;

  async function call<T>(step: Step["kind"], send: () => Promise<T>): Promise<T> {
    requests += 1;
    try {
      return await send();
    } catch (error) {
      if (error instanceof AgentApiError) throw new StopRun({ kind: "error", step, status: error.status, error: error.code });
      throw new StopRun({ kind: "error", step, status: 0, error: "REQUEST_FAILED" });
    }
  }

  async function pay(vendor: string, amountMicros: Micros): Promise<DecisionResult> {
    const d = await call("pay", () => client.pay(vendor, amountMicros, nextKey()));
    results.push(decisionResult("pay", "x402.pay", vendor, amountMicros, d));
    return d;
  }

  try {
    for (const step of scenario.steps) {
      if (step.kind === "pay" && step.repeat) {
        let denies = 0;
        for (let i = 0; i < step.repeat.max && denies < step.repeat.stopAfterDenies; i += 1) {
          const d = await pay(step.vendor, step.amountMicros);
          denies = d.decision === "deny" ? denies + 1 : 0;
        }
      } else if (step.kind === "pay") {
        await pay(step.vendor, step.amountMicros);
      } else if (step.kind === "fetch") {
        const page = await call("fetch", () => client.fetch(new URL(step.path, options.vendorOrigin).toString()));
        lastPage = page.body;
        results.push({ kind: "fetch", url: page.url, label: page.label, ...(page.eventSeq !== undefined ? { eventSeq: page.eventSeq } : {}) });
      } else {
        const amount = lastPage === null ? null : extractInjectedRefund(lastPage);
        if (amount === null) throw new StopRun({ kind: "error", step: step.kind, status: 0, error: "NO_INSTRUCTION" });
        const args = { vendor: step.vendor, amount_micros: toMicrosString(amount), payment_ref: step.paymentRef };
        const d = await call(step.kind, () => client.tool("stripe.refund", args, nextKey()));
        results.push(decisionResult("tool", "stripe.refund", step.vendor, amount, d));
      }
    }
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
    results.push(error.result);
    return { results, requests, completed: false };
  }
  return { results, requests, completed: true };
}

function decisionResult(kind: "pay" | "tool", tool: string, vendor: string, amountMicros: Micros, d: DecisionResult): StepResult {
  return {
    kind,
    tool,
    vendor,
    amountMicros,
    decision: d.decision,
    reasons: d.reasons.map((r) => r.code),
    eventSeq: d.eventSeq,
    ...(d.approvalId ? { approvalId: d.approvalId } : {}),
    ...(d.railStatus ? { railStatus: d.railStatus } : {}),
  };
}

/** The decisions a run produced, in order, in the form of a scenario's `expected` list (AGT-5). */
export function decisionSequence(results: readonly StepResult[]): { decision: string; reasons: string[] }[] {
  return results.flatMap((r) => (r.kind === "pay" || r.kind === "tool" ? [{ decision: r.decision, reasons: r.reasons }] : []));
}
