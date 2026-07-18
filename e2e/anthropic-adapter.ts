/**
 * Anthropic-to-OpenAI Adapter Server
 *
 * Receives Anthropic Messages API requests, converts to OpenAI Chat Completions,
 * forwards to an OpenAI-compatible LLM API, and converts responses back.
 *
 * This bridges the model-proxy (which speaks Anthropic format) with
 * OpenAI-compatible LLM providers (DeepSeek, Z.ai, etc.)
 */
import * as http from "node:http";

const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "https://api.z.ai/api/v1";
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || process.env.ZAI_ANTHROPIC_AUTH_TOKEN || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || "GLM-4.5-Air";
const ADAPTER_AUTH_TOKEN = process.env.LOCAL_ADAPTER_AUTH_TOKEN || "local-adapter-token";
const PORT = parseInt(process.env.ADAPTER_PORT || "43192", 10);

// ---- Anthropic → OpenAI conversion ----

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  system?: string | Array<{ type: string; text: string }>;
  stream?: boolean;
  tools?: any[];
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: any[];
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.filter(c => c.type === "text").map(c => c.text || "").join("\n");
}

function convertToOpenAI(req: AnthropicRequest): { model: string; messages: OpenAIMessage[]; max_tokens?: number; stream?: boolean; tools?: any[] } {
  const messages: OpenAIMessage[] = [];

  // System message
  if (req.system) {
    const sysText = typeof req.system === "string" ? req.system : req.system.map(s => s.text).join("\n");
    messages.push({ role: "system", content: sysText });
  }

  // Convert messages
  for (const msg of req.messages) {
    messages.push({
      role: msg.role,
      content: extractText(msg.content),
    });
  }

  // Convert Anthropic tools to OpenAI format
  let tools: any[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return {
    model: UPSTREAM_MODEL,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
    tools,
  };
}

// ---- OpenAI → Anthropic conversion ----

function convertToAnthropic(data: any, model: string): any {
  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";

  // Convert tool calls
  const toolUse: any[] = [];
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      toolUse.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }

  const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// ---- Streaming conversion ----

function convertStreamChunk(chunk: any, _model: string): string[] {
  const events: string[] = [];
  const delta = chunk.choices?.[0]?.delta;

  if (delta?.content) {
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.content },
    })}\n\n`);
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name) {
        // Start of tool call
        events.push(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} },
        })}\n\n`);
      }
      if (tc.function?.arguments) {
        events.push(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        })}\n\n`);
      }
    }
  }

  if (chunk.choices?.[0]?.finish_reason) {
    events.push(`event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: chunk.choices[0].finish_reason === "tool_calls" ? "tool_use" : "end_turn" },
      usage: { output_tokens: chunk.usage?.completion_tokens || 0 },
    })}\n\n`);
  }

  return events;
}

// ---- HTTP Server ----

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "*" });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", upstream: UPSTREAM_BASE_URL, model: UPSTREAM_MODEL }));
    return;
  }

  if (req.method !== "POST" || !req.url?.includes("/v1/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Read body
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const bodyStr = Buffer.concat(chunks).toString("utf-8");

  let anthropicReq: AnthropicRequest;
  try {
    anthropicReq = JSON.parse(bodyStr);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request", message: "Invalid JSON" } }));
    return;
  }

  // Auth check
  const authHeader = req.headers["x-api-key"] as string || req.headers["authorization"] as string || "";
  const token = authHeader.replace("Bearer ", "");
  if (token !== ADAPTER_AUTH_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid auth token" } }));
    return;
  }

  // Convert to OpenAI format
  const openaiReq = convertToOpenAI(anthropicReq);
  const isStream = anthropicReq.stream === true;

  console.log(`[adapter] ${anthropicReq.model} -> ${openaiReq.model} (stream=${isStream}, messages=${openaiReq.messages.length})`);

  try {
    const upstreamRes = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${UPSTREAM_API_KEY}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error(`[adapter] upstream error: ${upstreamRes.status} ${errText.slice(0, 200)}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream error: ${upstreamRes.status}` } }));
      return;
    }

    if (isStream) {
      // Stream response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Send message_start event
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: anthropicReq.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`);

      // Send content_block_start for text
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`);

      const reader = upstreamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data);
            const events = convertStreamChunk(chunk, anthropicReq.model);
            for (const ev of events) res.write(ev);
          } catch {}
        }
      }

      // Send final events
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    } else {
      // Non-stream response
      const data = await upstreamRes.json();
      const anthropicRes = convertToAnthropic(data, anthropicReq.model);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(anthropicRes));
    }
  } catch (e: any) {
    console.error(`[adapter] error: ${e.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[anthropic-adapter] Running on http://127.0.0.1:${PORT}`);
  console.log(`  Upstream: ${UPSTREAM_BASE_URL}`);
  console.log(`  Model: ${UPSTREAM_MODEL}`);
  console.log(`  Auth token: ${ADAPTER_AUTH_TOKEN.slice(0, 8)}...`);
});
