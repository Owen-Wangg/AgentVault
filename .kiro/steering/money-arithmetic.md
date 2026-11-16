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
sum(items): Micros         // sum with the same guard
cmp(a, b): -1 | 0 | 1
```
No division on money except inside `toRailUnits`.

## Converting at the rail boundary
```ts
toRailUnits(amount: Micros, rail: "stripe" | "x402" | "mock" | "paypal", direction: "debit" | "credit"): bigint
chargeableMicros(amount: Micros, rail, direction): Micros   // what the envelope counts
```
- **x402 (USDC, 6 decimals) and mock:** exact, 1:1. No rounding.
- **Stripe (cents):** `micros / 10_000n` with **directional rounding that never favors the agent**:
  - `debit` (the agent spends): round **up** (ceiling). The amount counted against the envelope is the rounded-up value, so the envelope can never be exceeded through rounding.
  - `credit` (money the platform sends: a refund the agent issues, or a payout to a payee): round **down** (floor), so the customer or payee never gets more than was approved. The envelope still counts the full requested amount (MON-11), so a refund or payout can't use rounding to slip under a cap.
- **PayPal (cents):** the same as Stripe, with the same directional rounding. The Payouts API takes a decimal string, which is built from integer cents only: `` `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}` ``. No float, no `toFixed`.
- **Payouts are credits** on every rail (`payout.create` on Stripe, `paypal.payout` on PayPal, payout-rails PO-3). `payee.update` moves no money and has no amount to round.
- `chargeableMicros` is never less than the requested amount.
- `toRailUnits` is called only inside `src/rails/**`. The server uses `chargeableMicros`, with the rail the tool is registered to, even when the sandbox runs it on the mock adapter.
- Rail minimums are enforced in the adapter, after conversion. Below the minimum, the adapter returns `BELOW_RAIL_MINIMUM`. It never silently rounds up to the minimum.
  - Stripe SPT card payments: at least 50 cents.
  - Stripe Connect transfers and PayPal payouts: 1 cent until `pnpm connect:probe` and `pnpm paypal:probe` measure them (payout-rails task 2).
  - x402: USDC has no protocol minimum, but the CDP facilitator sets one. rail-adapters task 4 measured it on Base Sepolia: 1000 units ($0.001). It refuses 999 units with `amount_too_low`, and settles 1000 and the sandbox's `$0.0015` weather payment. `X402_MIN_UNITS` defaults to 1000, and the mock rail uses the same minimum.

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
