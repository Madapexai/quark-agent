import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;              // 5-field cron expression
  prompt: string;            // prompt to run
  model?: string;            // optional model override
  enabled: boolean;
  lastRun?: number;
  nextRun: number;
  runCount: number;
  createdAt: number;
}

export interface TaskRunResult {
  taskId: string;
  success: boolean;
  reply?: string;
  error?: string;
  duration: number;
  timestamp: number;
}

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private dbPath: string;
  private runHandler: ((prompt: string, model?: string) => Promise<string>) | null = null;
  private runHistory: TaskRunResult[] = [];
  private readonly maxHistory = 100;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(process.cwd(), ".data", "scheduler.json");
    mkdirSync(join(this.dbPath, ".."), { recursive: true });
    this.load();
  }

  /** Set the handler that executes tasks */
  setRunner(handler: (prompt: string, model?: string) => Promise<string>): void {
    this.runHandler = handler;
  }

  /** Add a scheduled task */
  addTask(name: string, cron: string, prompt: string, model?: string): ScheduledTask {
    const task: ScheduledTask = {
      id: randomUUID(),
      name,
      cron,
      prompt,
      model,
      enabled: true,
      nextRun: this.parseCronNext(cron),
      runCount: 0,
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  /** Update a task */
  updateTask(id: string, updates: Partial<Omit<ScheduledTask, "id" | "createdAt">>): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    Object.assign(task, updates);
    if (updates.cron) task.nextRun = this.parseCronNext(updates.cron);
    this.save();
    return true;
  }

  /** Delete a task */
  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  /** Toggle task enabled/disabled */
  toggleTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.enabled = !task.enabled;
    if (task.enabled) task.nextRun = this.parseCronNext(task.cron);
    this.save();
    return true;
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.nextRun - b.nextRun);
  }

  getHistory(): TaskRunResult[] {
    return this.runHistory.slice(-this.maxHistory);
  }

  /** Start the scheduler loop (checks every minute) */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    console.log("[scheduler] Started — checking every 60s");
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Manually trigger a task */
  async runTask(id: string): Promise<TaskRunResult> {
    const task = this.tasks.get(id);
    if (!task) return { taskId: id, success: false, error: "Task not found", duration: 0, timestamp: Date.now() };
    return this.executeTask(task);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (task.nextRun <= now) {
        await this.executeTask(task);
        task.nextRun = this.parseCronNext(task.cron, now);
        this.save();
      }
    }
  }

  private async executeTask(task: ScheduledTask): Promise<TaskRunResult> {
    const start = Date.now();
    if (!this.runHandler) {
      const result: TaskRunResult = { taskId: task.id, success: false, error: "No runner configured", duration: 0, timestamp: start };
      this.recordHistory(result);
      return result;
    }
    try {
      const reply = await this.runHandler(task.prompt, task.model);
      task.lastRun = start;
      task.runCount++;
      const result: TaskRunResult = { taskId: task.id, success: true, reply, duration: Date.now() - start, timestamp: start };
      this.recordHistory(result);
      console.log(`[scheduler] Task "${task.name}" completed in ${result.duration}ms`);
      return result;
    } catch (err) {
      const result: TaskRunResult = { taskId: task.id, success: false, error: err instanceof Error ? err.message : String(err), duration: Date.now() - start, timestamp: start };
      this.recordHistory(result);
      console.error(`[scheduler] Task "${task.name}" failed:`, result.error);
      return result;
    }
  }

  private recordHistory(result: TaskRunResult): void {
    this.runHistory.push(result);
    if (this.runHistory.length > this.maxHistory) this.runHistory.shift();
  }

  /** Simple 5-field cron parser — returns next run timestamp */
  private parseCronNext(cron: string, from?: number): number {
    const now = from ?? Date.now();
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return now + 86400000; // default: 1 day

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const next = new Date(now + 60000); // start from next minute
    next.setSeconds(0, 0);

    // Simple matching: find next matching time within 7 days
    for (let i = 0; i < 10080; i++) { // 7 days * 24 * 60
      const d = new Date(next.getTime() + i * 60000);
      if (this.cronMatch(d, minute, hour, dayOfMonth, month, dayOfWeek)) {
        return d.getTime();
      }
    }
    return now + 86400000;
  }

  private cronMatch(date: Date, minute: string, hour: string, dom: string, month: string, dow: string): boolean {
    return this.fieldMatch(date.getMinutes(), minute) &&
           this.fieldMatch(date.getHours(), hour) &&
           this.fieldMatch(date.getDate(), dom) &&
           this.fieldMatch(date.getMonth() + 1, month) &&
           this.fieldMatch(date.getDay(), dow);
  }

  private fieldMatch(value: number, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.startsWith("*/")) {
      const step = parseInt(pattern.slice(2));
      return value % step === 0;
    }
    return pattern.split(",").some(p => {
      if (p.includes("-")) {
        const [start, end] = p.split("-").map(Number);
        return value >= start && value <= end;
      }
      return parseInt(p) === value;
    });
  }

  private save(): void {
    writeFileSync(this.dbPath, JSON.stringify({
      tasks: Array.from(this.tasks.values()),
      history: this.runHistory,
    }), "utf8");
  }

  private load(): void {
    try {
      const raw = readFileSync(this.dbPath, "utf8");
      const data = JSON.parse(raw);
      for (const task of data.tasks ?? []) {
        this.tasks.set(task.id, task);
      }
      this.runHistory = data.history ?? [];
    } catch { /* first run */ }
  }
}

export const scheduler = new Scheduler();
