/**
 * LLM Provider 目录数据库
 *
 * 汇总主流 LLM 提供方与模型的元信息（价格、上下文窗口、质量评分、能力标签），
 * 供路由器、推荐器和 CLI 列表展示使用。
 *
 * 设计原则：
 * - 零 npm 依赖，纯数据 + 纯函数
 * - 价格统一为 USD per 1M tokens，免费模型为 0
 * - qualityScore 基于 2026 年 7 月公开 benchmark（MMLU / HumanEval / GAIA 等）相对打分
 * - 注释全部用中文
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 模型档次：免费 / 廉价 / 标准 / 高端 / 顶级 */
export type ProviderTier = "free" | "cheap" | "standard" | "premium" | "sota";

export interface ModelInfo {
  /** 模型名（API 调用用的 ID） */
  id: string;
  /** 显示名 */
  name: string;
  /** 输入价格 USD / 1M tokens，0 表示免费 */
  inputPrice: number;
  /** 输出价格 USD / 1M tokens，0 表示免费 */
  outputPrice: number;
  /** 上下文窗口 tokens */
  contextWindow: number;
  /** 模型档次 */
  tier: ProviderTier;
  /** 评级分数 0-100，用于 "efficient" 排序（基于公开 benchmark） */
  qualityScore: number;
  /** 是否支持 vision */
  vision?: boolean;
  /** 是否支持 function calling / tools */
  tools?: boolean;
  /** 备注（如 "free tier" / "coding plan $10/mo"） */
  note?: string;
}

export interface ProviderEntry {
  /** Provider 唯一标识 */
  id: string;
  /** 显示名 */
  name: string;
  /** 环境变量名（用于 API key） */
  envKey: string;
  /** OpenAI 兼容端点 */
  defaultBase: string;
  /** 是否本地运行（无需 API key） */
  local?: boolean;
  /** Provider 官网 */
  website?: string;
  /** 注册地址（获取 API key） */
  signupUrl?: string;
  /** Provider 整体描述 */
  description?: string;
  /** 该 provider 支持的模型列表 */
  models: ModelInfo[];
}

export type SortMode = "price" | "efficient";

// ============================================================================
// 完整目录数据
// ============================================================================

