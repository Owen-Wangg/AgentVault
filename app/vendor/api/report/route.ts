import { withVendorRateLimit } from "@/server/vendor/rate-limit";
import { reportRoute } from "@/server/vendor/report";

// The demo vendor's MPP-paid report API (rail-adapters task 7, RAIL-14).
// In the sandbox, mpp.pay runs on the mock rail and never calls it.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return withVendorRateLimit(request, "vendor report", () => reportRoute(request));
}
