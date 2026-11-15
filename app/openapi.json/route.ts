import { discoveryDocument } from "@/server/vendor/discovery";

// MPP discovery for the demo vendor (rail-adapters task 7, RAIL-18).
// `npx mppx@latest validate <origin>` reads it to find /vendor/api/report.
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(discoveryDocument(), { headers: { "x-content-type-options": "nosniff" } });
}
