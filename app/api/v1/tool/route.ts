import { handleTool } from "@/server/tools/tool-handler";

// High-privilege tool requests (taint-and-intent TAINT-6 to TAINT-9). The
// logic lives in src/server/tools and src/server/payments.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleTool(request);
}
