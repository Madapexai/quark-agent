/**
 * HTTP 工具函数：CORS、JSON响应、错误处理、请求体解析
 */

import type { IncomingRequest, OutgoingResponse } from "./types.js";

const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

export function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export function sseResponseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  init?: { cors?: boolean; headers?: Record<string, string>; origin?: string },
): OutgoingResponse {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers ?? {}),
  };
  if (init?.cors !== false) {
    Object.assign(headers, corsHeaders(init?.origin));
  }
  return {
    status,
    headers,
    body: JSON.stringify(body),
  };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
): OutgoingResponse {
  return jsonResponse(status, { error: { code, message } });
}

export async function parseJsonBody(
  req: IncomingRequest,
  maxSize: number = DEFAULT_MAX_BODY_SIZE,
): Promise<unknown> {
  if (!req.body) return {};
  const raw = await req.body();
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    if (raw.length > maxSize) {
      const err = new Error("Request body too large");
      (err as any).status = 413;
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error("Invalid JSON body");
      (err as any).status = 400;
      throw err;
    }
  }
  if (typeof raw === "object") {
    return raw;
  }
  const err = new Error("Invalid JSON body");
  (err as any).status = 400;
  throw err;
}

export function emptyResponse(status: number = 204, init?: { cors?: boolean; origin?: string }): OutgoingResponse {
  const headers: Record<string, string> = {};
  if (init?.cors !== false) {
    Object.assign(headers, corsHeaders(init?.origin));
  }
  return { status, headers, body: "" };
}
