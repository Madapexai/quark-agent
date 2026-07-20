/**
 * 自进化引擎（Dreaming）—— 从失败中学习，从成功中提炼
 *
 * 对标 Hermes v0.18 的 /learn 和 trace failure analysis：
 * - /learn：从成功任务中提炼隐性知识为显式 skill
 * - 自动分析：失败 trace 自动分析触发进化
 * - 进化执行：创建 skill / 修改 prompt / 添加工具规则 / 更新 sandbox
 * - 验证：检查进化效果是否通过
 */

import { createHash } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** 自进化配置 */
export interface DreamingConfig {
  /** 是否启用自动进化 */
  enabled: boolean;
  /** 触发进化的条件 */
  trigger: {
    /** 同一 fingerprint 失败次数阈值，默认 3 */
    sameFingerprintFailures: number;
    /** 重试成功率阈值（低于此触发），默认 0.3 */
    retrySuccessRate: number;
    /** 错误模式一致性阈值，默认 0.8 */
    errorPatternConsistency: number;
  };
  /** 进化策略 */
  strategy: "auto" | "manual" | "both";
  /** 最大进化深度（防止无限递归），默认 3 */
  maxDepth: number;
  /** 生成 skill 的存储路径 */
  skillOutputPath?: string;
}

/** Trace 条目（与 InMemoryTracer.export() 的 span 对齐） */
export interface TraceEntry {
  name: string;
  kind: string;
  status: string;
  error?: string;
  attributes?: Record<string, unknown>;
}

/** 进化记录 */
export interface EvolutionRecord {
  id: string;
  timestamp: number;
  /** 触发原因 */
  trigger: "failure_analysis" | "learn_command" | "pattern_detected" | "manual";
  /** 原始 trace 指纹 */
  fingerprint: string;
  /** 分析结果 */
  analysis: {
    /** 失败次数 */
    failureCount: number;
    /** 错误类型 */
    errorType: string;
    /** 错误模式 */
    errorPattern: string;
    /** 涉及的工具 */
    involvedTools: string[];
    /** 根因分析 */
    rootCause: string;
  };
  /** 进化动作 */
  action: {
    type: "create_skill" | "modify_prompt" | "add_tool_rule" | "update_sandbox";
    description: string;
    /** 生成的 skill/prompt 内容 */
    content: string;
    /** 修改的目标 */
    target?: string;
  };
  /** 验证结果 */
  verification?: {
    passed: boolean;
    score: number;
    feedback: string;
  };
}

/** 自动监视用的 Tracer 接口 */
export interface WatchableTracer {
  stats(): Record<string, { count: number; errors: number }>;
  export(): TraceEntry[];
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: DreamingConfig = {
  enabled: true,
  trigger: {
    sameFingerprintFailures: 3,
    retrySuccessRate: 0.3,
    errorPatternConsistency: 0.8,
  },
  strategy: "both",
  maxDepth: 3,
};

// ============================================================================
// DreamingEngine
// ============================================================================

export class DreamingEngine {
  private readonly config: DreamingConfig;
  private readonly history: EvolutionRecord[] = [];
  /** 指纹 → 失败次数 */
  private readonly failureIndex: Map<string, number> = new Map();
  /** 指纹 → 重试成功/总次数 */
  private readonly retryIndex: Map<string, { success: number; total: number }> =
    new Map();
  /** 指纹 → 错误模式 */
  private readonly errorPatternIndex: Map<string, Map<string, number>> =
    new Map();
  /** 自动监视定时器 */
  private autoWatchTimer: ReturnType<typeof setInterval> | null = null;
  private idCounter = 0;

