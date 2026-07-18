# A2A Protocol

A2A (Agent-to-Agent) lets agents discover and invoke each other's skills.

## Quick Example

```ts
import { getA2ARegistry } from "quark-agent";

getA2ARegistry().register({
  name: "code-reviewer",
  description: "Reviews pull requests for bugs and style",
  skills: [
    { name: "review", description: "Review a PR diff" },
    { name: "suggest_fix", description: "Suggest a fix for an issue" },
  ],
});

// Another agent (or even another process) can now:
const result = await getA2ARegistry().invoke("code-reviewer", "review", {
  diff: "...",
});
```

## Transport

A2A uses HTTP + JSON-RPC under the hood. Any registered agent is reachable at:

```
POST /a2a/{agent_name}/{skill_name}
Content-Type: application/json

{ ...args }
```

## Discovery

The `Hub` plugin (`src/hub/index.ts`) provides a service-registry pattern:

```ts
import { Hub } from "quark-agent";

const hub = new Hub({ registryUrl: "https://hub.example.com" });
await hub.register({ name: "my-agent", skills: [...] });
const peers = await hub.discover("review");
```

## Federation

Multiple hubs can federate, so agents on different machines can find each other. This is how you'd build a "company of agents" — each agent does one thing well, and they call each other through A2A.
