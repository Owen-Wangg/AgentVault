# Tasks: Demo Agents

Global plan mapping (see `docs/PLAN.md`; "Task N" is a plan row, numbered entries here are items): **Task 11** (Nov 25–26) = items 1–4. **Task 16** (Nov 30, optional, cut first) = items 5–6.

- [ ] 1. Build `AgentClient` in `src/agents/client.ts`
  - Typed wrappers for fetch, pay, and tool; Zod-validated responses
  - _Requirements: AGT-4_

- [ ] 2. Define the four scenarios and seed data
  - `scenarios.ts` with steps and expected decisions; seed envelopes, tasks, and vendors
  - _Requirements: AGT-1, AGT-6, AGT-7, AGT-8, AGT-9_

- [ ] 3. Build the scenario runner and `POST /api/v1/scenarios/:name/run`
  - Fresh agent, task, and session per run (audited, no deletes), advisory lock, step execution
  - Integration tests per scenario; property 1
  - _Requirements: AGT-2, AGT-5, AGT-6, AGT-7, AGT-8, AGT-9_

- [ ] 4. Build the `/scenarios` page
  - Scenario cards, live step list, summary panel
  - _Requirements: AGT-1, AGT-3, AGT-10_

- [ ] 5. (Optional) Build the Gemini agent
  - Step-by-step Gemini API key setup in `docs/SETUP.md`; confirm free-tier limits in AI Studio first
  - Three tools, Zod validation, 15-call cap, 429 handling
  - _Requirements: AGT-11, AGT-12, AGT-13, AGT-14, AGT-15_

- [ ] 6. (Optional) Add the advisory drift score
  - Second Gemini call; pass the score to the policy as advisory
  - Property 3 with recorded responses
  - _Requirements: AGT-16, INT-7, INT-8, INT-9_
