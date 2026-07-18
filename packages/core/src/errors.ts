/**
 * @micro-agent/core —— 错误类型
 */

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class PluginError extends AgentError {
  constructor(plugin: string, message: string, cause?: unknown) {
    super(`[${plugin}] ${message}`, "PLUGIN_ERROR", cause);
    this.name = "PluginError";
  }
}

export class ToolError extends AgentError {
  constructor(tool: string, message: string, cause?: unknown) {
    super(`[tool:${tool}] ${message}`, "TOOL_ERROR", cause);
    this.name = "ToolError";
  }
}

export class AuthError extends AgentError {
  constructor(scope: string, message: string) {
    super(`[auth:${scope}] ${message}`, "AUTH_ERROR");
    this.name = "AuthError";
  }
}

export class TimeoutError extends AgentError {
  constructor(operation: string, ms: number) {
    super(`[timeout] ${operation} exceeded ${ms}ms`, "TIMEOUT");
    this.name = "TimeoutError";
  }
}
