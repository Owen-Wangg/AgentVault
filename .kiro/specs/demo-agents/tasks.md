# Tasks: Demo Agents

Plan (`docs/PLAN.md`): **Phase 11** = tasks 1–4. **Phase 17** (optional, cut first) = tasks 5–6.

- [x] 1. Build `AgentClient` in `src/agents/client.ts`
  - Typed wrappers for fetch, pay, and tool; Zod-validated responses
  - _Requirements: AGT-4_

- [x] 2. Define the four scenarios and seed data
  - `scenarios.ts` with steps and expected decisions; seed envelopes, tasks, and vendors
  - _Requirements: AGT-1, AGT-6, AGT-7, AGT-8, AGT-9_

- [x] 3. Build the scenario runner and `POST /api/v1/scenarios/:name/run`
  - Fresh agent, task, and session per run (audited, no deletes), advisory lock, step execution
  - Integration tests per scenario; property 1
  - _Requirements: AGT-2, AGT-5, AGT-6, AGT-7, AGT-8, AGT-9_

- [x] 4. Build the `/scenarios` page
  - Scenario cards, live step list, summary panel
  - _Requirements: AGT-1, AGT-3, AGT-10_

- [x] 5. (Optional) Build the Gemini agent
  - Step-by-step Gemini API key setup in `docs/SETUP.md`; confirm free-tier limits in AI Studio first
  - Three tools, Zod validation, 15-call cap, 429 handling
  - _Requirements: AGT-11, AGT-12, AGT-13, AGT-14, AGT-15_

- [x] 6. (Optional) Add the advisory drift score
  - Second Gemini call; pass the score to the policy as advisory
  - Property 3 with recorded responses
  - _Requirements: AGT-16, INT-7, INT-8, INT-9_

- [x] 7. Show the latest decision as a path through the checks
  - `decisionPath` in `src/ui/scenarios/decision-path.ts`, with property 4
  - `DecisionPath` above the step list, with copy in both themes
  - _Requirements: AGT-17_

- [x] 8. Give each scripted-only scenario its own reason
  - The runaway loop and the payee hijack cards each say why they have no live run, in both themes
  - _Requirements: AGT-11_

- [x] 9. Put the Payee hijack card first
  - `CARD_ORDER` in `ScenarioRunner.tsx`, matching the tour's first step
  - _Requirements: AGT-1_
