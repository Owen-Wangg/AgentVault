import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordUrl } from "./redact-url";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("recordUrl", () => {
  it("TAINT-4: keeps the origin and path, and drops the query and fragment", () => {
    const raw = "https://docs.example.com/guide/start?token=abc123&x=1#section";
    expect(recordUrl(raw)).toEqual({ url: "https://docs.example.com/guide/start", sha256: sha(raw) });
  });

  it("TAINT-4: drops credentials in the URL", () => {
    const raw = "https://user:hunter2@docs.example.com/a";
    const recorded = recordUrl(raw);
    expect(recorded.url).toBe("https://docs.example.com/a");
    expect(JSON.stringify(recorded)).not.toContain("hunter2");
  });

  it("TAINT-4: a URL without a path records its origin and a slash", () => {
    expect(recordUrl("https://docs.example.com").url).toBe("https://docs.example.com/");
  });

  it("TAINT-4: text that isn't a URL records only its length and hash", () => {
    const raw = "not a url with secret=abc";
    const recorded = recordUrl(raw);
    expect(recorded).toEqual({ url: `[unparseable URL, ${raw.length} characters]`, sha256: sha(raw) });
    expect(recorded.url).not.toContain("secret");
  });
});
