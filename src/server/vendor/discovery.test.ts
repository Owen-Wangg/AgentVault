import { validate } from "mppx/discovery";
import { describe, expect, it } from "vitest";
import { discoveryDocument } from "./discovery";

describe("MPP discovery document", () => {
  it("RAIL-18: is a valid MPP discovery document listing the report endpoint at 50 cents", () => {
    const doc = discoveryDocument();
    expect(validate(doc)).toEqual([]);
    expect(doc).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/vendor/api/report": {
          get: {
            "x-payment-info": { offers: [{ method: "stripe", intent: "charge", amount: "50", currency: "usd" }] },
            responses: { "402": expect.anything() },
          },
        },
      },
    });
  });
});
