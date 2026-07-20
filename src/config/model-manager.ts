/**
 * 后端模型配置管理 —— 动态切换模型、热加载配置、多模型并行对比
 *
 * 功能：
 * - 配置存储在 .quark-models.json
 * - 切换 active 时同步写入 .quark-agent.json 的 apiKey/baseURL/model
 * - watch 用 fs.watch 监视文件变化，自动重载
 * - recordUsage 更新内存 + 持久化
 * - recommendFromCatalog 调用 PROVIDER_CATALOG 的排序函数
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { PROVIDER_CATALOG, recommendByPrice, recommendByQuality } from "../provider/catalog.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface ModelConfig {
  /** 配置 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** provider ID（对应 catalog） */
  providerId: string;
  /** 模型 ID */
  modelId: string;
  /** API key（加密存储） */
  apiKey?: string;
  /** Base URL */
  baseURL?: string;
  /** 模型参数 */
  parameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    contextTokenBudget?: number;
  };
  /** 是否为当前激活配置 */
  active: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最后使用时间 */
  lastUsedAt?: number;
  /** 使用统计 */
  stats: {
    totalRequests: number;
    totalTokens: number;
    totalCost: number;
    avgLatencyMs: number;
    errorRate: number;
  };
}

// ============================================================================
// 持久化结构
// ============================================================================

interface ModelStore {
  configs: ModelConfig[];
}

// ============================================================================
// ModelManager 实现
// ============================================================================

export class ModelManager {
  private readonly configPath: string;
  private store: ModelStore;
  /** fs.watch 返回的 watcher */
  private watcher?: ReturnType<typeof watch>;
  /** 文件变更回调 */
  private watchCallback?: (configs: ModelConfig[]) => void;

  constructor(configPath?: string) {
    this.configPath = configPath ?? join(process.cwd(), ".quark-models.json");
    this.store = this.loadStore();
  }

  // --------------------------------------------------------------------------
  // 列出所有配置
  // --------------------------------------------------------------------------

  list(): ModelConfig[] {
    return [...this.store.configs];
  }

  // --------------------------------------------------------------------------
  // 获取当前激活配置
  // --------------------------------------------------------------------------

  getActive(): ModelConfig {
    const active = this.store.configs.find((c) => c.active);
    if (!active) {
      throw new Error("没有激活的模型配置，请先调用 setActive 指定一个");
    }
    return active;
  }

  // --------------------------------------------------------------------------
  // 切换激活配置
  // --------------------------------------------------------------------------

  setActive(id: string): ModelConfig {
    const target = this.store.configs.find((c) => c.id === id);
    if (!target) {
      throw new Error(`模型配置不存在: ${id}`);
    }

    // 取消其他配置的 active 状态
    for (const c of this.store.configs) {
      c.active = c.id === id;
    }

    // 同步写入 .quark-agent.json 的 apiKey/baseURL/model
    this.syncToAgentConfig(target);

    this.saveStore();
    return target;
  }

  // --------------------------------------------------------------------------
  // 添加配置
  // --------------------------------------------------------------------------

  add(
    config: Omit<ModelConfig, "id" | "createdAt" | "stats" | "active">,
  ): ModelConfig {
    const id = crypto.randomUUID();
    const now = Date.now();

    const entry: ModelConfig = {
      ...config,
      id,
      createdAt: now,
      stats: {
        totalRequests: 0,
        totalTokens: 0,
        totalCost: 0,
        avgLatencyMs: 0,
        errorRate: 0,
      },
      active: false,
    };

    // 如果是第一个配置，自动设为 active
    if (this.store.configs.length === 0) {
      entry.active = true;
    }

    this.store.configs.push(entry);
    this.saveStore();
    return entry;
  }

  // --------------------------------------------------------------------------
  // 更新配置
  // --------------------------------------------------------------------------

  update(id: string, update: Partial<ModelConfig>): ModelConfig {
    const idx = this.store.configs.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error(`模型配置不存在: ${id}`);
    }

    // 合并更新（不覆盖 id 和 createdAt）
    const existing = this.store.configs[idx]!;
    const merged: ModelConfig = {
      ...existing,
      ...update,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.store.configs[idx] = merged;

    // 如果更新了 active 为 true，需要取消其他配置的 active
    if (update.active === true) {
      for (const c of this.store.configs) {
        if (c.id !== id) c.active = false;
      }
      this.syncToAgentConfig(merged);
    }

    this.saveStore();
    return merged;
  }

  // --------------------------------------------------------------------------
  // 删除配置
  // --------------------------------------------------------------------------

  remove(id: string): boolean {
    const idx = this.store.configs.findIndex((c) => c.id === id);
    if (idx === -1) return false;

    this.store.configs.splice(idx, 1);
    this.saveStore();
    return true;
  }

  // --------------------------------------------------------------------------
  // 从 catalog 推荐
  // --------------------------------------------------------------------------

  recommendFromCatalog(mode: "price" | "efficient"): ModelConfig[] {
    const recommendations =
      mode === "price" ? recommendByPrice() : recommendByQuality();

    return recommendations.map((rec) => {
      // 从 catalog 查找 provider 和 model 详情
      const provider = PROVIDER_CATALOG.find((p) => p.id === rec.providerId);
      const modelInfo = provider?.models.find((m) => m.id === rec.modelId);

      return {
        id: `rec-${rec.providerId}-${rec.modelId}`,
        name: `${provider?.name ?? rec.providerId} / ${modelInfo?.name ?? rec.modelId}`,
        providerId: rec.providerId,
        modelId: rec.modelId,
        baseURL: provider?.defaultBase,
        parameters: {
          contextTokenBudget: modelInfo?.contextWindow,
        },
        active: false,
        createdAt: Date.now(),
        stats: {
          totalRequests: 0,
          totalTokens: 0,
          totalCost: 0,
          avgLatencyMs: 0,
          errorRate: 0,
        },
      };
    });
  }

