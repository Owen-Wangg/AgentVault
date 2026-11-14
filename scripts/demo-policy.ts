// `pnpm demo:policy`: run a sample request sequence through evaluate() and
// print each decision with its reasons (money-and-policy-core task 6).
// The clock is simulated, so the output is the same on every run.
import { fileURLToPath } from "node:url";
import { type Micros, fromDecimalString, micros, sum, toDisplay } from "@/core/money";
import { type Decision, type Envelope, type EvaluateInput, WINDOWS, type Window, evaluate } from "@/core/policy";

const WINDOW_SECONDS: Record<Window, number> = { minute: 60, hour: 3_600, day: 86_400 };

export const DEMO_ENVELOPE: Envelope = {
  agentId: "demo-agent",
  limits: {
    txMaxMicros: fromDecimalString("1"),
    windowCapsMicros: { minute: fromDecimalString("1"), day: fromDecimalString("5") },
    callsPerMinute: 10,
    approvalThresholdMicros: fromDecimalString("0.75"),
  },
  vendorLimits: {},
  toolLimits: {},
  allowedVendors: ["nimbus-weather", "stripe"],
  allowedTools: ["x402.pay", "stripe.refund"],
};

interface DemoStep {
  label: string;
  /** Seconds since the previous step. */
  dt: number;
  vendor: string;
  tool: string;
  /** A decimal dollar string, or a JavaScript number to show invalid input. */
  amount: string | number;
}

const weather = (label: string, dt = 1): DemoStep => ({ label, dt, vendor: "nimbus-weather", tool: "x402.pay", amount: "0.0015" });

export const DEMO_STEPS: readonly DemoStep[] = [
  weather("normal call", 0),
  weather("normal call"),
  weather("normal call"),
  { label: "large refund", dt: 1, vendor: "stripe", tool: "stripe.refund", amount: "0.90" },
  { label: "over tx max", dt: 1, vendor: "nimbus-weather", tool: "x402.pay", amount: "2" },
  { label: "big call", dt: 1, vendor: "nimbus-weather", tool: "x402.pay", amount: "0.60" },
  { label: "over minute cap", dt: 1, vendor: "nimbus-weather", tool: "x402.pay", amount: "0.60" },
  { label: "vendor not allowed", dt: 1, vendor: "gpu-cloud", tool: "x402.pay", amount: "0.01" },
  { label: "number amount", dt: 1, vendor: "nimbus-weather", tool: "x402.pay", amount: 1500 },
  weather("burst (new minute)", 61),
  ...Array.from({ length: 11 }, () => weather("burst", 0)),
];

export interface DemoRow {
  step: number;
  t: number;
  label: string;
  vendor: string;
  tool: string;
  amount: string;
  minuteSpent: string;
  callsLastMinute: number;
  decision: Decision;
}

/**
 * Run the steps the way the server would: compute window state from what
 * has executed, evaluate, execute only allowed requests, count every
 * well-formed call toward calls per minute, and freeze the agent when
 * VELOCITY_EXCEEDED is returned (ENV-4, done by the server).
 */
export function runDemo(envelope: Envelope = DEMO_ENVELOPE, steps: readonly DemoStep[] = DEMO_STEPS): DemoRow[] {
  const executed: { t: number; amount: Micros }[] = [];
  const calls: number[] = [];
  let frozen = false;
  let now = 0;
  return steps.map((step, i) => {
    now += step.dt;
    const spent = Object.fromEntries(
      WINDOWS.map((w) => [w, sum(executed.filter((e) => now - e.t < WINDOW_SECONDS[w]).map((e) => e.amount))]),
    ) as Record<Window, Micros>;
    const callsLastMinute = calls.filter((t) => now - t < WINDOW_SECONDS.minute).length;
    const amount = typeof step.amount === "string" ? fromDecimalString(step.amount) : step.amount;
    const refund = step.tool === "stripe.refund";
    const input = {
      request: {
        kind: step.tool === "x402.pay" ? "pay" : "tool",
        agentId: envelope.agentId,
        sessionId: "demo-session",
        vendor: step.vendor,
        vendorCategory: "weather",
        tool: step.tool,
        amountMicros: amount,
        idempotencyKey: `demo-${i + 1}`,
      },
      envelope,
      // Vendor and tool spend match agent spend here, since no vendor or tool limits are set.
      window: { spentMicros: spent, vendorSpentMicros: spent, toolSpentMicros: spent, callsLastMinute },
      session: { sessionId: "demo-session", agentFrozen: frozen, taintedAt: null, taintSourceUrl: null, sessionSpentMicros: micros(0n) },
      scope: { taskId: "demo-task", allowedVendorCategories: ["weather"], allowedTools: ["x402.pay", "stripe.refund"], budgetMicros: fromDecimalString("10") },
      tool: { name: step.tool, privileged: refund, rail: refund ? "stripe" : "x402" },
    } as EvaluateInput; // the "number amount" step is deliberately not a valid EvaluateInput
    const decision = evaluate(input);
    const valid = typeof amount === "bigint";
    if (valid) calls.push(now); // the HTTP layer rejects malformed bodies before claiming a call
    if (decision.decision === "allow" && valid) executed.push({ t: now, amount });
    if (decision.reasons.some((r) => r.code === "VELOCITY_EXCEEDED")) frozen = true;
    return {
      step: i + 1,
      t: now,
      label: step.label,
      vendor: step.vendor,
      tool: step.tool,
      amount: valid ? toDisplay(amount) : `${String(step.amount)} (number)`,
      minuteSpent: toDisplay(spent.minute),
      callsLastMinute,
      decision,
    };
  });
}

function formatReasons(d: Decision): string {
  if (d.reasons.length === 0) return "-";
  return d.reasons
    .map((r) => (r.detail ? `${r.code}(${Object.entries(r.detail).map(([k, v]) => `${k}=${v}`).join(", ")})` : r.code))
    .join(", ");
}

export function formatTable(rows: readonly DemoRow[]): string {
  const header = ["#", "t(s)", "step", "vendor", "tool", "amount", "spent/min", "calls/min", "decision", "reasons"];
  const body = rows.map((r) => [
    String(r.step),
    String(r.t),
    r.label,
    r.vendor,
    r.tool,
    r.amount,
    r.minuteSpent,
    String(r.callsLastMinute),
    r.decision.decision.toUpperCase(),
    formatReasons(r.decision),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...body.map((row) => (row[c] ?? "").length)));
  const line = (cells: readonly string[]) => cells.map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c] ?? 0))).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

function main() {
  const l = DEMO_ENVELOPE.limits;
  console.log("AgentVault policy demo");
  console.log(
    `Envelope: tx max ${toDisplay(l.txMaxMicros ?? micros(0n))}, ` +
      `minute cap ${toDisplay(l.windowCapsMicros?.minute ?? micros(0n))}, ` +
      `day cap ${toDisplay(l.windowCapsMicros?.day ?? micros(0n))}, ` +
      `${l.callsPerMinute} calls/min, approval at ${toDisplay(l.approvalThresholdMicros ?? micros(0n))}`,
  );
  console.log(`Allowed vendors: ${String(DEMO_ENVELOPE.allowedVendors)}. Allowed tools: ${String(DEMO_ENVELOPE.allowedTools)}.\n`);
  console.log(formatTable(runDemo()));
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();
if (invokedDirectly) main();
