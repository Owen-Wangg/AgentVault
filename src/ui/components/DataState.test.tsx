// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataState } from "./DataState";

afterEach(cleanup);

describe("<DataState>", () => {
  it("UI-15: shows a polite loading status", () => {
    render(<DataState status="loading" empty="Nothing here" />);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  });

  it("UI-15, UI-19: loading is a skeleton hidden from screen readers, with the words for screen readers only", () => {
    render(<DataState status="loading" empty="Nothing here" />);
    const status = screen.getByRole("status");
    const skeleton = screen.getByTestId("skeleton");
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton.children.length).toBeGreaterThan(1);
    // The pulse is a CSS animation, which globals.css stops under reduced motion.
    expect(skeleton.className).toContain("animate-pulse");
    expect(status.querySelector(".sr-only")?.textContent).toBe("Loading…");
    expect(status.className).not.toContain("border-dashed");
  });

  it("UI-15: shows the empty message", () => {
    render(<DataState status="empty" empty="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });

  it("UI-15: shows an error as an alert with a retry button that works", () => {
    const retry = vi.fn();
    render(<DataState status="error" empty="" onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("UI-15: renders its children when the data is ready", () => {
    render(
      <DataState status="ready" empty="Nothing here">
        <p>the table</p>
      </DataState>,
    );
    expect(screen.getByText("the table")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
