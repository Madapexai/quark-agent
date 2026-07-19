/**
 * Checkpoint Manager — enhanced checkpointing for long-running tasks
 *
 * Extends the basic session checkpoint system with:
 * - Rich metadata (task description, step tracking, status)
 * - Agent state snapshots (messages + tool history + variables)
 * - Auto-save with configurable intervals
 * - Pruning to keep only N most recent checkpoints per session
 * - Resume capability for interrupted long-running tasks
 */

import type Database from "better-sqlite3";
import type { Message } from "../core/types.js";

// ============================================================================
// Types
// ============================================================================

export interface CheckpointMetadata {
  sessionId: string;
  userId: string;
  /** Task description */
  task: string;
  /** Current step in long-running task */
  currentStep: number;
  /** Total steps (if known) */
  totalSteps?: number;
  /** Status */
  status: "running" | "paused" | "completed" | "failed";
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
  /** Agent state snapshot */
  state: {
    messages: Message[];
    toolHistory: Array<{ tool: string; args: unknown; result: string }>;
    variables: Record<string, unknown>;
  };
}

interface CheckpointRow {
  id: string;
  session_id: string;
  user_id: string;
  task: string;
  current_step: number;
  total_steps: number | null;
  status: string;
  created_at: number;
  updated_at: number;
  messages: string;
  tool_history: string;
  variables: string;
}

// ============================================================================
// CheckpointManager
// ============================================================================

export class CheckpointManager {
  private readonly db: Database.Database;
  private initialized = false;
  /** Track auto-save timers by session */
  private autoSaveTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints_v2 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        task TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        tool_history TEXT NOT NULL DEFAULT '[]',
        variables TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_cp2_session ON checkpoints_v2(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cp2_status ON checkpoints_v2(status);
    `);
    this.initialized = true;
  }

  /**
   * Save a checkpoint.
   * Returns the checkpoint ID.
   */
  async save(meta: CheckpointMetadata): Promise<string> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO checkpoints_v2
          (id, session_id, user_id, task, current_step, total_steps, status, created_at, updated_at, messages, tool_history, variables)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        meta.sessionId,
        meta.userId,
        meta.task,
        meta.currentStep,
        meta.totalSteps ?? null,
        meta.status,
        meta.createdAt,
        now,
        JSON.stringify(meta.state.messages),
        JSON.stringify(meta.state.toolHistory),
        JSON.stringify(meta.state.variables),
      );

    return id;
  }

  /**
   * Update an existing checkpoint by ID.
   */
  async update(id: string, changes: Partial<Pick<CheckpointMetadata, "status" | "currentStep" | "totalSteps" | "state">>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (changes.status !== undefined) {
      sets.push("status = ?");
      params.push(changes.status);
    }
    if (changes.currentStep !== undefined) {
      sets.push("current_step = ?");
      params.push(changes.currentStep);
    }
    if (changes.totalSteps !== undefined) {
      sets.push("total_steps = ?");
      params.push(changes.totalSteps);
    }
    if (changes.state !== undefined) {
      sets.push("messages = ?", "tool_history = ?", "variables = ?");
      params.push(
        JSON.stringify(changes.state.messages),
        JSON.stringify(changes.state.toolHistory),
        JSON.stringify(changes.state.variables),
      );
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);

    this.db
      .prepare(`UPDATE checkpoints_v2 SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  /**
   * Load the latest checkpoint for a session.
   */
  async load(sessionId: string): Promise<CheckpointMetadata | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM checkpoints_v2 WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(sessionId) as CheckpointRow | undefined;

    return row ? this.toMetadata(row) : null;
  }

  /**
   * List all checkpoints for a session, newest first.
   */
  async list(sessionId: string): Promise<CheckpointMetadata[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM checkpoints_v2 WHERE session_id = ? ORDER BY updated_at DESC",
      )
      .all(sessionId) as CheckpointRow[];

