import { describe, expect, it } from "vitest";
import { labelOrigin, parseTrustEntry } from "./label";

const TRUSTED = ["https://docs.stripe.com", "https://agentvault.example/vendor/api"];
const label = (url: string, trusted: readonly string[] = TRUSTED) => labelOrigin(new URL(url), trusted);

describe("TAINT-1: labelOrigin", () => {
  it.each([
    ["https://docs.stripe.com/payments"],
    ["https://docs.stripe.com"],
    ["https://DOCS.Stripe.com/x"],
    ["https://docs.stripe.com:443/x"],
    ["https://agentvault.example/vendor/api"],
    ["https://agentvault.example/vendor/api/weather?city=YVR"],
  ])("TAINT-1: %s is trusted", (url) => {
    expect(label(url)).toBe("trusted");
  });

  it.each([
    ["a lookalike host that appends a domain", "https://docs.stripe.com.evil.com/payments"],
    ["a lookalike host that prepends a label", "https://evildocs.stripe.com/"],
    ["a subdomain of a trusted host", "https://a.docs.stripe.com/"],
    ["a different scheme", "http://docs.stripe.com/"],
    ["a different port", "https://docs.stripe.com:8443/"],
    ["the same origin outside the path prefix", "https://agentvault.example/vendor/docs/integration"],
    ["a path that only shares a string prefix", "https://agentvault.example/vendor/apix"],
    ["dot segments that leave the prefix", "https://agentvault.example/vendor/api/../docs/integration"],
    ["encoded dot segments that leave the prefix", "https://agentvault.example/vendor/api/%2e%2e/docs/integration"],
    ["an encoded slash that hides a different path", "https://agentvault.example/vendor/api%2F..%2Fdocs"],
    ["credentials before a trusted host", "https://docs.stripe.com@evil.com/"],
    ["credentials on a trusted host", "https://user:pw@docs.stripe.com/"],
    ["a non-http scheme", "ftp://docs.stripe.com/"],
    ["any unlisted origin", "https://example.com/"],
  ])("TAINT-1: %s is untrusted", (_name, url) => {
    expect(label(url)).toBe("untrusted");
  });

  it("TAINT-1: an empty trusted list makes everything untrusted", () => {
    expect(label("https://docs.stripe.com/", [])).toBe("untrusted");
  });

  it("TAINT-1: a prefix with a trailing slash covers only paths below it", () => {
    const trusted = ["https://agentvault.example/vendor/api/"];
    expect(label("https://agentvault.example/vendor/api/weather", trusted)).toBe("trusted");
    expect(label("https://agentvault.example/vendor/api", trusted)).toBe("untrusted");
  });

  it.each([
    ["not a URL", "docs.stripe.com"],
    ["a query", "https://docs.stripe.com/?x=1"],
    ["an empty query", "https://docs.stripe.com/?"],
    ["a fragment", "https://docs.stripe.com/#top"],
    ["credentials", "https://user@docs.stripe.com"],
    ["a non-http scheme", "javascript:alert(1)"],
  ])("TAINT-1: an entry with %s is ignored, so it trusts nothing", (_name, entry) => {
    expect(parseTrustEntry(entry)).toBeNull();
    expect(label("https://docs.stripe.com/", [entry])).toBe("untrusted");
  });
});
