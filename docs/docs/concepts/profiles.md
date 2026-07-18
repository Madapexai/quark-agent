# Profiles

Profiles are preset tool selections. They exist so you don't have to enumerate 16 tool names every time.

## The 6 Built-in Profiles

| Profile | Tools | Use Case |
|---|---|---|
| `minimal` | `run_code` only | Pure code-gen agent |
| `coding` | file, search, shell, run_code | Local dev assistant |
| `research` | web, run_code, todo, memory | Browser-based research |
| `full` | all 16 tools | Kitchen sink |
| `coding-with-web` | coding + web | Dev assistant that can look things up |
| `research-with-code` | research + file/search/shell | Research that touches files |

## Custom Profiles

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  apiKey: process.env.ARK_API_KEY!,
  profile: "coding",
  extraCategories: ["web", "image"],
});
```

You can also pass `profile: "custom"` and `categories: ["file", "search"]` to build from scratch.
