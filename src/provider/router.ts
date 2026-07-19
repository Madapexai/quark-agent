/**
 * MoA (Mixture of Agents) Intelligent Router
 *
 * Classifies task complexity and routes to the most appropriate model/provider.
 * Supports configurable tiers (fast/medium/powerful), custom rules, and
 * integrates with MultiProvider for seamless model dispatch.
 */

import type { Provider } from "../core/types.js";

// ============================================================================
// Types
// ============================================================================

export type TaskComplexity = "simple" | "medium" | "complex";

export interface RouterConfig {
  /** Fast model for simple tasks (default: gpt-4o-mini) */
  fastModel?: string;
  /** Medium model (default: gpt-4o) */
  mediumModel?: string;
  /** Powerful model for complex tasks (default: o1) */
  powerfulModel?: string;
  /** Custom complexity detection function */
  complexityDetector?: (prompt: string, tools: number) => TaskComplexity;
  /** Route rules: regex pattern -> model name */
  rules?: Array<{ pattern: string; model: string }>;
}

export interface RouteResult {
  /** The model to use */
  model: string;
  /** The provider that supports this model */
  provider: Provider;
  /** Detected complexity level */
  complexity: TaskComplexity;
}

// ============================================================================
// Heuristic complexity signals
// ============================================================================

/** Keywords that strongly suggest complex tasks */
const COMPLEX_SIGNALS = [
  /\barchitect(?:ure|ing)?\b/i,
  /\bdesign\s+(?:the\s+)?(?:system|api|database|schema|protocol|service)\b/i,
  /\brefactor\b/i,
  /\bimplement\s+(?:a\s+)?(?:full|complete|end.to.end)\b/i,
  /\bmulti.?step\b/i,
  /\bstep.?by.?step\b/i,
  /\bprove\b/i,
  /\bmath\b/,
  /\btheorem\b/i,
  /\balgorithm\b/i,
  /\boptimiz(?:e|ation)\b/i,
  /\bcompil(?:e|er|ation)\b/i,
  /\btranspil(?:e|er|ation)\b/i,
  /\bcode.?gen(?:eration)?\b/i,
  /\bgenerat(?:e|ing)\s+(?:a\s+)?(?:class|module|package|project|app|service)\b/i,
  /\bwrite\s+(?:a\s+)?(?:full|complete|entire)\b/i,
  /\bdebug\s+(?:this|the|a)\s+(?:complex|complicated)\b/i,
  /\bchain\s+of\s+thought\b/i,
  /\breason(?:ing)?\b/i,
  /\banalyz(?:e|ing)\b/i,
];

/** Keywords that suggest medium tasks */
const MEDIUM_SIGNALS = [
  /\bexplain\b/i,
  /\bhow\s+(?:to|does|do)\b/i,
  /\bcompar(?:e|ison)\b/i,
  /\bsummariz(?:e|ing)\b/i,
  /\bconvert\b/i,
  /\btransform\b/i,
  /\bparse\b/i,
  /\bformat\b/i,
  /\bwrite\s+(?:a\s+)?(?:function|method|script|test|query)\b/i,
  /\bfix\b/i,
  /\bdebug\b/i,
  /\bupdate\b/i,
  /\bmodify\b/i,
];

