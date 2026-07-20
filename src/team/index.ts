/**
 * Agent Team —— MoA (Mixture of Agents) 与多智能体协作框架
 *
 * 三种协作模式：
 * 1. Sequential Pipeline：顺序流水线，每个 agent 处理上一个的输出
 * 2. MoA Parallel：并行调用多个 agent，aggregator 聚合最佳答案
 * 3. Orchestrator-Worker：主控 agent 决定调用哪个 worker，根据结果决定是否继续
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 协作模式 */
export type TeamMode = "sequential" | "moa" | "orchestrator";

/** 团队成员 */
export interface TeamMember {
  /** 成员 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 使用哪个模型（覆盖默认） */
  model?: string;
  /** 使用哪个 provider */
  provider?: string;
  /** 角色：orchestrator / worker / aggregator */
  role: "orchestrator" | "worker" | "aggregator";
  /** worker 专长描述（用于 orchestrator 选择） */
  expertise?: string;
}

/** 团队配置 */
export interface TeamConfig {
  /** 模式 */
  mode: TeamMode;
  /** 成员列表 */
  members: TeamMember[];
  /** MoA 模式：aggregator 的提示词模板，默认 "请从以下回答中选择最准确的..." */
  aggregatorPrompt?: string;
  /** Orchestrator 模式：最大轮数，默认 5 */
  maxOrchestrationRounds?: number;
  /** 是否流式输出 */
  stream?: boolean;
}

/** 团队运行结果 */
export interface TeamRunResult {
  /** 最终输出 */
  output: string;
  /** 总轮数 */
  rounds: number;
  /** 每个成员的调用次数 */
  memberCalls: Record<string, number>;
  /** MoA 模式：所有候选答案 */
  candidates?: string[];
  /** 总 token 消耗 */
  totalTokens: number;
  /** 总耗时 ms */
  totalMs: number;
  /** 中间步骤（用于 trace） */
  steps: TeamStep[];
}

/** 团队执行步骤 */
export interface TeamStep {
  /** 步骤序号 */
  index: number;
  /** 执行成员 ID */
  memberId: string;
  /** 输入 */
  input: string;
  /** 输出 */
  output: string;
  /** 耗时 ms */
  ms: number;
  /** 角色 */
  role: TeamMember["role"];
}

/** Agent 工厂接口（解耦，由调用方提供 createAgent 实现） */
export interface AgentFactory {
  createAgent(opts: {
    systemPrompt?: string;
    model?: string;
    provider?: string;
  }): {
    run(input: string): Promise<{
      reply: string;
      rounds: number;
      toolCalls: number;
      contextTokens: number;
    }>;
  };
}

// ============================================================================
// 默认值
// ============================================================================

/** 默认 aggregator 提示词 */
const DEFAULT_AGGREGATOR_PROMPT =
  "请从以下多个回答中综合出最准确、完整的答案：\n\n";

/** 默认最大编排轮数 */
const DEFAULT_MAX_ORCHESTRATION_ROUNDS = 5;

// ============================================================================
// AgentTeam
// ============================================================================

export class AgentTeam {
  private readonly config: TeamConfig;
  private readonly factory: AgentFactory;

  constructor(config: TeamConfig, factory: AgentFactory) {
    this.config = config;
    this.factory = factory;
  }

  /** 运行任务 */
  async run(input: string, _sessionId?: string): Promise<TeamRunResult> {
    switch (this.config.mode) {
      case "sequential":
        return this.runSequential(input);
      case "moa":
        return this.runMoA(input);
      case "orchestrator":
        return this.runOrchestrator(input);
    }
  }

  /** 流式运行（yield 每一步） */
  async *stream(
    input: string,
    _sessionId?: string,
  ): AsyncGenerator<TeamStep | { type: "final"; result: TeamRunResult }> {
    switch (this.config.mode) {
      case "sequential":
        yield* this.streamSequential(input);
        break;
      case "moa":
        yield* this.streamMoA(input);
        break;
      case "orchestrator":
        yield* this.streamOrchestrator(input);
        break;
    }
  }

  // ==========================================================================
  // Sequential Pipeline
  // ==========================================================================

  /** 顺序流水线：每个 agent 处理上一个的输出 */
  private async runSequential(input: string): Promise<TeamRunResult> {
    let current = input;
    const steps: TeamStep[] = [];
    const memberCalls: Record<string, number> = {};
    const start = Date.now();

    for (const member of this.config.members) {
      const agent = this.factory.createAgent({
        systemPrompt: member.systemPrompt,
        model: member.model,
        provider: member.provider,
      });
      const t0 = Date.now();
      const result = await agent.run(current);
      const ms = Date.now() - t0;

      steps.push({
        index: steps.length,
        memberId: member.id,
        input: current,
        output: result.reply,
        ms,
        role: member.role,
      });
      memberCalls[member.id] = (memberCalls[member.id] ?? 0) + 1;
      current = result.reply;
    }

    return {
      output: current,
      rounds: steps.length,
      memberCalls,
      totalTokens: 0,
      totalMs: Date.now() - start,
      steps,
    };
  }

