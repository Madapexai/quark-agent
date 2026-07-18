# Tools & Skills

Tools are the verbs an agent can invoke. Skills are bundles of one or more `defineAction`s that ship together.

## Built-in Tools

See the [16 Tools reference](../reference/tools.md) for the full list.

## Adding a Skill

A skill is just a `defineAction`:

```ts
import { defineAction } from "quark-agent";

export const translateText = defineAction({
  name: "translate_text",
  description: "Translate text between languages",
  parameters: {
    text: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  },
  handler: async ({ text, from, to }) => {
    // call a translation API
    return { translated: "..." };
  },
});
```

Auto-exposes to: Agent loop, HTTP, CLI, MCP, A2A.

## Skill Discovery

Skills under `src/tools/` and `skills/` are auto-discovered at startup. For ad-hoc skills:

```ts
import { createAgent } from "quark-agent";
import { translateText } from "./skills/translate";

const { agent } = await createAgent({
  apiKey: process.env.ARK_API_KEY!,
  profile: "minimal",
  extraActions: [translateText],
});
```

## Skill Scoring

The `extensions/skills/score.ts` module assigns a relevance score to each skill based on:

- Description match with the current task
- Recent usage frequency
- Success rate on similar past tasks

Low-scoring skills are excluded from the LLM's tool list to keep prompts small.
