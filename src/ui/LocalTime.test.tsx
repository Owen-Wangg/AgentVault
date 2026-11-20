// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTime } from "./LocalTime";

const AT = "2026-11-20T07:43:55.000Z";

afterEach(cleanup);

describe("<LocalTime>", () => {
  it("UI-32: the server HTML carries the instant but no time formatted in the server's zone", () => {
    const html = renderToString(<LocalTime iso={AT} />);
    expect(html).toContain(`dateTime="${AT}"`);
    expect(html).not.toContain(new Date(AT).toLocaleString());
    expect(html).not.toContain(new Date(AT).toLocaleTimeString());
  });

  it("UI-32: after hydration the text is the browser's own date and time", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<LocalTime iso={AT} />);
    document.body.append(container);
    await act(async () => {
      hydrateRoot(container, <LocalTime iso={AT} />);
    });
    expect(container.querySelector("time")?.textContent).toBe(new Date(AT).toLocaleString());
    container.remove();
  });

  it("UI-32: rendered in the browser, the text is there at once, as a date and time or a time only", () => {
    const { container } = render(
      <>
        <LocalTime iso={AT} />
        <LocalTime iso={AT} format="time" className="text-xs" />
      </>,
    );
    const [both, time] = container.querySelectorAll("time");
    expect(both?.textContent).toBe(new Date(AT).toLocaleString());
    expect(time?.textContent).toBe(new Date(AT).toLocaleTimeString());
    expect(time?.getAttribute("class")).toBe("text-xs");
  });
});
