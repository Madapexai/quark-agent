/**
 * 共享类型
 */

import type { Agent } from "@micro-agent/core";

export interface ActionRouterOptions {
  registry: unknown;
  prefix?: string;
  auth?: (req: IncomingRequest) => Promise<string> | string;
}

export interface SSEHandlerOptions {
  sse: unknown;
  path?: string;
  auth?: (req: IncomingRequest) => Promise<string> | string;
}

export interface A2AHandlerOptions {
  registry: unknown;
  prefix?: string;
  auth?: (req: IncomingRequest) => Promise<string> | string;
}

export interface ChatHandlerOptions {
  getAgent: (userId: string) => Promise<Agent> | Agent;
  workspaceManager?: unknown;
  path?: string;
  auth?: (req: IncomingRequest) => Promise<string> | string;
}

export interface IncomingRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?(): Promise<unknown>;
  raw?: unknown;
}

export interface OutgoingResponse {
  status?: number;
  headers: Record<string, string>;
  body?: string | Uint8Array | ReadableStream;
}

export interface SSEServerResponse {
  write: (chunk: string) => void;
  end: () => void;
  writeHead?: (statusCode: number, headers?: Record<string, string>) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export function getHeader(req: IncomingRequest, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}
