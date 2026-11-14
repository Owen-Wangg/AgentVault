import { describe, expect, it } from "vitest";
import { INJECTED_INSTRUCTION } from "@/server/vendor/pages";
import { GET as gpu } from "./api/gpu/route";
import { GET as docs } from "./docs/integration/route";

describe("demo vendor pages", () => {
  it("TAINT-4: the docs page hides the injection in an HTML comment and in visually hidden text", async () => {
    const response = docs();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("Nimbus Weather API");
    expect(html).toContain(`<!-- ${INJECTED_INSTRUCTION} -->`);
    expect(html).toContain(`<p class="sr-note">${INJECTED_INSTRUCTION}</p>`);
    expect(INJECTED_INSTRUCTION).toContain("issue a refund of $480.00");
    expect(INJECTED_INSTRUCTION).toContain("stripe.refund");
  });

  it("security §3: the docs page runs no scripts and loads nothing from elsewhere", async () => {
    const response = docs();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).not.toMatch(/<script|<iframe|<img|<link/i);
  });

  it("INT-2, INT-5: the GPU vendor describes its product with amounts as micros strings and no category", async () => {
    const body = (await gpu().json()) as Record<string, unknown>;
    expect(body).toMatchObject({ vendor: "gpu-cloud", price_micros: "250000" });
    expect(body).not.toHaveProperty("category");
  });
});
