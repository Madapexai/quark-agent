# Workflow DAG Engine

Visual workflow orchestration with 7 node types and conditional branching.

## Overview

The Workflow Engine lets you build multi-step agent pipelines as a Directed Acyclic Graph (DAG). Each node performs an action (LLM call, tool execution, condition check, etc.) and passes output to the next node.

## Node Types

| Type | Description | Config |
|------|-------------|--------|
| `input` | Entry point, receives input text | - |
| `llm` | Call an LLM with a prompt | `prompt`, `model` |
| `tool` | Execute a built-in tool | `toolName`, `toolArgs` |
| `condition` | Branch based on JS expression | `condition`, `trueBranch`, `falseBranch` |
| `code` | Execute JavaScript code | `code` |
| `delay` | Wait for specified milliseconds | `delayMs` |
| `output` | Format and return result | `outputFormat` |

## Quick Start

```ts
import { workflowEngine } from "quark-agent";

// Create a workflow
const wf = workflowEngine.createWorkflow("data-pipeline", "Process and summarize");

// Add nodes
const inputNode = workflowEngine.addNode(wf.id, {
  type: "input", name: "raw_data", config: {}, position: { x: 0, y: 0 }
});
const llmNode = workflowEngine.addNode(wf.id, {
  type: "llm", name: "summarize",
  config: { prompt: "Summarize this: ${raw_data}" },
  position: { x: 200, y: 0 }
});
const outputNode = workflowEngine.addNode(wf.id, {
  type: "output", name: "result",
  config: { outputFormat: "markdown" },
  position: { x: 400, y: 0 }
});

// Connect nodes
workflowEngine.addEdge(wf.id, { from: inputNode.id, to: llmNode.id });
workflowEngine.addEdge(wf.id, { from: llmNode.id, to: outputNode.id });

// Execute
const result = await workflowEngine.run(wf.id, "Some input data to process");
console.log(result.outputs.result);
```

## Conditional Branching

```ts
const conditionNode = workflowEngine.addNode(wf.id, {
  type: "condition", name: "check_length",
  config: {
    condition: "context.input.length > 100",
    trueBranch: longSummaryNode.id,
    falseBranch: shortReplyNode.id,
  },
  position: { x: 300, y: 100 }
});
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workflows` | List workflows |
| POST | `/api/workflows` | Create workflow |
| GET/PUT/DELETE | `/api/workflows/:id` | CRUD |
| POST | `/api/workflows/:id/run` | Execute |
| POST | `/api/workflows/:id/nodes` | Add node |
