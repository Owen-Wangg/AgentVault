import { handleMcp } from "@/server/mcp/handler";

// The Streamable HTTP MCP server (mcp-server MCP-8). Stateless, so GET
// and DELETE get the transport's own answers. Logic in src/server/mcp.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleMcp(request);
}

export function GET(request: Request): Promise<Response> {
  return handleMcp(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcp(request);
}
