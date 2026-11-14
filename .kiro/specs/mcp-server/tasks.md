# Tasks: MCP Server

Plan (`docs/PLAN.md`): **Phase 16** = tasks 1–4. If behind schedule, ship tasks 1–2 and 4 only (stdio), and skip task 3.

- [ ] 1. Define shared tool schemas and handlers in `src/mcp/tools.ts`
  - Zod inputs, JSON Schema output, plain-language explanations from `copy.ts`, including the unknown-rail-outcome message
  - Test that `tools/list` returns exactly the three tools
  - _Requirements: MCP-1, MCP-2, MCP-3, MCP-4, MCP-5, MCP-11, MCP-12_

- [ ] 2. Build the stdio server `src/mcp/stdio.ts` and `pnpm mcp`
  - Calls the HTTP API with `AGENTVAULT_URL` and `AGENTVAULT_API_KEY`
  - _Requirements: MCP-6, MCP-7, MCP-8_

- [ ] 3. Build the Streamable HTTP server at `/api/mcp`
  - Bearer key auth, direct `src/server` calls
  - Parity property test
  - _Requirements: MCP-6, MCP-7, MCP-8, MCP-9_

- [ ] 4. Write connection docs and record the Kiro demo
  - `docs/MCP.md` with Kiro and Claude Desktop configs
  - Connect from Kiro, call `agentvault_pay`, screenshot the dashboard event for the write-up
  - _Requirements: MCP-10_
