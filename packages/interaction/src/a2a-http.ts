/**
 * A2A HTTP Handler：A2ARegistry → /.well-known/agent.json + /a2a/*
 *
 * 实现 Google A2A 协议 HTTP transport：
 * - GET /.well-known/agent.json → AgentCard[]
 * - POST /a2a/tasks/send → 发送消息到 task
 * - POST /a2a/tasks/create → 创建新 task
 * - GET /a2a/tasks/:id → 查询 task
 * - POST /a2a/tasks/:id/cancel → 取消 task (stub)
 * - OPTIONS /a2a/* → CORS 预检
 */

import type { A2AHandlerOptions, IncomingRequest, OutgoingResponse } from "./types.js";
import { jsonResponse, errorResponse, parseJsonBody, emptyResponse } from "./http-utils.js";
import { getHeader } from "./types.js";

type A2AMessageLike = {
  role: "user" | "agent";
  parts: Array<{ kind: string; text?: string; data?: Record<string, unknown> }>;
};

type AnyA2AAgent = {
  sendMessage(taskId: string, message: unknown, ctx?: Record<string, unknown>): Promise<unknown>;
  createTask(message: unknown, ctx?: Record<string, unknown>): Promise<unknown>;
  getTask(taskId: string): Promise<unknown | null>;
  cancelTask(taskId: string): Promise<unknown | null>;
};

type AnyA2ARegistry = {
  discover: () => Array<Record<string, unknown>>;
  get: (name: string) => AnyA2AAgent | null;
};

function asA2ARegistry(r: unknown): AnyA2ARegistry {
  return r as AnyA2ARegistry;
}

function isValidMessage(msg: unknown): msg is A2AMessageLike {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.role !== "user" && m.role !== "agent") return false;
  if (!Array.isArray(m.parts)) return false;
  return true;
}

export function createA2AHandler(opts: A2AHandlerOptions) {
  const prefix = opts.prefix ?? "/a2a";
  const registry = asA2ARegistry(opts.registry);

  async function authenticate(req: IncomingRequest): Promise<string | OutgoingResponse> {
    if (!opts.auth) return "anonymous";
    try {
      return await opts.auth(req);
    } catch {
      return errorResponse(401, "UNAUTHORIZED", "Unauthorized");
    }
  }

  return {
    matches(req: IncomingRequest): boolean {
      return req.url.startsWith(prefix) || req.url.startsWith("/.well-known/agent.json");
    },

    async handle(req: IncomingRequest): Promise<OutgoingResponse> {
      const origin = getHeader(req, "Origin");

      if (req.method === "OPTIONS") {
        return emptyResponse(204, { origin });
      }

      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/.well-known/agent.json" && req.method === "GET") {
        try {
          return jsonResponse(200, registry.discover(), { origin });
        } catch (err) {
          console.error("[a2a] discover error:", err);
          return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
        }
      }

      if (!pathname.startsWith(prefix)) return errorResponse(404, "NOT_FOUND", "Not found");
      const subPath = pathname.slice(prefix.length);

      const authResult = await authenticate(req);
      if (typeof authResult !== "string") return authResult;

      if (subPath === "/tasks/send" && req.method === "POST") {
        let body: Record<string, unknown> = {};
        try {
          const parsed = await parseJsonBody(req);
          body = (parsed as Record<string, unknown>) ?? {};
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          return errorResponse(status, status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
            status === 413 ? "Request body too large" : "Invalid JSON body");
        }

        const agentName = url.searchParams.get("agent") ?? (typeof body.agent === "string" ? body.agent : undefined);
        const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
        const message = body.message;

        if (typeof agentName !== "string" || !agentName) {
          return errorResponse(400, "VALIDATION_ERROR", "agent required");
        }
        if (!isValidMessage(message)) {
          return errorResponse(400, "VALIDATION_ERROR", "message required and must be a valid A2A message");
        }

        const agent = registry.get(agentName);
        if (!agent) return errorResponse(404, "NOT_FOUND", `Agent not found: ${agentName}`);

        try {
          const task = taskId
            ? await agent.sendMessage(taskId, message)
            : await agent.createTask(message);
          return jsonResponse(200, task, { origin });
        } catch (err) {
          console.error(`[a2a] sendMessage error (agent=${agentName}):`, err);
          return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
        }
      }

      if (subPath === "/tasks/create" && req.method === "POST") {
        let body: Record<string, unknown> = {};
        try {
          const parsed = await parseJsonBody(req);
          body = (parsed as Record<string, unknown>) ?? {};
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          return errorResponse(status, status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
            status === 413 ? "Request body too large" : "Invalid JSON body");
        }

        const agentName = url.searchParams.get("agent") ?? (typeof body.agent === "string" ? body.agent : undefined);
        const message = body.message;

        if (typeof agentName !== "string" || !agentName) {
          return errorResponse(400, "VALIDATION_ERROR", "agent required");
        }
        if (!isValidMessage(message)) {
          return errorResponse(400, "VALIDATION_ERROR", "message required and must be a valid A2A message");
        }

        const agent = registry.get(agentName);
        if (!agent) return errorResponse(404, "NOT_FOUND", `Agent not found: ${agentName}`);

        try {
          const task = await agent.createTask(message);
          return jsonResponse(201, task, { origin });
        } catch (err) {
          console.error(`[a2a] createTask error (agent=${agentName}):`, err);
          return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
        }
      }

      const taskCancelMatch = subPath.match(/^\/tasks\/([^/]+)\/cancel$/);
      if (taskCancelMatch && req.method === "POST") {
        return errorResponse(501, "NOT_IMPLEMENTED", "Cancel task is not implemented yet");
      }

      const taskMatch = subPath.match(/^\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === "GET") {
        const taskId = taskMatch[1];
        const agentName = url.searchParams.get("agent");
        if (!agentName) return errorResponse(400, "VALIDATION_ERROR", "agent query param required");

        const agent = registry.get(agentName);
        if (!agent) return errorResponse(404, "NOT_FOUND", `Agent not found: ${agentName}`);

        try {
          const task = await agent.getTask(taskId);
          if (!task) return errorResponse(404, "NOT_FOUND", "Task not found");
          return jsonResponse(200, task, { origin });
        } catch (err) {
          console.error(`[a2a] getTask error (agent=${agentName}, task=${taskId}):`, err);
          return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
        }
      }

      return errorResponse(404, "NOT_FOUND", "Not found");
    },
  };
}
