/**
 * SSE Handler：EventBus → /stream SSE endpoint
 *
 * 前端通过 EventSource 连接，接收实时事件：
 * - connected: 连接确认（clientId）
 * - run_start/run_end/tool_call/tool_result/chunk/error: agent 生命周期
 * - state_change/action/a2a: 其他事件
 *
 * 支持 query 参数过滤：
 * - ?sessionId=xxx: 只接收该 session 的事件
 */

import type { SSEHandlerOptions, IncomingRequest, SSEServerResponse } from "./types.js";
import { sseResponseHeaders, corsHeaders } from "./http-utils.js";
import { getHeader } from "./types.js";

type AnySSEServer = {
  addClient(client: Record<string, unknown>): { id: string };
  removeClient(id: string): void;
};

function asSSE(s: unknown): AnySSEServer {
  return s as AnySSEServer;
}

export function sseHeaders(): Record<string, string> {
  return sseResponseHeaders();
}

export function createSSEHandler(opts: SSEHandlerOptions) {
  const path = opts.path ?? "/stream";
  const sse = asSSE(opts.sse);

  return {
    matches(req: IncomingRequest): boolean {
      return req.url.startsWith(path);
    },

    async handle(req: IncomingRequest, res: SSEServerResponse): Promise<void> {
      if (req.method === "OPTIONS") {
        if (res.writeHead) {
          res.writeHead(204, corsHeaders(getHeader(req, "Origin")));
        }
        res.end();
        return;
      }

      const origin = getHeader(req, "Origin");
      const url = new URL(req.url, "http://localhost");
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const queryUserId = url.searchParams.get("userId") ?? undefined;

      let authUserId: string | undefined;
      if (opts.auth) {
        try {
          authUserId = await opts.auth(req);
        } catch {
          const errBody = JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
          if (res.writeHead) {
            res.writeHead(401, {
              "Content-Type": "application/json",
              ...corsHeaders(origin),
            });
          }
          res.write(errBody);
          res.end();
          return;
        }
      }

      const effectiveUserId = authUserId ?? queryUserId ?? "anonymous";

      if (res.writeHead) {
        res.writeHead(200, {
          ...sseResponseHeaders(),
          ...corsHeaders(origin),
        });
      }

      const client = sse.addClient({
        write: (data: string) => {
          try { res.write(data); } catch { /* ignore write errors */ }
        },
        end: () => {
          try { res.end(); } catch { /* ignore end errors */ }
        },
        userId: effectiveUserId,
        sessionId,
      });

      const cleanup = () => {
        sse.removeClient(client.id);
        if (res.off) {
          res.off("close", cleanup);
          res.off("error", cleanup);
          res.off("finish", cleanup);
        }
      };

      if (res.on) {
        res.on("close", cleanup);
        res.on("error", cleanup);
        res.on("finish", cleanup);
      }
    },
  };
}
