# Requirements: MCP Server

## Introduction
This spec covers an MCP (Model Context Protocol) server that lets any MCP client, such as Kiro or Claude Desktop, route payments and web reads through AgentVault. It reuses `runGuardedRequest` and the fetcher, so MCP calls get exactly the same protections as the HTTP API. This milestone comes after the core is done (Phase 16 in `docs/PLAN.md`).

## Requirement 1: Tools
**User story:** As a developer using an MCP client, I want AgentVault's protections as tools, so that my existing agent gets spend limits without code changes.

### Acceptance criteria
- **MCP-1** THE server SHALL expose the tools `agentvault_pay`, `agentvault_fetch`, and `agentvault_request_tool`, with JSON Schemas for their inputs.
- **MCP-2** WHEN a tool is called, THE server SHALL validate the input with Zod and pass it to the same server functions the HTTP API uses.
- **MCP-3** THE server SHALL return the decision, reasons, and a plain-language explanation as the tool result.
- **MCP-4** WHEN a request is held, THE tool result SHALL say that a human must approve it in the dashboard and include the approval ID.
- **MCP-5** THE server SHALL mark fetched content in tool results as untrusted when it is, so that the client model can see the label.
- **MCP-11** THE server SHALL NOT expose any tool that approves, denies, or unfreezes, because agent API keys may not do those actions (audit-and-approvals HITL-10).
- **MCP-12** WHEN the rail outcome is unknown, THE tool result SHALL say that the payment may have gone through, that the amount stays counted against the budget, and that the agent must not retry with a new idempotency key.

## Requirement 2: Authentication and transport
### Acceptance criteria
- **MCP-6** THE server SHALL authenticate with an AgentVault agent API key, provided through the `AGENTVAULT_API_KEY` environment variable (stdio) or a bearer header (HTTP).
- **MCP-7** IF the key is missing or invalid, THEN THE server SHALL fail every tool call with an authentication error and perform no action.
- **MCP-8** THE server SHALL support the stdio transport for local clients and the Streamable HTTP transport at `/api/mcp` for remote clients.

## Requirement 3: Parity and docs
### Acceptance criteria
- **MCP-9** FOR every request, THE decision through MCP SHALL equal the decision through the HTTP API given the same state.
- **MCP-10** THE repo SHALL include copy-paste setup instructions for Kiro (`.kiro/settings/mcp.json`) and Claude Desktop.