export const PROVIDER_CATALOG: ProviderEntry[] = [
  // --------------------------------------------------------------------------
  // 1. GLM / 智谱 AI（国内，有免费档）
  // --------------------------------------------------------------------------
  {
    id: "zhipu",
    name: "GLM / ZhipuAI",
    envKey: "ZHIPUAI_API_KEY",
    defaultBase: "https://open.bigmodel.cn/api/paas/v4",
    website: "https://open.bigmodel.cn/",
    signupUrl: "https://open.bigmodel.cn/",
    description: "清华系国产大模型，GLM-5 开源 SOTA 接近 Claude Opus 4.6，flash 版永久免费",
    models: [
      {
        id: "glm-4-flash",
        name: "GLM-4-Flash",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 128_000,
        tier: "free",
        qualityScore: 65,
        vision: true,
        tools: true,
        note: "免费档，适合原型与轻量任务",
      },
      {
        id: "glm-4.5",
        name: "GLM-4.5",
        inputPrice: 0.5,
        outputPrice: 1.5,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 78,
        vision: true,
        tools: true,
      },
      {
        id: "glm-5",
        name: "GLM-5",
        inputPrice: 1.0,
        outputPrice: 2.0,
        contextWindow: 200_000,
        tier: "sota",
        qualityScore: 92,
        vision: true,
        tools: true,
        note: "开源 SOTA，综合能力接近 Claude Opus 4.6",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 2. Agnes AI
  // --------------------------------------------------------------------------
  {
    id: "agnes",
    name: "Agnes AI",
    envKey: "AGNES_API_KEY",
    defaultBase: "https://api.agnes-ai.com/v1",
    website: "https://wiki.agnes-ai.com/",
    signupUrl: "https://wiki.agnes-ai.com/",
    description: "新兴国产厂商，提供免费 flash 模型",
    models: [
      {
        id: "agnes-2.0-flash",
        name: "Agnes 2.0 Flash",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 64_000,
        tier: "free",
        qualityScore: 60,
        tools: true,
        note: "免费档",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 3. DeepSeek
  // --------------------------------------------------------------------------
  {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    defaultBase: "https://api.deepseek.com/v1",
    website: "https://deepseek.com/",
    signupUrl: "https://platform.deepseek.com/",
    description: "深度求索，V4 Pro 永久降价后性价比极高，R1 推理强",
    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat (V3)",
        inputPrice: 0.27,
        outputPrice: 1.1,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 80,
        tools: true,
      },
      {
        id: "deepseek-r1",
        name: "DeepSeek R1",
        inputPrice: 0.55,
        outputPrice: 2.19,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 88,
        tools: true,
        note: "推理模型，数学/代码强",
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        inputPrice: 0.435,
        outputPrice: 0.87,
        contextWindow: 256_000,
        tier: "cheap",
        qualityScore: 91,
        vision: true,
        tools: true,
        note: "永久降价，性价比之王",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 4. Volcengine Ark（字节跳动豆包）
  // --------------------------------------------------------------------------
  {
    id: "volcengine",
    name: "Volcengine Ark",
    envKey: "ARK_API_KEY",
    defaultBase: "https://ark.cn-beijing.volces.com/api/v3",
    website: "https://www.volcengine.com/product/ark",
    signupUrl: "https://www.volcengine.com/product/ark",
    description: "字节跳动豆包系列，coding plan 包月约 $10",
    models: [
      {
        id: "doubao-seed-code",
        name: "Doubao Seed Code",
        inputPrice: 0.15,
        outputPrice: 0.4,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 85,
        tools: true,
        note: "coding plan 包月约 $10/mo，等效预估价",
      },
      {
        id: "doubao-1.5-pro",
        name: "Doubao 1.5 Pro",
        inputPrice: 0.8,
        outputPrice: 2.0,
        contextWindow: 256_000,
        tier: "cheap",
        qualityScore: 86,
        vision: true,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 5. Kimi (Moonshot AI)
  // --------------------------------------------------------------------------
  {
    id: "moonshot",
    name: "Kimi (Moonshot)",
    envKey: "MOONSHOT_API_KEY",
    defaultBase: "https://api.moonshot.cn/v1",
    website: "https://platform.moonshot.cn/",
    signupUrl: "https://platform.moonshot.cn/",
    description: "月之暗面，超长上下文，K2.6 综合能力强",
    models: [
      {
        id: "moonshot-v1-8k",
        name: "Moonshot V1 8K",
        inputPrice: 1.2,
        outputPrice: 1.2,
        contextWindow: 8_000,
        tier: "cheap",
        qualityScore: 75,
        tools: true,
      },
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        inputPrice: 0.55,
        outputPrice: 2.19,
        contextWindow: 256_000,
        tier: "cheap",
        qualityScore: 89,
        vision: true,
        tools: true,
        note: "新一代旗舰，长文档处理强",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 6. Qwen / 阿里云通义
  // --------------------------------------------------------------------------
  {
    id: "qwen",
    name: "Qwen / Aliyun",
    envKey: "DASHSCOPE_API_KEY",
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    website: "https://dashscope.aliyun.com/",
    signupUrl: "https://dashscope.aliyun.com/",
    description: "阿里通义千问系列，Qwen3-Max 进入 SOTA 梯队",
    models: [
      {
        id: "qwen-turbo",
        name: "Qwen Turbo",
        inputPrice: 0.05,
        outputPrice: 0.2,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 72,
        tools: true,
      },
      {
        id: "qwen-max",
        name: "Qwen Max",
        inputPrice: 2.5,
        outputPrice: 10,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 88,
        vision: true,
        tools: true,
      },
      {
        id: "qwen3-max",
        name: "Qwen3 Max",
        inputPrice: 3.0,
        outputPrice: 12,
        contextWindow: 256_000,
        tier: "sota",
        qualityScore: 91,
        vision: true,
        tools: true,
        note: "新一代 SOTA 旗舰",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 7. MiniMax
  // --------------------------------------------------------------------------
  {
    id: "minimax",
    name: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    defaultBase: "https://api.minimax.chat/v1",
    website: "https://platform.minimaxi.com/",
    signupUrl: "https://platform.minimaxi.com/",
    description: "MiniMax 自研基座，M3 与 abab6.5 双线",
    models: [
      {
        id: "minimax-m3",
        name: "MiniMax M3",
        inputPrice: 1.0,
        outputPrice: 1.0,
        contextWindow: 245_000,
        tier: "cheap",
        qualityScore: 84,
        tools: true,
      },
      {
        id: "abab6.5",
        name: "ABAB 6.5",
        inputPrice: 2.5,
        outputPrice: 2.5,
        contextWindow: 245_000,
        tier: "cheap",
        qualityScore: 82,
        vision: true,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 8. Baichuan（百川）
  // --------------------------------------------------------------------------
  {
    id: "baichuan",
    name: "Baichuan",
    envKey: "BAICHUAN_API_KEY",
    defaultBase: "https://api.baichuan-ai.com/v1",
    website: "https://platform.baichuan-ai.com/",
    signupUrl: "https://platform.baichuan-ai.com/",
    description: "百川智能，中文场景表现稳健",
    models: [
      {
        id: "baichuan4",
        name: "Baichuan 4",
        inputPrice: 1.5,
        outputPrice: 1.5,
        contextWindow: 32_000,
        tier: "cheap",
        qualityScore: 78,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 9. Yi / 零一万物
  // --------------------------------------------------------------------------
  {
    id: "yi",
    name: "Yi / 01.AI",
    envKey: "YI_API_KEY",
    defaultBase: "https://api.lingyiwanwu.com/v1",
    website: "https://platform.01.ai/",
    signupUrl: "https://platform.01.ai/",
    description: "李开复创办，Yi 系列开源生态",
    models: [
      {
        id: "yi-large",
        name: "Yi Large",
        inputPrice: 2.0,
        outputPrice: 2.0,
        contextWindow: 32_000,
        tier: "cheap",
        qualityScore: 76,
        vision: true,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 10. Stepfun（阶跃星辰）
  // --------------------------------------------------------------------------
  {
    id: "stepfun",
    name: "Stepfun",
    envKey: "STEPFUN_API_KEY",
    defaultBase: "https://api.stepfun.com/v1",
    website: "https://platform.stepfun.com/",
    signupUrl: "https://platform.stepfun.com/",
    description: "阶跃星辰，多模态方向突出",
    models: [
      {
        id: "step-2-16k",
        name: "Step-2 16K",
        inputPrice: 0.7,
        outputPrice: 0.7,
        contextWindow: 16_000,
        tier: "cheap",
        qualityScore: 75,
        vision: true,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 11. SiliconFlow（硅基流动，开源聚合）
  // --------------------------------------------------------------------------
  {
    id: "siliconflow",
    name: "SiliconFlow",
    envKey: "SILICONFLOW_API_KEY",
    defaultBase: "https://api.siliconflow.cn/v1",
    website: "https://siliconflow.cn/",
    signupUrl: "https://siliconflow.cn/",
    description: "硅基流动，聚合多种开源模型，有免费档",
    models: [
      {
        id: "qwen2.5-7b-instruct",
        name: "Qwen2.5 7B (SiliconFlow)",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 32_000,
        tier: "free",
        qualityScore: 62,
        tools: true,
        note: "免费档开源模型",
      },
      {
        id: "deepseek-v3",
        name: "DeepSeek V3 (SiliconFlow)",
        inputPrice: 0.27,
        outputPrice: 1.1,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 80,
        tools: true,
      },
      {
        id: "llama-3.3-70b-instruct",
        name: "Llama 3.3 70B (SiliconFlow)",
        inputPrice: 0.35,
        outputPrice: 0.4,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 79,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 12. OpenAI
  // --------------------------------------------------------------------------
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    defaultBase: "https://api.openai.com/v1",
    website: "https://openai.com/",
    signupUrl: "https://platform.openai.com/",
    description: "GPT 系列开创者，生态最成熟",
    models: [
      {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        inputPrice: 0.15,
        outputPrice: 0.6,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 82,
        vision: true,
        tools: true,
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        inputPrice: 2.5,
        outputPrice: 10,
        contextWindow: 128_000,
        tier: "standard",
        qualityScore: 88,
        vision: true,
        tools: true,
      },
      {
        id: "gpt-5",
        name: "GPT-5",
        inputPrice: 5,
        outputPrice: 15,
        contextWindow: 256_000,
        tier: "sota",
        qualityScore: 95,
        vision: true,
        tools: true,
        note: "新一代旗舰，综合最强",
      },
      {
        id: "o1",
        name: "o1",
        inputPrice: 15,
        outputPrice: 60,
        contextWindow: 200_000,
        tier: "sota",
        qualityScore: 93,
        vision: true,
        tools: true,
        note: "推理模型，复杂任务强",
      },
      {
        id: "o3-mini",
        name: "o3-mini",
        inputPrice: 1.1,
        outputPrice: 4.4,
        contextWindow: 200_000,
        tier: "standard",
        qualityScore: 89,
        tools: true,
        note: "推理模型平价版",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 13. Anthropic
  // --------------------------------------------------------------------------
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    defaultBase: "https://api.anthropic.com/v1",
    website: "https://www.anthropic.com/",
    signupUrl: "https://console.anthropic.com/",
    description: "Claude 系列，长文与代码能力强，安全性突出",
    models: [
      {
        id: "claude-3-5-haiku",
        name: "Claude 3.5 Haiku",
        inputPrice: 0.8,
        outputPrice: 4,
        contextWindow: 200_000,
        tier: "cheap",
        qualityScore: 80,
        vision: true,
        tools: true,
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        inputPrice: 3,
        outputPrice: 15,
        contextWindow: 200_000,
        tier: "standard",
        qualityScore: 91,
        vision: true,
        tools: true,
        note: "代码与代理任务表现突出",
      },
      {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        inputPrice: 15,
        outputPrice: 75,
        contextWindow: 200_000,
        tier: "sota",
        qualityScore: 96,
        vision: true,
        tools: true,
        note: "顶级旗舰，综合能力最强之一",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 14. Google Gemini
  // --------------------------------------------------------------------------
  {
    id: "gemini",
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    defaultBase: "https://generativelanguage.googleapis.com/v1beta",
    website: "https://ai.google.dev/",
    signupUrl: "https://ai.google.dev/",
    description: "Google 多模态旗舰，1.5 flash 永久免费档",
    models: [
      {
        id: "gemini-1.5-flash",
        name: "Gemini 1.5 Flash",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 1_000_000,
        tier: "free",
        qualityScore: 70,
        vision: true,
        tools: true,
        note: "免费档，1M 上下文",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        inputPrice: 0.1,
        outputPrice: 0.4,
        contextWindow: 1_000_000,
        tier: "cheap",
        qualityScore: 87,
        vision: true,
        tools: true,
      },
      {
        id: "gemini-3-pro",
        name: "Gemini 3 Pro",
        inputPrice: 2.5,
        outputPrice: 10,
        contextWindow: 2_000_000,
        tier: "sota",
        qualityScore: 94,
        vision: true,
        tools: true,
        note: "2M 上下文，多模态顶级",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 15. OpenRouter（聚合）
  // --------------------------------------------------------------------------
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    defaultBase: "https://openrouter.ai/api/v1",
    website: "https://openrouter.ai/",
    signupUrl: "https://openrouter.ai/",
    description: "聚合 300+ 模型的统一网关，一个 key 调用所有厂商",
    models: [
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        inputPrice: 0.5,
        outputPrice: 1.5,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 80,
        tools: true,
        note: "自动路由到最优模型",
      },
      {
        id: "anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5 (via OpenRouter)",
        inputPrice: 15.5,
        outputPrice: 75.5,
        contextWindow: 200_000,
        tier: "sota",
        qualityScore: 96,
        vision: true,
        tools: true,
        note: "含 OpenRouter 加价",
      },
      {
        id: "google/gemini-3-pro",
        name: "Gemini 3 Pro (via OpenRouter)",
        inputPrice: 3,
        outputPrice: 11,
        contextWindow: 2_000_000,
        tier: "sota",
        qualityScore: 94,
        vision: true,
        tools: true,
        note: "含 OpenRouter 加价",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 16. Together AI（开源聚合）
  // --------------------------------------------------------------------------
  {
    id: "together",
    name: "Together AI",
    envKey: "TOGETHER_API_KEY",
    defaultBase: "https://api.together.xyz/v1",
    website: "https://www.together.ai/",
    signupUrl: "https://www.together.ai/",
    description: "开源模型托管平台，Llama / Qwen 等均有部署",
    models: [
      {
        id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        name: "Llama 3.3 70B Turbo (Together)",
        inputPrice: 0.88,
        outputPrice: 0.88,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 79,
        tools: true,
      },
      {
        id: "Qwen/Qwen2.5-72B-Instruct-Turbo",
        name: "Qwen2.5 72B Turbo (Together)",
        inputPrice: 1.2,
        outputPrice: 1.2,
        contextWindow: 32_000,
        tier: "cheap",
        qualityScore: 81,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 17. Groq（超快推理）
  // --------------------------------------------------------------------------
  {
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    defaultBase: "https://api.groq.com/openai/v1",
    website: "https://groq.com/",
    signupUrl: "https://groq.com/",
    description: "LPU 推理芯片，速度极快（500+ tokens/s）",
    models: [
      {
        id: "llama-3.1-70b-versatile",
        name: "Llama 3.1 70B Versatile (Groq)",
        inputPrice: 0.59,
        outputPrice: 0.79,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 78,
        tools: true,
        note: "极快推理，延迟 <200ms",
      },
      {
        id: "deepseek-r1-distill-llama-70b",
        name: "DeepSeek R1 Distill 70B (Groq)",
        inputPrice: 0.75,
        outputPrice: 0.99,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 85,
        tools: true,
        note: "R1 蒸馏版，推理快",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 18. Fireworks（开源聚合）
  // --------------------------------------------------------------------------
  {
    id: "fireworks",
    name: "Fireworks",
    envKey: "FIREWORKS_API_KEY",
    defaultBase: "https://api.fireworks.ai/inference/v1",
    website: "https://fireworks.ai/",
    signupUrl: "https://fireworks.ai/",
    description: "开源模型托管，支持微调与/serverless 部署",
    models: [
      {
        id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
        name: "Llama 3.3 70B (Fireworks)",
        inputPrice: 0.9,
        outputPrice: 0.9,
        contextWindow: 128_000,
        tier: "cheap",
        qualityScore: 79,
        tools: true,
      },
      {
        id: "accounts/fireworks/models/qwen2p5-72b-instruct",
        name: "Qwen2.5 72B (Fireworks)",
        inputPrice: 0.9,
        outputPrice: 0.9,
        contextWindow: 32_000,
        tier: "cheap",
        qualityScore: 81,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 19. Mistral
  // --------------------------------------------------------------------------
  {
    id: "mistral",
    name: "Mistral",
    envKey: "MISTRAL_API_KEY",
    defaultBase: "https://api.mistral.ai/v1",
    website: "https://mistral.ai/",
    signupUrl: "https://console.mistral.ai/",
    description: "欧洲厂商，开源与闭源并行",
    models: [
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        inputPrice: 2,
        outputPrice: 6,
        contextWindow: 128_000,
        tier: "standard",
        qualityScore: 85,
        vision: true,
        tools: true,
      },
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        inputPrice: 0.2,
        outputPrice: 0.6,
        contextWindow: 32_000,
        tier: "cheap",
        qualityScore: 74,
        tools: true,
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 20. Ollama（本地）
  // --------------------------------------------------------------------------
  {
    id: "ollama",
    name: "Ollama",
    envKey: "OLLAMA_BASE_URL",
    defaultBase: "http://127.0.0.1:11434",
    local: true,
    website: "https://ollama.ai/",
    signupUrl: "https://ollama.ai/",
    description: "本地开源模型运行时，一键拉取 GGUF 模型",
    models: [
      {
        id: "llama3.1",
        name: "Llama 3.1 (Ollama)",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 128_000,
        tier: "free",
        qualityScore: 76,
        tools: true,
        note: "本地运行，需自行下载模型",
      },
      {
        id: "qwen2.5",
        name: "Qwen 2.5 (Ollama)",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 32_000,
        tier: "free",
        qualityScore: 75,
        tools: true,
        note: "本地运行",
      },
      {
        id: "deepseek-r1",
        name: "DeepSeek R1 (Ollama)",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 128_000,
        tier: "free",
        qualityScore: 85,
        tools: true,
        note: "本地运行，蒸馏版",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 21. LM Studio（本地）
  // --------------------------------------------------------------------------
  {
    id: "lmstudio",
    name: "LM Studio",
    envKey: "LMSTUDIO_BASE_URL",
    defaultBase: "http://127.0.0.1:1234/v1",
    local: true,
    website: "https://lmstudio.ai/",
    signupUrl: "https://lmstudio.ai/",
    description: "桌面端本地模型运行时，OpenAI 兼容端点",
    models: [
      {
        id: "any-gguf",
        name: "任意 GGUF 模型 (LM Studio)",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 32_000,
        tier: "free",
        qualityScore: 70,
        tools: true,
        note: "本地运行，模型自选",
      },
    ],
  },

  // --------------------------------------------------------------------------
  // 22. vLLM（自托管）
  // --------------------------------------------------------------------------
  {
    id: "vllm",
    name: "vLLM",
    envKey: "VLLM_BASE_URL",
    defaultBase: "http://127.0.0.1:8000/v1",
    local: true,
    website: "https://docs.vllm.ai/",
    signupUrl: "https://docs.vllm.ai/",
    description: "高吞吐量开源推理引擎，自托管 OpenAI 兼容",
    models: [
      {
        id: "any-hf-model",
        name: "任意 HuggingFace 模型 (vLLM)",
        inputPrice: 0,
        outputPrice: 0,
        contextWindow: 32_000,
        tier: "free",
        qualityScore: 75,
        tools: true,
        note: "自托管，按硬件能力决定上下文",
      },
    ],
  },
];

// ============================================================================
// 工具函数
// ============================================================================

/** 计算模型的平均单价（inputPrice + outputPrice）/ 2，免费模型为 0 */
function avgPrice(m: ModelInfo): number {
  return (m.inputPrice + m.outputPrice) / 2;
}

/**
 * 按 mode 排序模型
 * - "price": 按 (inputPrice + outputPrice) / 2 升序，免费模型排最前
 * - "efficient": 按 qualityScore 降序
 */
export function sortModels(models: ModelInfo[], mode: SortMode): ModelInfo[] {
  const copy = [...models];
  if (mode === "price") {
    // 免费模型（avgPrice === 0）始终排最前；其余按均价升序
    copy.sort((a, b) => {
      const pa = avgPrice(a);
      const pb = avgPrice(b);
      if (pa === 0 && pb !== 0) return -1;
      if (pa !== 0 && pb === 0) return 1;
      if (pa !== pb) return pa - pb;
      // 价格相同时按质量分降序兜底
      return b.qualityScore - a.qualityScore;
    });
  } else {
    // efficient: 按 qualityScore 降序；同分时按价格升序
    copy.sort((a, b) => {
      if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
      return avgPrice(a) - avgPrice(b);
    });
  }
  return copy;
}

/**
 * 按 mode 排序所有 provider 的所有模型，返回扁平列表
 * 每个元素为 ProviderEntry 展开并附带单个 model 字段
 */
export function flatCatalogSorted(
  mode: SortMode,
): Array<ProviderEntry & { model: ModelInfo }> {
  const flat: Array<ProviderEntry & { model: ModelInfo }> = [];
  for (const provider of PROVIDER_CATALOG) {
    for (const model of provider.models) {
      flat.push({ ...provider, model });
    }
  }
  // 复用 sortModels 逻辑：仅按 model 字段排序，保持 provider 信息
  if (mode === "price") {
    flat.sort((a, b) => {
      const pa = avgPrice(a.model);
      const pb = avgPrice(b.model);
      if (pa === 0 && pb !== 0) return -1;
      if (pa !== 0 && pb === 0) return 1;
      if (pa !== pb) return pa - pb;
      return b.model.qualityScore - a.model.qualityScore;
    });
  } else {
    flat.sort((a, b) => {
      if (b.model.qualityScore !== a.model.qualityScore) {
        return b.model.qualityScore - a.model.qualityScore;
      }
      return avgPrice(a.model) - avgPrice(b.model);
    });
  }
  return flat;
}

/** 按 id 查 provider */
export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * 推荐组合：便宜的优先
 * 返回 top 5 便宜组合（含 reason 解释为何推荐）
 */
export function recommendByPrice(): Array<{
  providerId: string;
  modelId: string;
  reason: string;
}> {
  const sorted = flatCatalogSorted("price");
  const picked: Array<{ providerId: string; modelId: string; reason: string }> = [];
  const usedProviders = new Set<string>();
  for (const entry of sorted) {
    // 同一 provider 最多推荐 1 个，保证多样性
    if (usedProviders.has(entry.id)) continue;
    const m = entry.model;
    let reason: string;
    if (m.inputPrice === 0 && m.outputPrice === 0) {
      reason = `免费模型，qualityScore ${m.qualityScore}，零成本原型与轻量任务首选`;
    } else if (entry.local) {
      reason = `本地运行零 API 费用，qualityScore ${m.qualityScore}，隐私与成本双优`;
    } else {
      reason = `均价 $${avgPrice(m).toFixed(3)}/M tokens，qualityScore ${m.qualityScore}，性价比突出`;
    }
    picked.push({ providerId: entry.id, modelId: m.id, reason });
    usedProviders.add(entry.id);
    if (picked.length >= 5) break;
  }
  return picked;
}

/**
 * 推荐组合：效果优先
 * 返回 top 5 SOTA 组合
 */
export function recommendByQuality(): Array<{
  providerId: string;
  modelId: string;
  reason: string;
}> {
  const sorted = flatCatalogSorted("efficient");
  const picked: Array<{ providerId: string; modelId: string; reason: string }> = [];
  const usedProviders = new Set<string>();
  for (const entry of sorted) {
    if (usedProviders.has(entry.id)) continue;
    const m = entry.model;
    let reason: string;
    if (m.tier === "sota") {
      reason = `SOTA 旗舰，qualityScore ${m.qualityScore}，复杂推理与代理任务首选`;
    } else if (m.tier === "premium" || m.tier === "standard") {
      reason = `高端模型，qualityScore ${m.qualityScore}，均衡能力与成本`;
    } else {
      reason = `性价比之选，qualityScore ${m.qualityScore}，质量分排名前列`;
    }
    picked.push({ providerId: entry.id, modelId: m.id, reason });
    usedProviders.add(entry.id);
    if (picked.length >= 5) break;
  }
  return picked;
}

// ============================================================================
// 统计函数
// ============================================================================

export interface ProviderStat {
  providerId: string;
  providerName: string;
  modelCount: number;
  cheapestModel: ModelInfo | undefined;
  strongestModel: ModelInfo | undefined;
}

/**
 * 返回各 provider 的统计信息：模型数、最便宜模型、最强模型
 */
export function getProviderStats(): ProviderStat[] {
  return PROVIDER_CATALOG.map((p) => {
    const byPrice = sortModels(p.models, "price");
    const byQuality = sortModels(p.models, "efficient");
    return {
      providerId: p.id,
      providerName: p.name,
      modelCount: p.models.length,
      cheapestModel: byPrice[0],
      strongestModel: byQuality[0],
    };
  });
}
