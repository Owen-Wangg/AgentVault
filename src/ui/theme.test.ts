import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, THEMES, TOKENS, TOKEN_NAMES, contrastRatio } from "./theme";

const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

/** The custom properties declared in the block whose selector contains `selector`. */
function declared(selector: string): Record<string, string> {
  const block = new RegExp(`${selector.replace(/[[\]"]/g, "\\$&")}[^{]*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`No block for ${selector}`);
  return Object.fromEntries([...block[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

describe("theme tokens", () => {
  it("UI-12: computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });

  for (const theme of THEMES) {
    it(`UI-12: every text and focus color pair meets WCAG 2.2 AA in the ${theme} theme`, () => {
      const failures = CONTRAST_PAIRS.map(({ fg, bg, min }) => ({ fg, bg, min, ratio: contrastRatio(TOKENS[theme][fg], TOKENS[theme][bg]) })).filter(
        (p) => p.ratio < p.min,
      );
      expect(failures).toEqual([]);
    });

    it(`UI-12: app/globals.css declares the ${theme} theme's tokens with the checked values`, () => {
      const vars = declared(`[data-theme="${theme}"]`);
      for (const name of TOKEN_NAMES) expect(vars[name], name).toBe(TOKENS[theme][name]);
    });
  }
});
