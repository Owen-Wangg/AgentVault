import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GeminiError, isTransient, toGeminiError } from "./model";
import { parseScore } from "./scorer";

describe("parseScore", () => {
  it.each([
    ["0", 0],
    ["42", 42],
    [" 100\n", 100],
    ['{"score": 7}', 7],
  ])("AGT-16: reads %j as %s", (text, n) => {
    expect(parseScore(text)).toBe(n);
  });

  it.each(["101", "-1", "4.5", "42.", "Score: 42", "42 out of 100", "", "0x10", '{"score": 50.5}', '{"score": 5, "why": "x"}', "1e2"])(
    "AGT-16: %j is no score",
    (text) => {
      expect(parseScore(text)).toBeNull();
    },
  );
});

describe("Gemini errors", () => {
  it("AGT-14: a timeout is its own kind, and transient", () => {
    const timeout = toGeminiError(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
    expect(timeout).toMatchObject({ kind: "timeout", status: 0 });
    expect(isTransient(timeout)).toBe(true);
  });

  it("AGT-14: 5xx and dropped connections are transient; 429 and other 4xx are not", () => {
    expect(isTransient(new GeminiError("failed", 503))).toBe(true);
    expect(isTransient(new GeminiError("failed", 0))).toBe(true);
    expect(isTransient(toGeminiError(new ApiError({ message: "quota", status: 429 })))).toBe(false);
    expect(isTransient(new GeminiError("failed", 400))).toBe(false);
  });
});