  // --------------------------------------------------------------------------
  // 探测配置是否可用
  // --------------------------------------------------------------------------

  async probe(
    id: string,
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const config = this.store.configs.find((c) => c.id === id);
    if (!config) {
      return { ok: false, latencyMs: 0, error: `配置不存在: ${id}` };
    }

    const baseURL = config.baseURL ?? "https://api.openai.com/v1";
    const start = Date.now();

    try {
      // 发送最简单的 chat 请求来探测连通性
      const resp = await fetch(`${baseURL}/models`, {
        method: "GET",
        headers: config.apiKey
          ? { Authorization: `Bearer ${config.apiKey}` }
          : {},
        signal: AbortSignal.timeout(10000), // 10s 超时
      });
      const latencyMs = Date.now() - start;

      if (resp.ok) {
        return { ok: true, latencyMs };
      } else {
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${resp.status}: ${resp.statusText}`,
        };
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      return {
        ok: false,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --------------------------------------------------------------------------
  // 记录使用（更新 stats）
  // --------------------------------------------------------------------------

  recordUsage(
    id: string,
    tokens: number,
    cost: number,
    latencyMs: number,
    error?: boolean,
  ): void {
    const config = this.store.configs.find((c) => c.id === id);
    if (!config) return;

    const s = config.stats;
    const n = s.totalRequests + 1;

    // 加权平均延迟
    s.avgLatencyMs = Math.round(
      (s.avgLatencyMs * s.totalRequests + latencyMs) / n,
    );

    // 加权平均错误率
    const prevErrors = s.errorRate * s.totalRequests;
    s.errorRate = (prevErrors + (error ? 1 : 0)) / n;

    s.totalRequests = n;
    s.totalTokens += tokens;
    s.totalCost += cost;
    config.lastUsedAt = Date.now();

    this.saveStore();
  }

  // --------------------------------------------------------------------------
  // 热加载：监视配置文件变化，自动重载
  // --------------------------------------------------------------------------

  watch(callback: (configs: ModelConfig[]) => void): () => void {
    this.watchCallback = callback;

    // 使用 fs.watch 监视文件变化
    this.watcher = watch(this.configPath, () => {
      try {
        this.store = this.loadStore();
        if (this.watchCallback) {
          this.watchCallback([...this.store.configs]);
        }
      } catch {
        // 文件读取失败（可能在写入中间状态），忽略
      }
    });

    // 返回 unwatch 函数
    return () => {
      if (this.watcher) {
        this.watcher.close();
        this.watcher = undefined;
      }
      this.watchCallback = undefined;
    };
  }

  // --------------------------------------------------------------------------
  // 对比两个配置
  // --------------------------------------------------------------------------

  compare(
    idA: string,
    idB: string,
  ): {
    a: ModelConfig;
    b: ModelConfig;
    diff: Record<string, { a: unknown; b: unknown }>;
  } {
    const a = this.store.configs.find((c) => c.id === idA);
    const b = this.store.configs.find((c) => c.id === idB);

    if (!a) throw new Error(`配置不存在: ${idA}`);
    if (!b) throw new Error(`配置不存在: ${idB}`);

    // 递归比较所有字段，收集差异
    const diff: Record<string, { a: unknown; b: unknown }> = {};
    this.collectDiff(a, b, "", diff);

    return { a, b, diff };
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /** 从文件加载 store */
  private loadStore(): ModelStore {
    if (!existsSync(this.configPath)) {
      return { configs: [] };
    }
    try {
      const raw = readFileSync(this.configPath, "utf8");
      return JSON.parse(raw) as ModelStore;
    } catch {
      return { configs: [] };
    }
  }

  /** 持久化 store 到文件 */
  private saveStore(): void {
    try {
      writeFileSync(
        this.configPath,
        JSON.stringify(this.store, null, 2) + "\n",
        "utf8",
      );
    } catch {
      // 持久化失败不中断主流程
    }
  }

  /** 切换 active 时同步写入 .quark-agent.json */
  private syncToAgentConfig(model: ModelConfig): void {
    const agentConfigPath = join(process.cwd(), ".quark-agent.json");
    if (!existsSync(agentConfigPath)) return;

    try {
      const raw = readFileSync(agentConfigPath, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;

      // 更新主配置的 apiKey / baseURL / model
      if (model.apiKey) cfg.apiKey = model.apiKey;
      if (model.baseURL) cfg.baseURL = model.baseURL;
      cfg.model = model.modelId;

      writeFileSync(agentConfigPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    } catch {
      // 同步失败不中断
    }
  }

  /** 递归收集两个对象的字段差异 */
  private collectDiff(
    a: unknown,
    b: unknown,
    prefix: string,
    diff: Record<string, { a: unknown; b: unknown }>,
  ): void {
    if (a === b) return;

    // 其中一个不是对象，或其中一个是 null/数组，直接比较
    if (
      typeof a !== "object" ||
      typeof b !== "object" ||
      a === null ||
      b === null ||
      Array.isArray(a) ||
      Array.isArray(b)
    ) {
      if (a !== b) {
        diff[prefix] = { a, b };
      }
      return;
    }

    // 递归比较所有键
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const valA = objA[key];
      const valB = objB[key];

      if (valA === undefined && valB === undefined) continue;

      if (
        typeof valA === "object" &&
        typeof valB === "object" &&
        valA !== null &&
        valB !== null &&
        !Array.isArray(valA) &&
        !Array.isArray(valB)
      ) {
        this.collectDiff(valA, valB, path, diff);
      } else if (valA !== valB) {
        diff[path] = { a: valA, b: valB };
      }
    }
  }
}
