import { describe, expect, it } from "vitest";
import { formatTable, runDemo } from "./demo-policy";

const summary = () => runDemo().map((r) => [r.label, r.decision.decision, ...r.decision.reasons.map((x) => x.code)]);

describe("demo:policy", () => {
  it("ENV-10, ENV-11: the sample sequence gives the expected decisions and every reason", () => {
    expect(summary()).toEqual([
      ["normal call", "allow"],
      ["normal call", "allow"],
      ["normal call", "allow"],
      ["large refund", "hold", "NEEDS_APPROVAL"],
      ["over tx max", "deny", "OVER_TX_MAX", "OVER_WINDOW_CAP"],
      ["big call", "allow"],
      ["over minute cap", "deny", "OVER_WINDOW_CAP"],
      ["vendor not allowed", "deny", "VENDOR_NOT_ALLOWED"],
      ["number amount", "deny", "INVALID_REQUEST"],
      ["burst (new minute)", "allow"],
      ...Array.from({ length: 9 }, () => ["burst", "allow"]),
      ["burst", "deny", "VELOCITY_EXCEEDED"],
      ["burst", "deny", "AGENT_FROZEN", "VELOCITY_EXCEEDED"],
    ]);
  });

  it("ENV-13: the table is the same on every run", () => {
    expect(formatTable(runDemo())).toBe(formatTable(runDemo()));
  });
});
