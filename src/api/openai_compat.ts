import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface ChatCompletionRequest {
  model: string;
  messages: {
    role: "system" | "user" | "assistant" | "tool";
    content: string | unknown[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: "stop" | "tool_calls" | "length";
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { content?: string; tool_calls?: Partial<ToolCall>[] };
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }[];
}

export type AgentRunnerResult = {
  reply: string;
  rounds: number;
  toolCalls: number;
  contextTokens: number;
};

export type AgentRunner = (
  text: string,
  opts?: { sessionId?: string; tools?: OpenAITool[] },
) => Promise<AgentRunnerResult>;

/**
 * OpenAI-compatible HTTP handler.
 *
 * Exposes a minimal /v1/chat/completions, /v1/models, /v1/embeddings surface
 * that delegates to a quark-agent runner. Designed to be embedded inside any
 * Node http.Server.
 */
export class OpenAICompatHandler {
  private readonly agentRunner: AgentRunner;

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) {
      this.writeJSON(res, 400, { error: { message: "Invalid request body" } });
      return;
    }

    const path = req.url ?? "";

    // GET /v1/models — list available models
    if (req.method === "GET" && path === "/v1/models") {
      this.writeJSON(res, 200, {
        object: "list",
        data: [
          { id: "quark-agent", object: "model", created: Date.now(), owned_by: "quark-agent" },
        ],
      });
      return;
    }

    // POST /v1/chat/completions
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const request = body as ChatCompletionRequest;
      const messages = request.messages ?? [];

      const lastUserMsg = messages.filter((m) => m.role === "user").pop();
      if (!lastUserMsg) {
        this.writeJSON(res, 400, { error: { message: "No user message found" } });
        return;
      }
      const text =
        typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg.content);

      try {
        const result = await this.agentRunner(text, { tools: request.tools });
        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        if (request.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const words = result.reply.split(/(\s+)/);
          for (const word of words) {
            const chunk: ChatCompletionChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          const finalChunk: ChatCompletionChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          const completionTokens = Math.ceil(result.reply.length / 4);
          const response: ChatCompletionResponse = {
            id,
            object: "chat.completion",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: result.reply },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: result.contextTokens ?? 0,
              completion_tokens: completionTokens,
              total_tokens: (result.contextTokens ?? 0) + completionTokens,
            },
          };
          this.writeJSON(res, 200, response);
        }
      } catch (err) {
        this.writeJSON(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    // POST /v1/embeddings (placeholder)
    if (req.method === "POST" && path === "/v1/embeddings") {
      this.writeJSON(res, 200, {
        object: "list",
        data: [{ object: "embedding", embedding: new Array(1536).fill(0), index: 0 }],
        model: body.model ?? "text-embedding-ada-002",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
      return;
    }

    this.writeJSON(res, 404, { error: { message: "Not found" } });
  }

  private readBody(req: IncomingMessage): Promise<ChatCompletionRequest | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > 10 * 1024 * 1024) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatCompletionRequest);
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  private writeJSON(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
}
