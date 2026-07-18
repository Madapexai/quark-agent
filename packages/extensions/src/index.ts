/**
 * @micro-agent/extensions —— 高阶扩展入口
 */

export { sessionsExtension, getSessionStore } from "./sessions.js";
export type { SessionStore } from "./sessions.js";

import { sessionsExtension } from "./sessions.js";

export function recommendedExtensions() {
  return [sessionsExtension()];
}
