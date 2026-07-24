import type { Tool, ToolContext } from "../core/types.js";

export interface OpenAIFunctionDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface FunctionCallResult {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

/** Convert quark-agent tools to OpenAI function calling format */
export function toolsToOpenAIFormat(tools: Tool[]): OpenAIFunctionDef[] {
  return tools.map((tool) => {
    const params = (tool.schema?.function?.parameters ?? {
      type: "object",
      properties: {},
      required: [],
    }) as {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: params,
      },
    };
  });
}

/**
 * Parse OpenAI tool_calls from LLM response and execute matching tools.
 *
 * The Tool trait requires a ToolContext; callers may pass one via `ctx`.
 * If omitted, a minimal stub is supplied (matching the agent's own `as never`
 * pattern). Tools that actually need a real sandbox/agent should be invoked
 * through the Agent itself, not this helper.
 */
export async function executeToolCalls(
  toolCalls: { id: string; function: { name: string; arguments: string } }[],
  tools: Map<string, Tool>,
  ctx?: ToolContext,
): Promise<FunctionCallResult[]> {
  const results: FunctionCallResult[] = [];
  for (const call of toolCalls) {
    const tool = tools.get(call.function.name);
    if (!tool) {
      results.push({
        name: call.function.name,
        arguments: {},
        result: { error: `Tool not found: ${call.function.name}` },
      });
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = {};
    }
    try {
      const result = await tool.execute(args, ctx as ToolContext);
      results.push({ name: call.function.name, arguments: args, result });
    } catch (err) {
      results.push({
        name: call.function.name,
        arguments: args,
        result: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return results;
}

/** Format tool results as OpenAI tool messages */
export function formatToolResults(results: FunctionCallResult[]): unknown[] {
  return results.map((r) => ({
    role: "tool",
    tool_call_id: r.name,
    content: JSON.stringify(r.result),
  }));
}
