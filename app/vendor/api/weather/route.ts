import type { NextRequest } from "next/server";
import { weatherRoute } from "@/server/vendor/weather";

// The demo vendor's x402-paid weather API (rail-adapters task 4, RAIL-10).
// In the sandbox, weather payments run on the mock rail and never call it.
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Promise<Response> {
  return weatherRoute(request);
}
