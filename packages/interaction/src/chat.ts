/**
 * Chat HTTP Handler：agent.run → /api/chat
 *
 * 简单 REST chat API：
 * - POST /api/chat { message, sessionId? } → { reply, sessionId }
 * - OPTIONS /api/chat → CORS 预检
 */

import type { Scope } from "@micro-agent/core";
import type { ChatHandlerOptions, IncomingRequest, OutgoingResponse } from "./types.js";
import { jsonResponse, errorResponse, parseJsonBody, emptyResponse } from "./http-utils.js";
import { getHeader } from "./types.js";

const MAX_MESSAGE_LENGTH = 32768;

const FULL_SCOPE: Scope = {
  tools: "*",
  sandboxTier: "full",
  models: "*",
  memoryDomains: "*",
};

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `sess_${crypto.randomUUID()}`;
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createChatHandler(opts: ChatHandlerOptions) {
  const path = opts.path ?? "/api/chat";

  return {
    matches(req: IncomingRequest): boolean {
      return req.url.startsWith(path);
    },

    async handle(req: IncomingRequest): Promise<OutgoingResponse> {
      const origin = getHeader(req, "Origin");

      if (req.method === "OPTIONS") {
        return emptyResponse(204, { origin });
      }

      if (req.method !== "POST") {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }

      let userId = "anonymous";
      if (opts.auth) {
        try {
          userId = await opts.auth(req);
        } catch (err) {
          console.error("[chat] Auth failed:", err);
          return errorResponse(401, "UNAUTHORIZED", "Unauthorized");
        }
      }

      let body: Record<string, unknown> = {};
      try {
        const parsed = await parseJsonBody(req);
        body = (parsed as Record<string, unknown>) ?? {};
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        return errorResponse(status, status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
          status === 413 ? "Request body too large" : "Invalid JSON body");
      }

      const message = body.message;
      if (typeof message !== "string") {
        return errorResponse(400, "VALIDATION_ERROR", "message must be a string");
      }
      if (!message || message.trim().length === 0) {
        return errorResponse(400, "VALIDATION_ERROR", "message required");
      }
      if (message.length > MAX_MESSAGE_LENGTH) {
        return errorResponse(400, "VALIDATION_ERROR", `message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
      }

      const sessionId = typeof body.sessionId === "string" && body.sessionId
        ? body.sessionId
        : generateSessionId();

      try {
        const agent = await opts.getAgent(userId);
        const result = await agent.run(message, {
          userId,
          sessionId,
          scope: FULL_SCOPE,
        });
        return jsonResponse(200, { reply: result.reply, sessionId, rounds: result.rounds, toolCalls: result.toolCalls }, { origin });
      } catch (err) {
        console.error("[chat] Agent run error:", err);
        return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
      }
    },
  };
}
