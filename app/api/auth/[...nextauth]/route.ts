import type { NextRequest } from "next/server";
import { handlers } from "@/server/auth/auth";
import { env } from "@/server/env";

// Auth.js sign-in, callback, and sign-out endpoints (telemetry-dashboard UI-2).
// With sign-in off, they don't exist: Auth.js would otherwise sign with
// whatever AUTH_SECRET holds, such as the .env.example placeholder.
export const dynamic = "force-dynamic";

const off = () => Response.json({ error: "NOT_FOUND" }, { status: 404 });

export function GET(request: NextRequest): Promise<Response> | Response {
  return env.githubAuthEnabled() ? handlers.GET(request) : off();
}

export function POST(request: NextRequest): Promise<Response> | Response {
  return env.githubAuthEnabled() ? handlers.POST(request) : off();
}
