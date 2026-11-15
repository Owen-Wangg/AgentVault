"use client";

import { DataState } from "@/ui/components/DataState";

// A page whose server data failed to load (UI-15). The error's details
// stay in the server log; the page shows only a generic message.
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DataState status="error" empty="" onRetry={reset} />;
}
