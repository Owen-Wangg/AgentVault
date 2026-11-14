# Tasks: Money and Policy Core

Plan (`docs/PLAN.md`): **Phase 3** = tasks 1–2. **Phase 4** = tasks 3–6.

- [ ] 1. Build the `Micros` type and arithmetic in `src/core/money/micros.ts`
  - Branded type, `micros`, `fromDecimalString`, `fromMicrosString`, `toMicrosString`, `toDecimalString`, `toDisplay`, `add`, `sub`, `sum`, `cmp`, and `MicrosSchema` (Zod)
  - Typed errors `InvalidAmountError`, `AmountOutOfRangeError`
  - Unit tests for edge cases: `"0"`, `"0.000001"`, `"1."`, `".5"`, `"1e3"`, `"-1"`, 7 decimals, `MAX_MICROS`
  - Property tests 1 and 2 from the design doc
  - _Requirements: MON-1, MON-2, MON-3, MON-4, MON-5, MON-6_

- [ ] 2. Build rail conversion in `src/core/money/rail-units.ts`
  - `toRailUnits`, `fromRailUnits`, `chargeableMicros` (debits rounded up, credits counted in full)
  - Property tests 3, 4, and 9
  - Test fixture: a float-based implementation that the properties catch (save the failing seed in the write-up notes)
  - _Requirements: MON-7, MON-8, MON-9, MON-10, MON-11_

- [ ] 3. Define policy types, reason codes, and Zod schemas in `src/core/policy`
  - `types.ts`, `reasons.ts`, `schemas.ts`
  - Add envelope, window-state, and request arbitraries to `src/core/testing/arbitraries.ts` (the file and its money generators are created in Phase 2, project setup)
  - _Requirements: ENV-11, ENV-15_

- [ ] 4. Implement the envelope rule functions
  - `frozenRule`, `txMaxRule`, `windowCapRule`, `velocityRule`, `allowListRule`, `approvalThresholdRule`
  - Effective limit = the stricter of agent-level and vendor- or tool-level limits
  - One unit test per requirement ID
  - _Requirements: ENV-1, ENV-2, ENV-3, ENV-5, ENV-6, ENV-7, ENV-8, ENV-9, ENV-10_

- [ ] 5. Implement `evaluate()` and `combine()`
  - Collects reasons from all rules (including taint and intent rules once they exist; stub them as returning `[]` until taint-and-intent task 3, Phase 7)
  - Never throws; invalid input becomes `INVALID_REQUEST`
  - Property tests 5–8
  - _Requirements: ENV-4 (reported only), ENV-11, ENV-12, ENV-13, ENV-14, ENV-15_

- [ ] 6. Add the `pnpm demo:policy` script
  - `scripts/demo-policy.ts` runs a sample sequence (normal calls, a burst, an over-cap call) and prints a table of decisions and reasons
  - _Requirements: ENV-10, ENV-11_
