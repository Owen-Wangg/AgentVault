import { describe, expect, it } from "vitest";
import { REASON_CODES } from "@/core/policy";
import { copy, reasonText } from "./copy";
import { THEMES } from "./theme";

describe("copy", () => {
  it("UI-6: every reason code has a plain-language sentence in every theme", () => {
    for (const theme of THEMES) {
      for (const code of REASON_CODES) {
        expect(copy[theme][code], `${theme} ${code}`).toMatch(/^(Denied|Held|Sealed)\b.*\.$/);
      }
    }
  });

  it("UI-15: no string is empty, and both themes have the same keys", () => {
    expect(Object.keys(copy.kiroween).sort()).toEqual(Object.keys(copy.default).sort());
    for (const theme of THEMES) for (const [key, value] of Object.entries(copy[theme])) expect(value.trim(), `${theme} ${key}`).not.toBe("");
  });

  it("UI-16: Kiroween copy calls frozen agents The Crypt and tainted sessions Haunted", () => {
    expect(copy.kiroween["agents.frozen"]).toBe("The Crypt");
    expect(copy.kiroween["agents.tainted"]).toBe("Haunted");
    expect(copy.default["agents.frozen"]).toBe("Frozen");
  });

  it("UI-6: an unknown reason code is shown as the code, not as a missing string or a prototype property", () => {
    expect(reasonText("HELD_TAINTED")).toContain("untrusted content");
    expect(reasonText("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(reasonText("constructor")).toBe("constructor");
    expect(reasonText("__proto__")).toBe("__proto__");
  });
});