    return rows.map((r) => this.toMetadata(r));
  }

  /**
   * Resume from a checkpoint — returns the state to continue from.
   * Sets the checkpoint status to "running" and increments updatedAt.
   */
  async resume(sessionId: string): Promise<CheckpointMetadata | null> {
    const cp = await this.load(sessionId);
    if (!cp) return null;

    // Update status to running
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE checkpoints_v2 SET status = 'running', updated_at = ? WHERE session_id = ? AND updated_at = ?",
      )
      .run(now, sessionId, cp.updatedAt);

    return { ...cp, status: "running", updatedAt: now };
  }

  /**
   * Delete old checkpoints, keeping only the N most recent.
   * Returns the number of deleted checkpoints.
   */
  async prune(sessionId: string, keepLast = 10): Promise<number> {
    const rows = this.db
      .prepare(
        "SELECT id FROM checkpoints_v2 WHERE session_id = ? ORDER BY updated_at DESC",
      )
      .all(sessionId) as Array<{ id: string }>;

    const toDelete = rows.slice(keepLast);
    if (toDelete.length === 0) return 0;

    const stmt = this.db.prepare("DELETE FROM checkpoints_v2 WHERE id = ?");
    const deleteMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id);
    });
    deleteMany(toDelete.map((r) => r.id));

    return toDelete.length;
  }

  /**
   * Auto-save checkpoint.
   * Called periodically during long tasks.
   * Updates the latest checkpoint if one exists, or creates a new one.
   */
  async autoSave(
    sessionId: string,
    state: CheckpointMetadata["state"],
    meta?: Partial<Pick<CheckpointMetadata, "task" | "currentStep" | "totalSteps" | "status" | "userId">>,
  ): Promise<void> {
    const existing = await this.load(sessionId);

    if (existing) {
      await this.update(existing.sessionId + ":" + String(existing.updatedAt), {
        state,
        currentStep: meta?.currentStep,
        status: meta?.status,
      }).catch(async () => {
        // If update fails (e.g., ID mismatch), create a new checkpoint
        await this.save({
          sessionId,
          userId: meta?.userId ?? existing.userId,
          task: meta?.task ?? existing.task,
          currentStep: meta?.currentStep ?? existing.currentStep,
          totalSteps: meta?.totalSteps ?? existing.totalSteps,
          status: meta?.status ?? "running",
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
          state,
        });
      });
    } else {
      await this.save({
        sessionId,
        userId: meta?.userId ?? "system",
        task: meta?.task ?? "auto-save",
        currentStep: meta?.currentStep ?? 0,
        totalSteps: meta?.totalSteps,
        status: meta?.status ?? "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state,
      });
    }
  }

  /**
   * Start periodic auto-save for a session.
   * Call this when beginning a long-running task.
   */
  startAutoSave(
    sessionId: string,
    getState: () => CheckpointMetadata["state"],
    getMeta: () => Partial<Pick<CheckpointMetadata, "task" | "currentStep" | "totalSteps" | "status" | "userId">>,
    intervalSeconds = 60,
  ): void {
    this.stopAutoSave(sessionId);

    const timer = setInterval(() => {
      this.autoSave(sessionId, getState(), getMeta()).catch(() => undefined);
    }, intervalSeconds * 1000);

    this.autoSaveTimers.set(sessionId, timer);
  }

  /**
   * Stop periodic auto-save for a session.
   */
  stopAutoSave(sessionId: string): void {
    const timer = this.autoSaveTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.autoSaveTimers.delete(sessionId);
    }
  }

  // ============================================================================
  // Row → Metadata mapping
  // ============================================================================

  private toMetadata(row: CheckpointRow): CheckpointMetadata {
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      task: row.task,
      currentStep: row.current_step,
      totalSteps: row.total_steps ?? undefined,
      status: row.status as CheckpointMetadata["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: {
        messages: JSON.parse(row.messages) as Message[],
        toolHistory: JSON.parse(row.tool_history) as Array<{
          tool: string;
          args: unknown;
          result: string;
        }>,
        variables: JSON.parse(row.variables) as Record<string, unknown>,
      },
    };
  }
}
