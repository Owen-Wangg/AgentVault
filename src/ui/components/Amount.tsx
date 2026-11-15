import { type Micros, toDisplay } from "@/core/money";
import { cn } from "./primitives";

/**
 * An exact dollar amount with 2 to 6 decimals, for example $0.0015
 * (UI-11). The text parses back to the same micros (property 3).
 */
export function Amount({ value, className }: { value: Micros; className?: string }) {
  return <span className={cn("font-mono tabular-nums", className)}>{toDisplay(value)}</span>;
}
