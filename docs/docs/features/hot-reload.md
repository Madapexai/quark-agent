# Plugin Hot Reload

Automatic plugin reloading without restart.

## Overview

The Plugin Hot Reloader watches the plugins directory for changes and emits events when files are added, changed, or removed - no restart required.

## Quick Start

```ts
import { PluginHotReloader } from "quark-agent";

const reloader = new PluginHotReloader(".quark-plugins");

reloader.on("reload", (event) => {
  console.log(`[${event.type}] ${event.pluginName}`);
  // Reload the plugin, update tool registry, etc.
});

reloader.start();
```

## Events

| Event Type | Description |
|------------|-------------|
| `added` | A new file was added |
| `changed` | An existing file was modified |
| `removed` | A file was deleted |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `pluginsDir` | `.quark-plugins` | Directory to watch |
| `debounceMs` | 500 | Debounce interval |

## Methods

| Method | Description |
|--------|-------------|
| `start()` | Begin watching |
| `stop()` | Stop watching |
| `watchPlugin(path)` | Watch a specific plugin |
| `unwatchPlugin(path)` | Stop watching a plugin |
