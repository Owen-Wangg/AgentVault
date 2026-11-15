"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type Micros, micros, toDisplay } from "@/core/money";
import { t } from "@/ui/copy";
import type { DecisionKind, Overview, Range } from "@/ui/events/summarize";

/**
 * Recharts needs numbers, so the y values are integer micros as numbers.
 * That is chart geometry only: every label and tooltip shows the exact
 * bigint through toDisplay (UI-11). Amounts below 2^53 micros ($9 billion)
 * convert exactly.
 */
const plotValue = (m: Micros): number => Number(m); // money-check: ok chart geometry only; labels use toDisplay

const axisLabel = (value: number): string => (Number.isSafeInteger(value) && value >= 0 ? toDisplay(micros(BigInt(value))) : "");

const TIME_FORMAT: Record<Range, Intl.DateTimeFormatOptions> = {
  hour: { hour: "numeric", minute: "2-digit" },
  day: { hour: "numeric" },
  week: { weekday: "short", hour: "numeric" },
  all: { month: "short", day: "numeric" },
};

export function SpendChart({ series, range }: { series: Overview["spendSeries"]; range: Range }) {
  const data = series.map((b) => ({ start: b.start, value: plotValue(b.spendMicros), label: toDisplay(b.spendMicros) }));
  const total = series.reduce((n, b) => n + (b.spendMicros > 0n ? 1 : 0), 0);
  const format = new Intl.DateTimeFormat(undefined, TIME_FORMAT[range]);
  return (
    <div role="img" aria-label={`${t("overview.spendOverTime")}: ${total} of ${series.length} periods had spend.`} className="h-56 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="start" tickFormatter={(v: number) => format.format(v)} stroke="var(--text-muted)" fontSize={12} minTickGap={24} />
          <YAxis tickFormatter={axisLabel} stroke="var(--text-muted)" fontSize={12} width={72} allowDecimals={false} />
          <Tooltip
            labelFormatter={(v) => format.format(Number(v))}
            formatter={(_value, _name, item) => [String((item.payload as { label: string }).label), t("overview.spend")]}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
          <Area type="monotone" dataKey="value" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.15} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const DECISION_COLOR: Record<DecisionKind, string> = { allow: "var(--allow)", hold: "var(--hold)", deny: "var(--deny)" };

export function DecisionsChart({ decisions }: { decisions: Overview["decisions"] }) {
  const data = (["allow", "hold", "deny"] as const).map((d) => ({ name: t(`decision.${d}`), count: decisions[d], fill: DECISION_COLOR[d] }));
  const label = data.map((d) => `${d.name} ${d.count}`).join(", ");
  return (
    <div role="img" aria-label={`${t("overview.decisions")}: ${label}`} className="h-56 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} />
          <YAxis allowDecimals={false} stroke="var(--text-muted)" fontSize={12} width={40} />
          <Tooltip cursor={{ fill: "var(--surface-muted)" }} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
          <Bar dataKey="count" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
