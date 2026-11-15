import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fromDecimalString, micros } from "@/core/money";
import { microsWithEdges } from "@/core/testing/arbitraries";
import { Amount } from "./Amount";

const text = (value: bigint) => renderToStaticMarkup(<Amount value={micros(value)} />).replace(/<[^>]+>/g, "");

describe("<Amount>", () => {
  it("UI-11: shows exact amounts with up to 6 decimals", () => {
    expect(text(1500n)).toBe("$0.0015");
    expect(text(480_000_000n)).toBe("$480.00");
    expect(text(1n)).toBe("$0.000001");
    expect(text(0n)).toBe("$0.00");
  });

  // Property 3, display exactness (UI-11): "for any Micros, parsing the
  // displayed string back gives the same value." The money tests check
  // toDisplay; this checks the component shows exactly that text.
  it("UI-11: property 3, the rendered amount parses back to the same micros", () => {
    fc.assert(
      fc.property(microsWithEdges(), (m) => fromDecimalString(text(m).slice(1)) === m),
      { numRuns: 1000 },
    );
  });
});
