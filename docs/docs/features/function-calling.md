# Function Calling

Standardized OpenAI function calling format.

## Overview

Quark Agent's tools can be converted to and from the OpenAI function calling format, enabling interoperability with any tool that uses the OpenAI tool-calling standard.

## API

### Convert Tools to OpenAI Format

```ts
import { toolsToOpenAIFormat } from "quark-agent";

const openaiTools = toolsToOpenAIFormat(myTools);
// -> [{
//   type: "function",
//   function: {
//     name: "read_file",
//     description: "Read a file",
//     parameters: { type: "object", properties: {...}, required: [...] }
//   }
// }]
```

### Execute Tool Calls

When an LLM returns `tool_calls`, execute them:

```ts
import { executeToolCalls } from "quark-agent";

const results = await executeToolCalls(
  [{ id: "1", function: { name: "read_file", arguments: '{"path":"test.txt"}' } }],
  toolMap  // Map<string, Tool>
);
// -> [{ name: "read_file", arguments: { path: "test.txt" }, result: "file contents" }]
```

### Format Results

Format tool results as OpenAI tool messages:

```ts
import { formatToolResults } from "quark-agent";

const messages = formatToolResults(results);
// -> [{ role: "tool", tool_call_id: "read_file", content: '{"result":"..."}' }]
```
