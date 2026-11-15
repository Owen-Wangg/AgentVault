import { DataState } from "@/ui/components/DataState";

// Shown while a dashboard page's server data loads (UI-15).
export default function Loading() {
  return <DataState status="loading" empty="" />;
}
