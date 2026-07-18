# `defineAction` API

`defineAction` is the single entrypoint for adding new capabilities to Quark Agent. Define once, expose everywhere — Agent loop, HTTP, CLI, MCP, A2A.

## Signature

```ts
function defineAction<TParams, TResult>(config: {
  name: string;
  description: string;
  parameters: Record<string, JSONSchemaProperty>;
  handler: (args: TParams, ctx: ActionContext) => Promise<TResult>;
}): Action;
```

## Minimal Example

```ts
import { defineAction } from "quark-agent";

export const getCurrentTime = defineAction({
  name: "get_current_time",
  description: "Get the current server time in ISO 8601",
  parameters: {},
  handler: async () => {
    return { iso: new Date().toISOString() };
  },
});
```

## With Parameters

```ts
export const sendEmail = defineAction({
  name: "send_email",
  description: "Send an email to someone",
  parameters: {
    to: { type: "string", description: "recipient email" },
    subject: { type: "string" },
    body: { type: "string" },
  },
  handler: async ({ to, subject, body }) => {
    // your logic
    return { sent: true, to };
  },
});
```

## Using the Context

The `ctx` argument gives you access to the workspace, memory, and event bus:

```ts
export const rememberUserPref = defineAction({
  name: "remember_user_pref",
  description: "Persist a user preference",
  parameters: {
    key: { type: "string" },
    value: { type: "string" },
  },
  handler: async ({ key, value }, ctx) => {
    await ctx.memory.save(`pref:${key}`, value);
    ctx.events.emit("pref:saved", { key, value });
    return { ok: true };
  },
});
```

## Registering with the Agent

By default, any `defineAction` exported from a file under `src/tools/` or `skills/` is auto-discovered. For ad-hoc actions, register manually:

```ts
import { createAgent } from "quark-agent";
import { sendEmail } from "./my-skills/send-email";

const { agent } = await createAgent({
  apiKey: process.env.ARK_API_KEY!,
  profile: "minimal",
  extraActions: [sendEmail],
});
```

## Parameter Schema

We use a subset of JSON Schema. Supported types:

| Type | Example |
|---|---|
| `string` | `{ type: "string", description: "..." }` |
| `number` | `{ type: "number" }` |
| `boolean` | `{ type: "boolean" }` |
| `enum` | `{ type: "string", enum: ["a", "b", "c"] }` |
| `array` | `{ type: "array", items: { type: "string" } }` |

## Best Practices

- **Keep the description short and clear** — the LLM uses this to decide when to call your action.
- **One action = one job** — don't make a "do_everything" action.
- **Return structured data** — `{ ok: true, ... }` is more LLM-friendly than a raw string.
- **Avoid side effects in `description`** — descriptions are sent to the LLM every turn.