  /** 顺序流水线流式输出 */
  private async *streamSequential(
    input: string,
  ): AsyncGenerator<TeamStep | { type: "final"; result: TeamRunResult }> {
    let current = input;
    const steps: TeamStep[] = [];
    const memberCalls: Record<string, number> = {};
    const start = Date.now();

    for (const member of this.config.members) {
      const agent = this.factory.createAgent({
        systemPrompt: member.systemPrompt,
        model: member.model,
        provider: member.provider,
      });
      const t0 = Date.now();
      const result = await agent.run(current);
      const ms = Date.now() - t0;

      const step: TeamStep = {
        index: steps.length,
        memberId: member.id,
        input: current,
        output: result.reply,
        ms,
        role: member.role,
      };
      steps.push(step);
      memberCalls[member.id] = (memberCalls[member.id] ?? 0) + 1;
      current = result.reply;

      // yield 每一步
      yield step;
    }

    // yield 最终结果
    yield {
      type: "final",
      result: {
        output: current,
        rounds: steps.length,
        memberCalls,
        totalTokens: 0,
        totalMs: Date.now() - start,
        steps,
      },
    };
  }

  // ==========================================================================
  // MoA Parallel (Mixture of Agents)
  // ==========================================================================

  /** 并行调用多个 agent，aggregator 选最佳答案 */
  private async runMoA(input: string): Promise<TeamRunResult> {
    const workers = this.config.members.filter((m) => m.role === "worker");
    const aggregator = this.config.members.find(
      (m) => m.role === "aggregator",
    );

    const start = Date.now();

    // 并行调用所有 worker
    const workerSteps: TeamStep[] = await Promise.all(
      workers.map(async (member, idx) => {
        const agent = this.factory.createAgent({
          systemPrompt: member.systemPrompt,
          model: member.model,
          provider: member.provider,
        });
        const t0 = Date.now();
        const r = await agent.run(input);
        return {
          index: idx,
          memberId: member.id,
          input,
          output: r.reply,
          ms: Date.now() - t0,
          role: member.role,
        };
      }),
    );

    // 候选答案
    const candidates = workerSteps.map((r) => r.output);
    let finalOutput: string;
    const steps: TeamStep[] = [...workerSteps];

    if (aggregator) {
      // 用 aggregator 聚合
      const aggAgent = this.factory.createAgent({
        systemPrompt: aggregator.systemPrompt,
        model: aggregator.model,
        provider: aggregator.provider,
      });
      const aggPrompt =
        (this.config.aggregatorPrompt ?? DEFAULT_AGGREGATOR_PROMPT) +
        candidates
          .map((c, i) => `--- 候选 ${i + 1} ---\n${c}`)
          .join("\n\n");
      const at0 = Date.now();
      const aggResult = await aggAgent.run(aggPrompt);
      finalOutput = aggResult.reply;
      steps.push({
        index: steps.length,
        memberId: aggregator.id,
        input: aggPrompt,
        output: finalOutput,
        ms: Date.now() - at0,
        role: "aggregator",
      });
    } else {
      // 无 aggregator：选最长的回答作为最终结果
      finalOutput = candidates.reduce((a, b) => (a.length >= b.length ? a : b));
    }

    const memberCalls: Record<string, number> = {};
    for (const s of steps) {
      memberCalls[s.memberId] = (memberCalls[s.memberId] ?? 0) + 1;
    }

    return {
      output: finalOutput,
      rounds: 1,
      candidates,
      memberCalls,
      totalTokens: 0,
      totalMs: Date.now() - start,
      steps,
    };
  }

