---
inclusion: fileMatch
fileMatchPattern: ["src/core/money/**", "src/rails/**", "**/*money*"]
---

# Money Arithmetic

## The unit
- `Micros` is a branded `bigint`: `type Micros = bigint & { readonly __brand: "Micros" }`.
- 1 USD = `1_000_000n` micros. 1 cent = `10_000n` micros. 1 USDC atomic unit = `1n` micro.
- Valid range: `0n` to `MAX_MICROS = 1_000_000_000_000_000n` ($1 billion). Postgres `bigint` holds up to about 9.2 × 10^18, so this leaves headroom for sums.
- Currency is USD only for now (USDC is treated as USD 1:1).

## Creating values
Only these functions create `Micros`:
```ts
micros(value: bigint): Micros                  // throws if negative or > MAX_MICROS
fromDecimalString(s: string): Micros           // "0.0015" -> 1500n; max 6 decimal places; throws otherwise
fromMicrosString(s: string): Micros            // "1500" -> 1500n (wire format)
```
`fromDecimalString` uses string splitting on `"."`, never `parseFloat`. It rejects `"1e3"`, `"-1"`, `" 1"`, `"1."`, `".5"`, and more than 6 decimals.

## Arithmetic
```ts
add(a, b): Micros          // throws if result > MAX_MICROS
sub(a, b): Micros          // throws if result < 0
sumWindow(items): Micros   // sum with the same guard
mulCount(a, n: bigint)     // for velocity projections; guarded
cmp(a, b): -1 | 0 | 1
```
No division on money except inside `toRailUnits`.

## Converting at the rail boundary
```ts
toRailUnits(amount: Micros, rail: "stripe" | "x402", direction: "debit" | "credit"): bigint
```
- **x402 (USDC, 6 decimals):** exact, 1:1. No rounding.
- **Stripe (cents):** `micros / 10_000n` with **directional rounding that never favors the agent**:
  - `debit` (the agent spends): round **up** (ceiling). The amount counted against the envelope is the rounded-up value, so the envelope can never be exceeded through rounding.
  - `credit` (a refund to the agent's side): round **down** (floor).
- Rail minimums are enforced in the adapter, after conversion: Stripe SPT card payments require at least 50 cents; on-chain USDC settlement requires at least 10,000 micros (0.01 USDC). Below the minimum, the adapter returns `BELOW_RAIL_MINIMUM`. It never silently rounds up to the minimum.

> Note: the original plan mentioned banker's rounding. Directional rounding replaces it, because banker's rounding can round a debit down, which favors the agent.

## Display
```ts
toDisplay(amount: Micros): string   // 1500n -> "$0.0015", 1_000_000n -> "$1.00", 480_000_000n -> "$480.00"
```
- Always at least 2 decimals. Show up to 6 decimals, trimming trailing zeros past the second.
- Display formatting is string manipulation on the bigint, never `Intl.NumberFormat` on a `number`.

## Banned patterns (the `no-float-money` hook flags these)
```ts
parseFloat(amount)                 // float
Number(row.amount_micros)          // loses precision above 2^53
amount.toFixed(2)                  // float formatting
Math.round(cents * 100)            // float math
const amountMicros: number = ...   // wrong type
JSON.stringify({ amount: 1500n })  // throws; serialize with toString()
```
