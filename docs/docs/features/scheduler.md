# Cron Scheduler

Schedule recurring agent tasks with standard cron expressions.

## Overview

The scheduler runs tasks on a cron schedule. Each task contains a prompt that is sent to the agent when the task fires.

## Quick Start

```ts
import { scheduler } from "quark-agent";

// Set the runner (usually done automatically by dashboard)
scheduler.setRunner(async (prompt) => {
  const result = await agent.run(prompt);
  return result.reply;
});

// Add tasks
scheduler.addTask("morning-brief", "0 9 * * 1-5", "Summarize today's schedule");
scheduler.addTask("weekly-report", "0 17 * * 5", "Generate weekly progress report");

// Start the scheduler (checks every 60 seconds)
scheduler.start();
```

## Cron Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|-----------|---------|
| `0 9 * * 1-5` | 9:00 AM, Mon-Fri |
| `0 17 * * 5` | 5:00 PM every Friday |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 0` | Midnight every Sunday |
| `0 0 1 * *` | Midnight on 1st of every month |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/scheduler/tasks` | List tasks |
| POST | `/api/scheduler/tasks` | Create task |
| PUT | `/api/scheduler/tasks/:id` | Update |
| DELETE | `/api/scheduler/tasks/:id` | Delete |
| POST | `/api/scheduler/run/:id` | Trigger now |
| GET | `/api/scheduler/history` | Run history |
