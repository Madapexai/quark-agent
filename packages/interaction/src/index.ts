/**
 * @micro-agent/interaction —— UI 交互层
 *
 * 为前端 UI 提供开箱即用的 HTTP 接口：
 * 1. Action HTTP router：ActionRegistry → REST API
 * 2. SSE stream：EventBus → /stream SSE endpoint
 * 3. A2A HTTP endpoint：A2ARegistry → /.well-known/agent.json + /a2a/*
 * 4. Chat HTTP API：agent.run → /api/chat
 *
 * 设计目标：零框架依赖，返回纯 RequestListener，可挂到 Node http/Express/Fastify/Bun.serve
 */

export { createActionRouter } from "./router.js";
export { createSSEHandler, sseHeaders } from "./sse.js";
export { createA2AHandler } from "./a2a-http.js";
export { createChatHandler } from "./chat.js";

export {
  corsHeaders,
  sseResponseHeaders,
  jsonResponse,
  errorResponse,
  parseJsonBody,
  emptyResponse,
} from "./http-utils.js";

export { getHeader } from "./types.js";

export type {
  ActionRouterOptions,
  SSEHandlerOptions,
  A2AHandlerOptions,
  ChatHandlerOptions,
  IncomingRequest,
  OutgoingResponse,
  SSEServerResponse,
} from "./types.js";
