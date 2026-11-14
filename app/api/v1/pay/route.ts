import { handlePay } from "@/server/payments/pay-handler";

// Agent payments (audit-and-approvals PXY-4 to PXY-14). The logic lives in
// src/server/payments; this route only connects it to Next.js.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handlePay(request);
}
