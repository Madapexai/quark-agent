# MCP Protocol

Full Model Context Protocol (MCP) support - both as server and client.

## Overview

MCP is an open standard by Anthropic for connecting AI models to external tools and data sources. Quark Agent supports MCP in both directions:

- **As Server**: Expose quark-agent's tools to any MCP-compatible client (Claude Desktop, Cursor, etc.)
- **As Client**: Connect to external MCP servers and aggregate their tools

## Server Mode

Expose your tools via JSON-RPC 2.0 over stdio or SSE:

```ts
import { createQuarkMCPServer } from "quark-agent";

const mcp = await createQuarkMCPServer();

// stdio transport (for Claude Desktop integration)
await mcp.runStdio();

// or SSE transport (for web-based clients)
mcp.runSSE(3000);
```

### Registered Tools

The server pre-registers these built-in tools:

| Tool | Description |
|------|-------------|
| `web_search` | Search the web |
| `web_fetch` | Fetch a URL and return content |
| `computer_screenshot` | Take a screenshot |

### Claude Desktop Integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "quark-agent": {
      "command": "npx",
      "args": ["github:Madapexai/quark-agent", "mcp-server"]
    }
  }
}
```

## Client Mode

Connect to external MCP servers and aggregate their tools:

```ts
import { MCPRegistry } from "quark-agent";

const registry = new MCPRegistry();

// Connect via stdio (spawn subprocess)
await registry.connect({
  name: "filesystem",
  command: "npx",
  args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
});

// Connect via SSE
await registry.connect({
  name: "remote-tools",
  url: "https://example.com/mcp/sse",
});

// List all aggregated tools
const tools = registry.listAllTools();
// -> [{ server: "filesystem", tool: { name: "read_file", ... } }, ...]

// Call a tool
const result = await registry.callTool("filesystem", "read_file", { path: "/tmp/test.txt" });
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcp/tools` | List built-in + external tools |
| GET | `/api/mcp/servers` | List connected servers |
| POST | `/api/mcp/connect` | Connect to a server |
| POST | `/api/mcp/disconnect` | Disconnect from a server |

### Connect via API

```bash
curl -X POST http://localhost:8788/api/mcp/connect \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"filesystem","command":"npx","args":["@modelcontextprotocol/server-filesystem","/tmp"]}'
```