  /** MoA 流式输出：先 yield 所有 worker 结果，再 yield 聚合结果 */
  private async *streamMoA(
    input: string,
  ): AsyncGenerator<TeamStep | { type: "final"; result: TeamRunResult }> {
    const workers = this.config.members.filter((m) => m.role === "worker");
    const aggregator = this.config.members.find(
      (m) => m.role === "aggregator",
    );

    const start = Date.now();

    // 并行调用所有 worker，收集结果
    const workerResults = await Promise.all(
      workers.map(async (member, idx) => {
        const agent = this.factory.createAgent({
          systemPrompt: member.systemPrompt,
          model: member.model,
          provider: member.provider,
        });
        const t0 = Date.now();
        const r = await agent.run(input);
        return {
          index: idx,
          memberId: member.id,
          input,
          output: r.reply,
          ms: Date.now() - t0,
          role: member.role,
        };
      }),
    );

    // yield 每个 worker 步骤
    const steps: TeamStep[] = [];
    for (const ws of workerResults) {
      steps.push(ws);
      yield ws;
    }

    const candidates = workerResults.map((r) => r.output);
    let finalOutput: string;

    if (aggregator) {
      const aggAgent = this.factory.createAgent({
        systemPrompt: aggregator.systemPrompt,
        model: aggregator.model,
        provider: aggregator.provider,
      });
      const aggPrompt =
        (this.config.aggregatorPrompt ?? DEFAULT_AGGREGATOR_PROMPT) +
        candidates
          .map((c, i) => `--- 候选 ${i + 1} ---\n${c}`)
          .join("\n\n");
      const at0 = Date.now();
      const aggResult = await aggAgent.run(aggPrompt);
      finalOutput = aggResult.reply;
      const aggStep: TeamStep = {
        index: steps.length,
        memberId: aggregator.id,
        input: aggPrompt,
        output: finalOutput,
        ms: Date.now() - at0,
        role: "aggregator",
      };
      steps.push(aggStep);
      yield aggStep;
    } else {
      finalOutput = candidates.reduce((a, b) => (a.length >= b.length ? a : b));
    }

    const memberCalls: Record<string, number> = {};
    for (const s of steps) {
      memberCalls[s.memberId] = (memberCalls[s.memberId] ?? 0) + 1;
    }

    yield {
      type: "final",
      result: {
        output: finalOutput,
        rounds: 1,
        candidates,
        memberCalls,
        totalTokens: 0,
        totalMs: Date.now() - start,
        steps,
      },
    };
  }

  // ==========================================================================
  // Orchestrator-Worker
  // ==========================================================================

  /** 主控 agent 决定调用哪个 worker，根据结果决定是否继续 */
  private async runOrchestrator(input: string): Promise<TeamRunResult> {
    const orchestrator = this.config.members.find(
      (m) => m.role === "orchestrator",
    )!;
    const workers = this.config.members.filter((m) => m.role === "worker");

    // 构建 orchestrator 系统提示词
    const orchestratorSystemPrompt =
      orchestrator.systemPrompt ??
      `You are an orchestrator. Available workers:\n${workers.map((w) => `- ${w.id}: ${w.expertise ?? w.name}`).join("\n")}\n\nFor each step, respond with JSON: {"next_worker": "worker_id", "task": "specific task", "done": false}\nWhen the task is complete, respond: {"done": true, "answer": "final answer"}`;

    const orchestratorAgent = this.factory.createAgent({
      systemPrompt: orchestratorSystemPrompt,
      model: orchestrator.model,
      provider: orchestrator.provider,
    });

    const steps: TeamStep[] = [];
    let currentInput = input;
    const memberCalls: Record<string, number> = { [orchestrator.id]: 0 };
    for (const w of workers) memberCalls[w.id] = 0;

    const maxRounds =
      this.config.maxOrchestrationRounds ?? DEFAULT_MAX_ORCHESTRATION_ROUNDS;
    let finalOutput = "";

    for (let round = 0; round < maxRounds; round++) {
      // 调用 orchestrator 决策
      const t0 = Date.now();
      const orchResult = await orchestratorAgent.run(currentInput);
      const orchMs = Date.now() - t0;
      memberCalls[orchestrator.id]++;
      steps.push({
        index: steps.length,
        memberId: orchestrator.id,
        input: currentInput,
        output: orchResult.reply,
        ms: orchMs,
        role: "orchestrator",
      });

      // 解析 orchestrator 决策（从回复中提取 JSON）
      let decision: {
        next_worker?: string;
        task?: string;
        done?: boolean;
        answer?: string;
      };
      try {
        const jsonMatch = orchResult.reply.match(/\{[\s\S]*\}/);
        decision = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { done: true, answer: orchResult.reply };
      } catch {
        decision = { done: true, answer: orchResult.reply };
      }

      // 任务完成
      if (decision.done) {
        finalOutput = decision.answer ?? orchResult.reply;
        break;
      }

      // 调用 worker
      if (decision.next_worker) {
        const worker = workers.find((w) => w.id === decision.next_worker);
        if (worker) {
          const workerAgent = this.factory.createAgent({
            systemPrompt: worker.systemPrompt,
            model: worker.model,
            provider: worker.provider,
          });
          const wt0 = Date.now();
          const workerTask = decision.task ?? currentInput;
          const wResult = await workerAgent.run(workerTask);
          const wMs = Date.now() - wt0;
          memberCalls[worker.id]++;
          steps.push({
            index: steps.length,
            memberId: worker.id,
            input: workerTask,
            output: wResult.reply,
            ms: wMs,
            role: "worker",
          });

          // 将 worker 结果反馈给 orchestrator
          currentInput = `Worker ${worker.id} 的结果：\n${wResult.reply}\n\n原始任务：${input}\n\n请继续决策（调用下一个 worker 或给出最终答案）：`;
        }
      }
    }

    // 达到最大轮数仍未完成
    if (!finalOutput) {
      finalOutput = "达到最大轮数限制，未获得最终答案。";
    }

    return {
      output: finalOutput,
      rounds: steps.filter((s) => s.role === "orchestrator").length,
      memberCalls,
      totalTokens: 0,
      totalMs: steps.reduce((sum, s) => sum + s.ms, 0),
      steps,
    };
  }

