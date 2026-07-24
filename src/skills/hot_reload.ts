import { watch, FSWatcher, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { EventEmitter } from "node:events";

export interface HotReloadEvent {
  type: "added" | "changed" | "removed";
  pluginName: string;
  path: string;
  timestamp: number;
}

export class PluginHotReloader extends EventEmitter {
  private watchers: Map<string, FSWatcher> = new Map();
  private pluginsDir: string;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly debounceMs = 500;

  constructor(pluginsDir: string) {
    super();
    this.pluginsDir = pluginsDir;
  }

  /** Start watching the plugins directory */
  start(): void {
    if (!existsSync(this.pluginsDir)) return;

    const watcher = watch(this.pluginsDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const fullPath = join(this.pluginsDir, filename);
      const pluginName = filename.split(/[\\/]/)[0]; // top-level directory = plugin name

      // Debounce — avoid multiple events for same file
      const existing = this.debounceTimers.get(pluginName);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(pluginName, setTimeout(() => {
        this.debounceTimers.delete(pluginName);
        const event: HotReloadEvent = {
          type: eventType === "rename" ? (existsSync(fullPath) ? "added" : "removed") : "changed",
          pluginName,
          path: fullPath,
          timestamp: Date.now(),
        };
        this.emit("reload", event);
        console.log(`[hot-reload] ${event.type}: ${pluginName}`);
      }, this.debounceMs));
    });

    this.watchers.set(this.pluginsDir, watcher);
    console.log(`[hot-reload] Watching ${this.pluginsDir}`);
  }

  /** Stop watching */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /** Watch a specific plugin directory */
  watchPlugin(pluginPath: string): void {
    if (!existsSync(pluginPath)) return;
    const pluginName = basename(pluginPath);

    const watcher = watch(pluginPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const existing = this.debounceTimers.get(pluginName);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(pluginName, setTimeout(() => {
        this.debounceTimers.delete(pluginName);
        const fullPath = join(pluginPath, filename);
        const event: HotReloadEvent = {
          type: eventType === "rename" ? (existsSync(fullPath) ? "added" : "removed") : "changed",
          pluginName,
          path: fullPath,
          timestamp: Date.now(),
        };
        this.emit("reload", event);
      }, this.debounceMs));
    });

    this.watchers.set(pluginPath, watcher);
  }

  /** Unwatch a specific plugin */
  unwatchPlugin(pluginPath: string): void {
    const watcher = this.watchers.get(pluginPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(pluginPath);
    }
  }
}