/** Keywords for code / math content */
const CODE_SIGNALS = [
  /```/,
  /\bfunction\b/,
  /\bclass\b/,
  /\bimport\b/,
  /\bexport\b/,
  /\bconst\b.*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])+\s*=>/,
  /\bdef\b/,
  /\breturn\b/,
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /∫|∑|∏|√|∞|π|θ|α|β/,
  /\bequation\b/i,
  /\bformula\b/i,
  /\bcalculus\b/i,
];

// ============================================================================
// MoARouter
// ============================================================================

export class MoARouter {
  private readonly fastModel: string;
  private readonly mediumModel: string;
  private readonly powerfulModel: string;
  private readonly complexityDetector?: (prompt: string, tools: number) => TaskComplexity;
  private readonly rules: Array<{ pattern: RegExp; model: string }>;
  private readonly providers: Map<string, Provider>;

  constructor(config: RouterConfig, providers: Map<string, Provider>) {
    this.fastModel = config.fastModel ?? "gpt-4o-mini";
    this.mediumModel = config.mediumModel ?? "gpt-4o";
    this.powerfulModel = config.powerfulModel ?? "o1";
    this.complexityDetector = config.complexityDetector;
    this.providers = providers;
    this.rules = (config.rules ?? []).map((r) => ({
      pattern: new RegExp(r.pattern, "i"),
      model: r.model,
    }));
  }

  /**
   * Detect task complexity from prompt and available tool count.
   *
   * Heuristic approach:
   * - Simple: short prompt (<100 chars), no code/math, few tools
   * - Medium: moderate length, some reasoning, tool usage expected
   * - Complex: long prompt, code generation, multi-step reasoning, math, architecture
   */
  detectComplexity(prompt: string, availableTools: number): TaskComplexity {
    // Custom detector takes priority
    if (this.complexityDetector) {
      return this.complexityDetector(prompt, availableTools);
    }

    const len = prompt.length;

    // Check for complex signals — even one match is enough if prompt is long
    const complexScore = COMPLEX_SIGNALS.reduce(
      (acc, re) => acc + (re.test(prompt) ? 1 : 0),
      0,
    );
    const mediumScore = MEDIUM_SIGNALS.reduce(
      (acc, re) => acc + (re.test(prompt) ? 1 : 0),
      0,
    );
    const codeScore = CODE_SIGNALS.reduce(
      (acc, re) => acc + (re.test(prompt) ? 1 : 0),
      0,
    );

    // Length-based heuristic
    const isLong = len > 500;
    const isVeryLong = len > 1500;

    // Tool-based heuristic
    const manyTools = availableTools > 5;

    // Scoring
    if (
      isVeryLong ||
      complexScore >= 2 ||
      (complexScore >= 1 && codeScore >= 1) ||
      (codeScore >= 2 && isLong)
    ) {
      return "complex";
    }

    if (
      isLong ||
      complexScore >= 1 ||
      mediumScore >= 2 ||
      codeScore >= 1 ||
      manyTools
    ) {
      return "medium";
    }

    if (len < 100 && mediumScore === 0 && codeScore === 0) {
      return "simple";
    }

    // Default: medium for anything that isn't clearly simple
    return mediumScore > 0 ? "medium" : "simple";
  }

  /**
   * Route to the best model and provider for the given task.
   *
   * Priority:
   * 1. Custom rules (regex pattern match)
   * 2. Complexity-based tier selection
   * 3. Fallback to fast model
   */
  route(prompt: string, availableTools: number): RouteResult {
    // 1. Check custom rules first
    for (const rule of this.rules) {
      if (rule.pattern.test(prompt)) {
        const provider = this.findProviderForModel(rule.model);
        return { model: rule.model, provider, complexity: "medium" };
      }
    }

    // 2. Complexity-based routing
    const complexity = this.detectComplexity(prompt, availableTools);
    const model = this.modelForComplexity(complexity);
    const provider = this.findProviderForModel(model);

    return { model, provider, complexity };
  }

  /** Map complexity level to model name */
  private modelForComplexity(complexity: TaskComplexity): string {
    switch (complexity) {
      case "simple":
        return this.fastModel;
      case "medium":
        return this.mediumModel;
      case "complex":
        return this.powerfulModel;
    }
  }

  /**
   * Find a provider that can handle the given model.
   *
   * Strategy:
   * - Try prefix match (model name starts with provider name)
   * - Try "openai" as default
   * - Fall back to first available provider
   */
  private findProviderForModel(model: string): Provider {
    // Prefix match: e.g. "gpt-4o" matches "openai", "claude" matches "anthropic"
    for (const [name, p] of this.providers) {
      if (model.startsWith(name) || model.includes(name)) return p;
    }

    // Known model→provider mappings
    const MODEL_PREFIX: Record<string, string> = {
      "gpt-": "openai",
      "o1": "openai",
      "o3": "openai",
      "claude-": "anthropic",
      "gemini-": "gemini",
      "llama": "ollama",
      "mistral": "ollama",
      "qwen": "ollama",
    };
    for (const [prefix, providerName] of Object.entries(MODEL_PREFIX)) {
      if (model.startsWith(prefix) || model.includes(prefix)) {
        const p = this.providers.get(providerName);
        if (p) return p;
      }
    }

    // Default to "openai" provider
    const openai = this.providers.get("openai");
    if (openai) return openai;

    // Last resort: first available
    const first = this.providers.values().next();
    if (first.done) {
      throw new Error("No providers available for routing");
    }
    return first.value;
  }
}
