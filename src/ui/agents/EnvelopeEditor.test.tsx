// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvelopeWire } from "@/core/policy";
import { EnvelopeEditor, type SaveEnvelope } from "./EnvelopeEditor";

afterEach(cleanup);

const initial: EnvelopeWire = {
  limits: { txMaxMicros: "5000000", windowCapsMicros: { day: "20000000" }, callsPerMinute: 30, approvalThresholdMicros: "1000000" },
  vendorLimits: { "nimbus-weather": { txMaxMicros: "1500" } },
  toolLimits: {},
  allowedVendors: "*",
  allowedTools: ["x402.pay", "mpp.pay"],
  expectedVersion: 4,
};

function setup(save: SaveEnvelope = vi.fn(async () => ({ status: 200, body: { version: 5 } })), readOnly = false) {
  render(<EnvelopeEditor initial={initial} version={4} readOnly={readOnly} save={save} />);
  return save as ReturnType<typeof vi.fn>;
}

const field = (label: string, index = 0) => screen.getAllByLabelText(label)[index] as HTMLInputElement;
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Save envelope" }));

describe("<EnvelopeEditor>", () => {
  it("UI-8, UI-11: shows stored limits as exact dollars", () => {
    setup();
    expect(field("Per-transaction maximum ($)").value).toBe("5");
    expect(field("Cap per day ($)").value).toBe("20");
    expect(field("Approval threshold ($)").value).toBe("1");
    expect(field("Calls per minute").value).toBe("30");
    // The nimbus-weather row's limit is the second per-transaction field.
    expect(field("Per-transaction maximum ($)", 1).value).toBe("0.0015");
    expect(field("Cap per minute ($)").value).toBe("");
  });

  it("UI-8: validates every limit before saving and doesn't save an invalid one", async () => {
    const save = setup();
    fireEvent.change(field("Per-transaction maximum ($)"), { target: { value: "0.0000001" } });
    fireEvent.change(field("Calls per minute"), { target: { value: "lots" } });
    submit();
    expect(await screen.findByText("Enter dollars with up to 6 decimal places, like 5 or 0.0015")).toBeTruthy();
    expect(screen.getByText(/Enter a whole number/)).toBeTruthy();
    expect(field("Per-transaction maximum ($)").getAttribute("aria-invalid")).toBe("true");
    expect(save).not.toHaveBeenCalled();
  });

  it("UI-8: saves amounts typed in dollars as micros strings, with the loaded version", async () => {
    const save = setup();
    fireEvent.change(field("Per-transaction maximum ($)"), { target: { value: "0.0015" } });
    fireEvent.change(field("Cap per hour ($)"), { target: { value: "12.5" } });
    fireEvent.change(field("Cap per day ($)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tool limit" }));
    fireEvent.change(field("Name", 1), { target: { value: "stripe.refund" } });
    fireEvent.change(field("Per-transaction maximum ($)", 2), { target: { value: "500" } });
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toEqual({
      limits: { txMaxMicros: "1500", approvalThresholdMicros: "1000000", callsPerMinute: 30, windowCapsMicros: { hour: "12500000" } },
      vendorLimits: { "nimbus-weather": { txMaxMicros: "1500" } },
      toolLimits: { "stripe.refund": { txMaxMicros: "500000000" } },
      allowedVendors: "*",
      allowedTools: ["x402.pay", "mpp.pay"],
      expectedVersion: 4,
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("UI-8: a second save sends the version the first save returned", async () => {
    const save = setup();
    submit();
    await screen.findByText("Saved.");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].expectedVersion).toBe(5);
  });

  it("UI-8: says so when someone else changed the envelope first", async () => {
    setup(vi.fn(async () => ({ status: 409, body: { error: "ENVELOPE_CHANGED", version: 6 } })));
    submit();
    expect(await screen.findByText(/Someone else changed this envelope/)).toBeTruthy();
  });

  it("UI-8: an allow-list switched to Allow all saves as *, whatever its text says", async () => {
    const save = setup();
    fireEvent.click(screen.getAllByLabelText("Allow all")[1]!);
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0].allowedTools).toBe("*");
  });

  it("UI-21: in the sandbox every field is disabled and there is no save button", () => {
    setup(undefined, true);
    expect(screen.getByRole("note").textContent).toContain("read-only");
    expect(field("Per-transaction maximum ($)").matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save envelope" })).toBeNull();
  });
});
