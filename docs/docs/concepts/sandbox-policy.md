# Sandbox Security & Tool Authorization

The sandbox controls what tools and system resources an agent can access — preventing unintended file writes, network calls, or command execution.

## Sandbox Policy

A sandbox policy defines boundaries for agent actions across three dimensions:

### Allowlist / Denylist

Control which tools the agent can invoke:

```json
{
  "sandbox": {
    "policy": "balanced",
    "allowlist": ["run_code", "search", "read_file"],
    "denylist": ["shell", "write_file"]
  }
}
```

- **`allowlist`** — if set, only these tools are available (denylist is ignored)
- **`denylist`** — tools explicitly blocked (used when allowlist is empty)
- If both are empty, all tools pass through to the auto-approve filter

### Network

Control outbound network access from `run_code` and `shell`:

```json
{
  "sandbox": {
    "network": {
      "allowHosts": ["api.example.com", "registry.npmjs.org"],
      "denyHosts": ["169.254.169.254"],
      "allowPorts": [443, 80]
    }
  }
}
```

- **`allowHosts`** — if set, only these hosts are reachable
- **`denyHosts`** — always blocked (defaults include cloud metadata endpoints)
- **`allowPorts`** — if set, only these ports are allowed

### Filesystem

Control file system access:

```json
{
  "sandbox": {
    "filesystem": {
      "allowPaths": ["./src", "./tests"],
      "denyPaths": [".env", ".git", "node_modules"],
      "readOnlyPaths": ["./docs"]
    }
  }
}
```

- **`allowPaths`** — if set, only these paths are writable
- **`denyPaths`** — always blocked from write access
- **`readOnlyPaths`** — readable but not writable

## Tool Auto-Approve Modes

When a tool is invoked, the sandbox checks whether it needs explicit user approval:

| Mode | Behavior |
|---|---|
| `all` | All tool calls are auto-approved (no prompts) |
| `safe` | Only safe tools are auto-approved; risky tools require approval |
| `none` | Every tool call requires explicit user approval |

Set via config:

```json
{
  "sandbox": { "autoApprove": "safe" }
}
```

Or environment variable:

```env
SANDBOX_AUTO_APPROVE=safe
```

### Safe Tools List

The following tools are considered safe and are auto-approved in `safe` mode:

| Tool | Category | Reason |
|---|---|---|
| `run_code` | execution | Sandboxed, resource-limited |
| `search` | retrieval | Read-only |
| `read_file` | retrieval | Read-only |
| `list_files` | retrieval | Read-only |
| `web_fetch` | retrieval | Read-only |
| `memory` | storage | Scoped to agent's own DB |

Tools requiring approval in `safe` mode:

| Tool | Category | Reason |
|---|---|---|
| `write_file` | mutation | Writes to disk |
| `shell` | execution | Arbitrary commands |
| `delete_file` | mutation | Destructive |
| `send_message` | external | Sends to external channel |

## Preset Policies

Three built-in presets for common scenarios:

### `strict`

```json
{
  "sandbox": {
    "policy": "strict",
    "autoApprove": "none",
    "network": { "denyHosts": ["*"] },
    "filesystem": {
      "allowPaths": ["./sandbox"],
      "readOnlyPaths": ["./src"]
    }
  }
}
```

- All tools require approval
- No network access
- Can only write to `./sandbox/`
- Best for: untrusted input, production environments

### `balanced` (default)

```json
{
  "sandbox": {
    "policy": "balanced",
    "autoApprove": "safe",
    "network": {
      "denyHosts": ["169.254.169.254"]
    },
    "filesystem": {
      "denyPaths": [".env", ".git"]
    }
  }
}
```

- Safe tools auto-approved, risky tools need approval
- Network allowed except cloud metadata endpoints
- Protects sensitive files
- Best for: development, CI pipelines

### `permissive`

```json
{
  "sandbox": {
    "policy": "permissive",
    "autoApprove": "all",
    "network": {},
    "filesystem": {}
  }
}
```

- All tools auto-approved
- No network or filesystem restrictions
- Best for: local experimentation, trusted environments only

## Environment Variable Configuration

All sandbox settings can be configured via environment variables:

| Variable | Description | Default |
|---|---|---|
| `SANDBOX_POLICY` | Preset: `strict` \| `balanced` \| `permissive` | `balanced` |
| `SANDBOX_AUTO_APPROVE` | Auto-approve mode: `all` \| `safe` \| `none` | `safe` |
| `SANDBOX_TIMEOUT_MS` | Execution timeout in ms | `10000` |
| `SANDBOX_MAX_MEMORY_MB` | Max memory for sandboxed code | `128` |
| `SANDBOX_ALLOW_TOOLS` | Comma-separated tool allowlist | — |
| `SANDBOX_DENY_TOOLS` | Comma-separated tool denylist | — |
| `SANDBOX_ALLOW_HOSTS` | Comma-separated allowed hosts | — |
| `SANDBOX_DENY_HOSTS` | Comma-separated denied hosts | `169.254.169.254` |
| `SANDBOX_ALLOW_PATHS` | Comma-separated allowed write paths | — |
| `SANDBOX_DENY_PATHS` | Comma-separated denied write paths | `.env,.git` |
| `SANDBOX_READ_ONLY_PATHS` | Comma-separated read-only paths | — |

### Example

```bash
# Run with strict policy, no network, only read from ./src
SANDBOX_POLICY=strict \
SANDBOX_ALLOW_PATHS=./sandbox \
SANDBOX_READ_ONLY_PATHS=./src \
SANDBOX_DENY_HOSTS='*' \
quark-agent
```

### CLI flags

```bash
quark-agent --sandbox-policy strict --sandbox-auto-approve none
```

CLI flags override environment variables, which override the config file.
