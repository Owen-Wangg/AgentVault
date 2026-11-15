import { cache } from "react";
import { loadDashboardContext } from "@/server/dashboard/context";

/** The dashboard context, loaded once per request and shared by the layout and the page. */
export const getDashboardContext = cache(() => loadDashboardContext());