  /** Orchestrator-Worker 流式输出 */
  private async *streamOrchestrator(
    input: string,
  ): AsyncGenerator<TeamStep | { type: "final"; result: TeamRunResult }> {
    const orchestrator = this.config.members.find(
      (m) => m.role === "orchestrator",
    )!;
    const workers = this.config.members.filter((m) => m.role === "worker");

    const orchestratorSystemPrompt =
      orchestrator.systemPrompt ??
      `You are an orchestrator. Available workers:\n${workers.map((w) => `- ${w.id}: ${w.expertise ?? w.name}`).join("\n")}\n\nFor each step, respond with JSON: {"next_worker": "worker_id", "task": "specific task", "done": false}\nWhen the task is complete, respond: {"done": true, "answer": "final answer"}`;

    const orchestratorAgent = this.factory.createAgent({
      systemPrompt: orchestratorSystemPrompt,
      model: orchestrator.model,
      provider: orchestrator.provider,
    });

    const steps: TeamStep[] = [];
    let currentInput = input;
    const memberCalls: Record<string, number> = { [orchestrator.id]: 0 };
    for (const w of workers) memberCalls[w.id] = 0;

    const maxRounds =
      this.config.maxOrchestrationRounds ?? DEFAULT_MAX_ORCHESTRATION_ROUNDS;
    let finalOutput = "";

    for (let round = 0; round < maxRounds; round++) {
      // 调用 orchestrator
      const t0 = Date.now();
      const orchResult = await orchestratorAgent.run(currentInput);
      const orchMs = Date.now() - t0;
      memberCalls[orchestrator.id]++;
      const orchStep: TeamStep = {
        index: steps.length,
        memberId: orchestrator.id,
        input: currentInput,
        output: orchResult.reply,
        ms: orchMs,
        role: "orchestrator",
      };
      steps.push(orchStep);
      yield orchStep;

      // 解析决策
      let decision: {
        next_worker?: string;
        task?: string;
        done?: boolean;
        answer?: string;
      };
      try {
        const jsonMatch = orchResult.reply.match(/\{[\s\S]*\}/);
        decision = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { done: true, answer: orchResult.reply };
      } catch {
        decision = { done: true, answer: orchResult.reply };
      }

      if (decision.done) {
        finalOutput = decision.answer ?? orchResult.reply;
        break;
      }

      if (decision.next_worker) {
        const worker = workers.find((w) => w.id === decision.next_worker);
        if (worker) {
          const workerAgent = this.factory.createAgent({
            systemPrompt: worker.systemPrompt,
            model: worker.model,
            provider: worker.provider,
          });
          const wt0 = Date.now();
          const workerTask = decision.task ?? currentInput;
          const wResult = await workerAgent.run(workerTask);
          const wMs = Date.now() - wt0;
          memberCalls[worker.id]++;
          const workerStep: TeamStep = {
            index: steps.length,
            memberId: worker.id,
            input: workerTask,
            output: wResult.reply,
            ms: wMs,
            role: "worker",
          };
          steps.push(workerStep);
          yield workerStep;

          currentInput = `Worker ${worker.id} 的结果：\n${wResult.reply}\n\n原始任务：${input}\n\n请继续决策（调用下一个 worker 或给出最终答案）：`;
        }
      }
    }

    if (!finalOutput) {
      finalOutput = "达到最大轮数限制，未获得最终答案。";
    }

    yield {
      type: "final",
      result: {
        output: finalOutput,
        rounds: steps.filter((s) => s.role === "orchestrator").length,
        memberCalls,
        totalTokens: 0,
        totalMs: steps.reduce((sum, s) => sum + s.ms, 0),
        steps,
      },
    };
  }
}
