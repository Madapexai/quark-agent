# Checkpoint & Long-Running Programming

Long-running agent tasks can be interrupted by crashes, timeouts, or user pauses. Checkpointing persists agent state so you can resume exactly where you left off.

## State Persistence

A checkpoint captures the full agent state at a point in time:

- **Conversation history** — all messages and tool results
- **Tool execution state** — which tools have run, their outputs
- **Working context** — current task, variables, file handles
- **Metadata** — timestamp, task ID, complexity tier

Checkpoints are stored as JSON files in the `.checkpoints/` directory (configurable):

```
.checkpoints/
├── task_abc123/
│   ├── checkpoint_001.json
│   ├── checkpoint_002.json
│   └── latest.json → checkpoint_002.json
└── task_def456/
    ├── checkpoint_001.json
    └── latest.json → checkpoint_001.json
```

## Auto-Save

When enabled, the agent automatically saves a checkpoint at a configurable interval:

```json
{
  "checkpoint": {
    "enabled": true,
    "autoSaveIntervalMs": 30000,
    "dir": ".checkpoints"
  }
}
```

Or via environment variables:

```env
CHECKPOINT_DIR=.checkpoints
CHECKPOINT_AUTO_SAVE_MS=30000
```

Auto-save triggers after each tool call completes, ensuring the checkpoint reflects a consistent state.

## Crash Recovery / Resume

If the agent process crashes or is interrupted, resume from the latest checkpoint:

```bash
# Resume the most recent task
quark-agent resume

# Resume a specific task
quark-agent resume --task-id task_abc123

# Resume from a specific checkpoint
quark-agent resume --task-id task_abc123 --checkpoint checkpoint_001
```

The agent replays the conversation history and tool results from the checkpoint, then continues execution from the last unfinished step.

Programmatic resume:

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  profile: "coding",
  checkpoint: { enabled: true },
});

// Start a long task
const taskId = await agent.run("Refactor the entire auth module");

// Later — if interrupted, resume:
await agent.resume({ taskId });
```

## API Reference

### `CheckpointManager`

| Method | Description |
|---|---|
| `save(taskId, state)` | Save a checkpoint for the given task |
| `load(taskId, checkpointId?)` | Load a checkpoint (defaults to `latest`) |
| `list(taskId)` | List all checkpoints for a task |
| `delete(taskId, checkpointId?)` | Delete a checkpoint (or all if no ID) |
| `prune(taskId, keepLast?)` | Keep only the last N checkpoints |

### `CheckpointConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable checkpointing |
| `autoSaveIntervalMs` | `number` | `30000` | Auto-save interval |
| `dir` | `string` | `.checkpoints` | Storage directory |
| `maxCheckpoints` | `number` | `10` | Max checkpoints per task before pruning |

## Example Usage

### Basic checkpointing

```ts
import { createAgent } from "quark-agent";

const { agent } = await createAgent({
  profile: "full",
  checkpoint: {
    enabled: true,
    autoSaveIntervalMs: 15000,
    dir: ".checkpoints",
  },
});

// The agent auto-saves every 15 seconds during execution
const result = await agent.run("Migrate the database schema from v2 to v3");
```

### Manual save and resume

```ts
import { createAgent, CheckpointManager } from "quark-agent";

const { agent } = await createAgent({ profile: "coding" });
const checkpoint = new CheckpointManager({ dir: ".checkpoints" });

// Run and manually save
const state = await agent.run("Implement OAuth2 flow");
await checkpoint.save("task_oauth", state);

// ... later, after a crash ...

// Resume from saved state
const saved = await checkpoint.load("task_oauth");
await agent.resume(saved);
```

### CLI workflow

```bash
# Start a task with checkpointing enabled
quark-agent --checkpoint --checkpoint-interval 15000

# If interrupted, resume
quark-agent resume

# List saved checkpoints
quark-agent checkpoint list

# Clean up old checkpoints
quark-agent checkpoint prune --keep-last 3
```
