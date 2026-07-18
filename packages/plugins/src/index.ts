export { a2aPlugin, getA2ARegistry, A2ARegistry } from "./a2a.js";
export type { A2AAgent, A2AMessage, A2ATask, A2AArtifact, AgentCard, AgentSkill, TaskState, A2APluginOptions, CallRemoteOptions } from "./a2a.js";

export { ssePlugin, getSSEServer, SSEServer } from "./sse.js";
export type { SSEClient, SyncEvent, SSEPluginOptions } from "./sse.js";

export { workspacePlugin, getWorkspaceManager, WorkspaceManager, InMemoryStore } from "./workspace.js";
export type { Workspace, WorkspaceConfig, MemoryFactory, WorkspacePluginOptions } from "./workspace.js";

export { defineActionPlugin, getActionApi, defineAction, ActionRegistry } from "./define-action.js";
export type { ActionDefinition, ActionContext, ActionCaller, RegisteredAction, DefineActionPluginApi } from "./define-action.js";

export { inMemoryPlugin, createInMemoryMemory, InMemoryStore as InMemoryMemory } from "./memory-inmemory.js";
export type { InMemoryPluginOptions } from "./memory-inmemory.js";

import { a2aPlugin } from "./a2a.js";
import { ssePlugin } from "./sse.js";
import { workspacePlugin } from "./workspace.js";
import { defineActionPlugin } from "./define-action.js";
import { inMemoryPlugin } from "./memory-inmemory.js";

export function recommendedPlugins() {
  return [inMemoryPlugin(), defineActionPlugin(), ssePlugin(), workspacePlugin(), a2aPlugin()];
}