  constructor(config: Partial<DreamingConfig> & { enabled: boolean }) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      trigger: { ...DEFAULT_CONFIG.trigger, ...config.trigger },
    };
  }

  // ==========================================================================
  // /learn 模式
  // ==========================================================================

  /** 从成功任务中提炼知识（手动触发） */
  async learn(
    sessionId: string,
    trace: TraceEntry[],
  ): Promise<EvolutionRecord> {
    // 1. 分析成功 trace 中的关键步骤
    const successfulSteps = trace.filter((t) => t.status === "ok");
    const failedSteps = trace.filter((t) => t.status === "error");

    // 2. 提取模式：哪些工具被使用、什么顺序、什么参数
    const toolSequence = successfulSteps
      .filter((t) => t.kind === "tool")
      .map((t) => t.name);
    const uniqueTools = [...new Set(toolSequence)];

    // 3. 从 attributes 中提取常见模式
    const patterns: string[] = [];
    for (const step of successfulSteps) {
      if (step.attributes) {
        const keys = Object.keys(step.attributes);
        if (keys.length > 0) {
          patterns.push(`${step.name}: ${keys.join(", ")}`);
        }
      }
    }

    // 4. 生成 skill 描述
    const timestamp = Date.now();
    const skillContent = JSON.stringify(
      {
        name: `auto-learn-${timestamp}`,
        description: `从会话 ${sessionId} 提炼的技能`,
        tools: uniqueTools,
        pattern: this.summarizePattern(toolSequence, patterns),
        triggers: this.inferTriggers(successfulSteps),
        sourceSession: sessionId,
        createdAt: timestamp,
      },
      null,
      2,
    );

    const fingerprint = this.computeFingerprint(trace);

    const record: EvolutionRecord = {
      id: this.genId(),
      timestamp,
      trigger: "learn_command",
      fingerprint,
      analysis: {
        failureCount: failedSteps.length,
        errorType: "none",
        errorPattern: "成功模式提炼",
        involvedTools: uniqueTools,
        rootCause: `从 ${successfulSteps.length} 个成功步骤中提炼模式，涉及工具: ${uniqueTools.join(", ")}`,
      },
      action: {
        type: "create_skill",
        description: `从会话 ${sessionId} 提炼的自动技能`,
        content: skillContent,
        target: this.config.skillOutputPath
          ? `${this.config.skillOutputPath}/auto-learn-${timestamp}.json`
          : undefined,
      },
    };

    // 执行进化动作
    await this.evolve(record);

    // 验证
    record.verification = await this.verify(record);

    this.history.push(record);
    return record;
  }

  // ==========================================================================
  // 自动分析
  // ==========================================================================

  /** 分析失败 trace */
  async analyzeFailure(
    fingerprint: string,
    traces: TraceEntry[],
  ): Promise<EvolutionRecord | null> {
    const failedTraces = traces.filter((t) => t.status === "error");
    if (failedTraces.length === 0) return null;

    // 更新失败计数
    const failureCount =
      (this.failureIndex.get(fingerprint) ?? 0) + failedTraces.length;
    this.failureIndex.set(fingerprint, failureCount);

    // 更新重试统计
    const retryStats = this.retryIndex.get(fingerprint) ?? {
      success: 0,
      total: 0,
    };
    retryStats.total += traces.length;
    retryStats.success += traces.filter((t) => t.status === "ok").length;
    this.retryIndex.set(fingerprint, retryStats);

    const retrySuccessRate =
      retryStats.total > 0 ? retryStats.success / retryStats.total : 0;

    // 分析错误模式
    const errorPatternMap = this.errorPatternIndex.get(fingerprint) ?? new Map();
    for (const t of failedTraces) {
      const errorType = t.error ?? "unknown";
      errorPatternMap.set(errorType, (errorPatternMap.get(errorType) ?? 0) + 1);
    }
    this.errorPatternIndex.set(fingerprint, errorPatternMap);

    // 计算错误模式一致性：最频繁错误占比
    const maxErrorCount = Math.max(...errorPatternMap.values(), 0);
    const errorPatternConsistency =
      failedTraces.length > 0 ? maxErrorCount / failedTraces.length : 0;

    // 检查触发条件
    const shouldTrigger =
      failureCount >= this.config.trigger.sameFingerprintFailures &&
      retrySuccessRate < this.config.trigger.retrySuccessRate &&
      errorPatternConsistency >= this.config.trigger.errorPatternConsistency;

    if (!shouldTrigger) return null;

    // 检查进化深度
    const existingEvolutions = this.history.filter(
      (r) => r.fingerprint === fingerprint,
    ).length;
    if (existingEvolutions >= this.config.maxDepth) return null;

    // 检查策略：仅 manual 模式不自动触发进化
    if (this.config.strategy === "manual") {
      return null;
    }

    // 找最频繁的错误类型
    const topError = [...errorPatternMap.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    const errorType = topError?.[0] ?? "unknown";
    const errorPattern = topError
      ? `"${topError[0]}" 出现 ${topError[1]} 次`
      : "未知错误模式";

    // 涉及的工具
    const involvedTools = [
      ...new Set(
        failedTraces
          .filter((t) => t.kind === "tool")
          .map((t) => t.name),
      ),
    ];

    // 根因分析（简化版：基于错误类型和涉及工具推断）
    const rootCause = this.inferRootCause(errorType, involvedTools);

    // 决定进化动作类型
    const actionType = this.decideActionType(errorType, involvedTools);

    // 生成进化建议
    const timestamp = Date.now();
    const actionContent = this.generateActionContent(
      actionType,
      errorType,
      involvedTools,
      rootCause,
      fingerprint,
      timestamp,
    );

    const record: EvolutionRecord = {
      id: this.genId(),
      timestamp,
      trigger: "failure_analysis",
      fingerprint,
      analysis: {
        failureCount,
        errorType,
        errorPattern,
        involvedTools,
        rootCause,
      },
      action: {
        type: actionType,
        description: `针对指纹 ${fingerprint} 的错误 "${errorType}" 的自动修复`,
        content: actionContent,
        target: this.getTargetForAction(actionType, timestamp),
      },
    };

    // 执行进化
    await this.evolve(record);

    // 验证
    record.verification = await this.verify(record);

    this.history.push(record);
    return record;
  }

  /** 计算指纹（对 trace 做结构化 hash） */
  computeFingerprint(trace: Array<{ name: string; kind: string }>): string {
    // 提取结构化特征并排序，保证确定性
    const structured = trace
      .map((t) => ({ name: t.name, kind: t.kind }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return createHash("sha256")
      .update(JSON.stringify(structured))
      .digest("hex")
      .slice(0, 16);
  }

  // ==========================================================================
  // 进化执行
  // ==========================================================================

  /** 执行进化动作（创建 skill / 修改 prompt 等） */
  async evolve(record: EvolutionRecord): Promise<{ success: boolean; error?: string }> {
    try {
      switch (record.action.type) {
        case "create_skill":
          return this.evolveCreateSkill(record);
        case "modify_prompt":
          return this.evolveModifyPrompt(record);
        case "add_tool_rule":
          return this.evolveAddToolRule(record);
        case "update_sandbox":
          return this.evolveUpdateSandbox(record);
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 验证进化效果 */
  async verify(
    record: EvolutionRecord,
  ): Promise<{ passed: boolean; score: number; feedback: string }> {
    // 简化版验证：检查 skill 文件是否存在 + JSON 语法正确
    switch (record.action.type) {
      case "create_skill": {
        const target = record.action.target;
        if (!target) {
          return { passed: true, score: 0.7, feedback: "无目标路径，默认通过" };
        }
        if (!existsSync(target)) {
          return { passed: false, score: 0, feedback: `skill 文件不存在: ${target}` };
        }
        try {
          const content = readFileSync(target, "utf-8");
          JSON.parse(content);
          return { passed: true, score: 1.0, feedback: "skill 文件存在且 JSON 语法正确" };
        } catch (e) {
          return {
            passed: false,
            score: 0.3,
            feedback: `JSON 语法错误: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      case "modify_prompt": {
        const target = record.action.target ?? ".quark-agent.json";
        if (!existsSync(target)) {
          return { passed: false, score: 0, feedback: `配置文件不存在: ${target}` };
        }
        try {
          const content = readFileSync(target, "utf-8");
          JSON.parse(content);
          return { passed: true, score: 0.9, feedback: "配置文件 JSON 语法正确" };
        } catch (e) {
          return {
            passed: false,
            score: 0.2,
            feedback: `JSON 语法错误: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      case "add_tool_rule":
      case "update_sandbox": {
        // 工具规则和 sandbox 更新暂无法自动验证
        return { passed: true, score: 0.8, feedback: "规则更新已写入，需人工确认" };
      }
    }
  }

  // ==========================================================================
  // 记录管理
  // ==========================================================================

  /** 获取进化历史 */
  getHistory(limit?: number): EvolutionRecord[] {
    const sorted = [...this.history].sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** 获取进化统计 */
  getStats(): {
    totalEvolutions: number;
    byTriggerType: Record<string, number>;
    successRate: number;
    topErrorTypes: Array<{ type: string; count: number }>;
  } {
    const totalEvolutions = this.history.length;

    // 按触发类型统计
    const byTriggerType: Record<string, number> = {};
    for (const r of this.history) {
      byTriggerType[r.trigger] = (byTriggerType[r.trigger] ?? 0) + 1;
    }

    // 成功率
    const verifiedRecords = this.history.filter((r) => r.verification);
    const successCount = verifiedRecords.filter(
      (r) => r.verification!.passed,
    ).length;
    const successRate =
      verifiedRecords.length > 0 ? successCount / verifiedRecords.length : 0;

    // 错误类型统计
    const errorTypeCounts: Record<string, number> = {};
    for (const r of this.history) {
      const t = r.analysis.errorType;
      errorTypeCounts[t] = (errorTypeCounts[t] ?? 0) + 1;
    }
    const topErrorTypes = Object.entries(errorTypeCounts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { totalEvolutions, byTriggerType, successRate, topErrorTypes };
  }

  // ==========================================================================
  // 自动监视
  // ==========================================================================

  /** 启动自动监视（定期扫描 tracer 的失败 span） */
  startAutoWatch(tracer: WatchableTracer): void {
    if (this.autoWatchTimer) return; // 已在监视中
    if (!this.config.enabled) return;

    this.autoWatchTimer = setInterval(() => {
      this.performAutoWatchScan(tracer);
    }, 60_000); // 每 60 秒扫描一次
  }

  /** 停止自动监视 */
  stopAutoWatch(): void {
    if (this.autoWatchTimer) {
      clearInterval(this.autoWatchTimer);
      this.autoWatchTimer = null;
    }
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /** 生成唯一 ID */
  private genId(): string {
    this.idCounter = (this.idCounter + 1) % 0x10000;
    const hash = createHash("sha256")
      .update(`dream-${Date.now()}-${this.idCounter}-${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
    return hash;
  }

  /** 从工具序列和属性模式生成摘要描述 */
  private summarizePattern(
    toolSequence: string[],
    patterns: string[],
  ): string {
    if (toolSequence.length === 0 && patterns.length === 0) {
      return "无明显模式";
    }
    const parts: string[] = [];
    if (toolSequence.length > 0) {
      parts.push(`工具调用顺序: ${toolSequence.join(" → ")}`);
    }
    if (patterns.length > 0) {
      parts.push(`属性模式: ${patterns.slice(0, 3).join("; ")}`);
    }
    return parts.join("；");
  }

  /** 从成功步骤推断触发词 */
  private inferTriggers(
    steps: TraceEntry[],
  ): string[] {
    const triggers: Set<string> = new Set();
    for (const step of steps) {
      // 根据工具名推断触发词
      if (step.name.includes("read") || step.name.includes("Read")) {
        triggers.add("读取文件");
      }
      if (step.name.includes("write") || step.name.includes("Write")) {
        triggers.add("写入文件");
        triggers.add("创建文件");
      }
      if (step.name.includes("search") || step.name.includes("Search")) {
        triggers.add("搜索");
      }
      if (step.name.includes("exec") || step.name.includes("Exec")) {
        triggers.add("执行命令");
      }
    }
    return [...triggers];
  }

  /** 推断根因（基于错误类型和涉及工具） */
  private inferRootCause(
    errorType: string,
    involvedTools: string[],
  ): string {
    // 常见错误模式映射
    if (errorType.includes("timeout") || errorType.includes("Timeout")) {
      return `工具 ${involvedTools.join(", ")} 执行超时，可能需要调整超时参数或优化调用方式`;
    }
    if (
      errorType.includes("permission") ||
      errorType.includes("Permission") ||
      errorType.includes("EACCES")
    ) {
      return `工具 ${involvedTools.join(", ")} 权限不足，需要调整 sandbox 策略或文件权限`;
    }
    if (errorType.includes("not found") || errorType.includes("ENOENT")) {
      return `工具 ${involvedTools.join(", ")} 找不到目标，可能需要添加路径检查步骤`;
    }
    if (
      errorType.includes("syntax") ||
      errorType.includes("SyntaxError")
    ) {
      return `工具 ${involvedTools.join(", ")} 输出语法错误，可能需要调整 prompt 或添加格式校验`;
    }
    if (errorType.includes("rate") || errorType.includes("429")) {
      return `工具 ${involvedTools.join(", ")} 触发限流，需要添加重试策略或降低请求频率`;
    }
    return `工具 ${involvedTools.join(", ")} 出现 "${errorType}" 错误，建议检查调用参数和前置条件`;
  }

  /** 根据错误类型和涉及工具决定进化动作类型 */
  private decideActionType(
    errorType: string,
    involvedTools: string[],
  ): EvolutionRecord["action"]["type"] {
    // 权限类错误 → 更新 sandbox
    if (
      errorType.includes("permission") ||
      errorType.includes("EACCES")
    ) {
      return "update_sandbox";
    }
    // 限流类错误 → 添加工具规则
    if (errorType.includes("rate") || errorType.includes("429")) {
      return "add_tool_rule";
    }
    // 语法/格式错误 → 修改 prompt
    if (
      errorType.includes("syntax") ||
      errorType.includes("format")
    ) {
      return "modify_prompt";
    }
    // 其他 → 创建 skill（默认进化方式）
    if (involvedTools.length > 0) {
      return "create_skill";
    }
    return "modify_prompt";
  }

  /** 生成进化动作内容 */
  private generateActionContent(
    actionType: EvolutionRecord["action"]["type"],
    errorType: string,
    involvedTools: string[],
    rootCause: string,
    fingerprint: string,
    timestamp: number,
  ): string {
    switch (actionType) {
      case "create_skill":
        return JSON.stringify(
          {
            name: `auto-fix-${timestamp}`,
            description: `针对指纹 ${fingerprint} 的 "${errorType}" 错误的自动修复技能`,
            tools: involvedTools,
            pattern: rootCause,
            triggers: [`修复 ${errorType}`],
            createdAt: timestamp,
          },
          null,
          2,
        );
      case "modify_prompt":
        return JSON.stringify(
          {
            type: "prompt_patch",
            description: rootCause,
            additions: [
              `当使用 ${involvedTools.join(", ")} 时，注意: ${rootCause}`,
            ],
            createdAt: timestamp,
          },
          null,
          2,
        );
      case "add_tool_rule":
        return JSON.stringify(
          {
            type: "tool_rule",
            description: rootCause,
            rules: involvedTools.map((t) => ({
              tool: t,
              constraint: `针对 ${errorType} 的保护规则`,
            })),
            createdAt: timestamp,
          },
          null,
          2,
        );
      case "update_sandbox":
        return JSON.stringify(
          {
            type: "sandbox_update",
            description: rootCause,
            permissions: involvedTools.map((t) => ({
              tool: t,
              allow: true,
              reason: `允许 ${t} 以修复 ${errorType}`,
            })),
            createdAt: timestamp,
          },
          null,
          2,
        );
    }
  }

  /** 获取动作的目标路径 */
  private getTargetForAction(
    actionType: EvolutionRecord["action"]["type"],
    timestamp: number,
  ): string | undefined {
    if (!this.config.skillOutputPath) return undefined;
    switch (actionType) {
      case "create_skill":
        return `${this.config.skillOutputPath}/auto-fix-${timestamp}.json`;
      case "modify_prompt":
        return ".quark-agent.json";
      case "add_tool_rule":
        return `${this.config.skillOutputPath}/tool-rules-${timestamp}.json`;
      case "update_sandbox":
        return `${this.config.skillOutputPath}/sandbox-update-${timestamp}.json`;
    }
  }

  /** 进化动作：创建 skill 文件 */
  private evolveCreateSkill(
    record: EvolutionRecord,
  ): { success: boolean; error?: string } {
    const target = record.action.target;
    if (!target) return { success: true }; // 无目标路径，视为成功

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, record.action.content, "utf-8");
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 进化动作：修改 prompt */
  private evolveModifyPrompt(
    record: EvolutionRecord,
  ): { success: boolean; error?: string } {
    const target = record.action.target ?? ".quark-agent.json";

    try {
      // 读取现有配置（如果存在）
      let config: Record<string, unknown> = {};
      if (existsSync(target)) {
        config = JSON.parse(readFileSync(target, "utf-8"));
      }

      // 追加 prompt 补丁
      const existingPrompt = (config.systemPrompt as string) ?? "";
      const patch = JSON.parse(record.action.content);
      const additions = patch.additions ?? [];
      config.systemPrompt =
        existingPrompt +
        (existingPrompt ? "\n\n" : "") +
        additions.join("\n");

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(config, null, 2), "utf-8");
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 进化动作：添加工具规则 */
  private evolveAddToolRule(
    record: EvolutionRecord,
  ): { success: boolean; error?: string } {
    const target = record.action.target;
    if (!target) return { success: true };

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, record.action.content, "utf-8");
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 进化动作：更新 sandbox 策略 */
  private evolveUpdateSandbox(
    record: EvolutionRecord,
  ): { success: boolean; error?: string } {
    const target = record.action.target;
    if (!target) return { success: true };

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, record.action.content, "utf-8");
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 自动监视扫描：检查 tracer 中的失败 span 并触发进化 */
  private async performAutoWatchScan(tracer: WatchableTracer): Promise<void> {
    const spans = tracer.export();
    const failedSpans = spans.filter((s) => s.status === "error");
    if (failedSpans.length === 0) return;

    // 按 fingerprint 分组
    const groups: Map<string, TraceEntry[]> = new Map();
    for (const span of failedSpans) {
      const fp = this.computeFingerprint([{ name: span.name, kind: span.kind }]);
      const group = groups.get(fp) ?? [];
      group.push(span);
      groups.set(fp, group);
    }

    // 对每个分组尝试触发分析
    for (const [fingerprint, traces] of groups) {
      try {
        await this.analyzeFailure(fingerprint, traces);
      } catch {
        // 自动分析失败不影响后续扫描
      }
    }
  }
}
