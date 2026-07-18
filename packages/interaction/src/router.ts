/**
 * Action HTTP Router：ActionRegistry → REST API
 *
 * 每个注册的 action 自动暴露为 POST endpoint。
 * - POST /api/actions/:name → 执行 action，JSON body 为 input
 * - GET /api/actions → 列出所有 action（含 schema）
 * - OPTIONS /api/actions/* → CORS 预检
 */

import type { ActionRouterOptions, IncomingRequest, OutgoingResponse } from "./types.js";
import { jsonResponse, errorResponse, parseJsonBody, emptyResponse } from "./http-utils.js";
import { getHeader } from "./types.js";

type AnyActionDef = {
  name: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  expose?: string[];
  http?: { method?: string; path?: string };
  readOnly?: boolean;
  run: (input: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>;
};

type AnyRegistry = {
  forCaller?: (c: string) => AnyActionDef[];
  listFor?: (c: string) => Array<{ def: AnyActionDef }>;
  get: (n: string) => AnyActionDef | { def: AnyActionDef } | undefined;
};

function asRegistry(r: unknown): AnyRegistry {
  return r as AnyRegistry;
}

function getActionList(registry: unknown, caller: string): AnyActionDef[] {
  const r = asRegistry(registry);
  if (r.forCaller) {
    return r.forCaller(caller);
  }
  if (r.listFor) {
    return r.listFor(caller).map((ra) => ra.def);
  }
  return [];
}

function getActionDef(registry: unknown, name: string): AnyActionDef | null {
  const r = asRegistry(registry);
  const result = r.get(name);
  if (!result) return null;
  if ("def" in result && (result as { def: AnyActionDef }).def) {
    return (result as { def: AnyActionDef }).def;
  }
  return result as AnyActionDef;
}

async function callAction(
  registry: unknown,
  name: string,
  input: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<unknown> {
  const def = getActionDef(registry, name);
  if (!def) throw new Error(`Action not found: ${name}`);
  return await def.run(input, ctx);
}

function validateRequired(def: AnyActionDef, input: Record<string, unknown>): string | null {
  const required = def.parameters?.required;
  if (!required || !Array.isArray(required)) return null;
  for (const field of required) {
    if (input[field] === undefined) {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

export function createActionRouter(opts: ActionRouterOptions) {
  const prefix = opts.prefix ?? "/api/actions";
  const registry = opts.registry;

  return {
    matches(req: IncomingRequest): boolean {
      return req.url.startsWith(prefix);
    },

    async handle(req: IncomingRequest): Promise<OutgoingResponse> {
      const origin = getHeader(req, "Origin");

      if (req.method === "OPTIONS") {
        return emptyResponse(204, { origin });
      }

      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      if (pathname === prefix || pathname === `${prefix}/`) {
        if (req.method === "GET") {
          const actions = getActionList(registry, "http").map((a) => ({
            name: a.name,
            description: a.description,
            parameters: a.parameters,
            method: a.http?.method ?? "POST",
            path: a.http?.path ?? `${prefix}/${a.name}`,
            readOnly: a.readOnly ?? false,
          }));
          return jsonResponse(200, { actions }, { origin });
        }
      }

      const actionPath = pathname.slice(prefix.length + 1);
      if (actionPath && req.method === "POST") {
        const def = getActionDef(registry, actionPath);
        if (!def) return errorResponse(404, "NOT_FOUND", `Action not found: ${actionPath}`);
        if (def.expose && !def.expose.includes("http")) {
          return errorResponse(403, "FORBIDDEN", `Action ${actionPath} not exposed to HTTP`);
        }

        let userId = "anonymous";
        if (opts.auth) {
          try {
            userId = await opts.auth(req);
          } catch {
            return errorResponse(401, "UNAUTHORIZED", "Unauthorized");
          }
        }

        let input: Record<string, unknown> = {};
        try {
          const parsed = await parseJsonBody(req);
          input = (parsed as Record<string, unknown>) ?? {};
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          return errorResponse(status, status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
            status === 413 ? "Request body too large" : "Invalid JSON body");
        }

        const validationError = validateRequired(def, input);
        if (validationError) {
          return errorResponse(400, "VALIDATION_ERROR", validationError);
        }

        const ctx: Record<string, unknown> = {
          caller: "http",
          userId,
          sessionId: url.searchParams.get("sessionId") ?? undefined,
          raw: req,
        };

        try {
          const result = await callAction(registry, actionPath, input, ctx);
          return jsonResponse(200, { result }, { origin });
        } catch (err) {
          console.error(`[router] Action ${actionPath} error:`, err);
          return errorResponse(500, "INTERNAL_ERROR", "Internal server error");
        }
      }

      return errorResponse(404, "NOT_FOUND", "Not found");
    },
  };
}
