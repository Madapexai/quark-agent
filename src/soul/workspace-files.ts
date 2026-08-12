/**
 * WorkspaceFiles —— 基于文件的人格配置加载器
 *
 * 设计（对标 Hermes SOUL.md + OpenClaw 工作区文件栈）：
 * - 从工作区目录读取 Markdown 配置文件，组装成人格/行为/记忆配置
 * - 文件栈：SOUL.md → IDENTITY.md → USER.md → AGENTS.md → TOOLS.md
 * - 热重载：文件变更时自动重新加载
 * - 文件优先：文件存在则用文件，不存在则用代码默认值
 *
 * 对标关系：
 * - SOUL.md → SoulSpec（人格、原则、说话风格）
 * - IDENTITY.md → 轻量身份卡（名字、emoji、角色）
 * - USER.md → 用户画像（称呼、时区、偏好）
 * - AGENTS.md → 行为规范（安全红线、工作流约束）
 * - TOOLS.md → 工具配置（SSH、API key 引用等）
 */

import { readFileSync, existsSync, watchFile, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import type { Soul } from "../core/types.js";
import type { SoulSpec } from "./index.js";
import { renderSoul, createSoul } from "./index.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 工作区文件配置 */
export interface WorkspaceFileConfig {
  /** 工作区根目录 */
  rootDir: string;
  /** 文件名覆盖（默认值如下） */
  files?: {
    soul?: string;
    identity?: string;
    user?: string;
    agents?: string;
    tools?: string;
  };
}

/** 解析后的身份信息 */
export interface ParsedIdentity {
  name: string;
  emoji?: string;
  role?: string;
  vibe?: string;
  avatar?: string;
  version?: string;
}

/** 解析后的用户信息 */
export interface ParsedUser {
  name?: string;
  callName?: string;
  timezone?: string;
  notes?: string;
  preferences?: Record<string, string>;
}

/** 解析后的行为规范 */
export interface ParsedAgents {
  rules: string[];
  safetyGuidelines?: string[];
  workflowConstraints?: string[];
}

/** 解析后的工具配置 */
export interface ParsedTools {
  notes: Record<string, string>;
  configs?: Record<string, Record<string, unknown>>;
}

/** 完整的工作区配置 */
export interface WorkspaceSoulConfig {
  soul: SoulSpec | null;
  identity: ParsedIdentity | null;
  user: ParsedUser | null;
  agents: ParsedAgents | null;
  tools: ParsedTools | null;
  /** 组装后的完整 system prompt */
  systemPrompt: string;
  /** 最后加载时间 */
  loadedAt: number;
}

// ============================================================================
// WorkspaceFilesLoader —— 核心加载器
// ============================================================================

export class WorkspaceFilesLoader {
  private config: Required<WorkspaceFileConfig>;
  private watchers: FSWatcher[] = [];
  private cache: WorkspaceSoulConfig | null = null;
  private reloadCallback: ((config: WorkspaceSoulConfig) => void) | undefined;

  constructor(config: WorkspaceFileConfig) {
    this.config = {
      rootDir: resolve(config.rootDir),
      files: {
        soul: config.files?.soul ?? "SOUL.md",
        identity: config.files?.identity ?? "IDENTITY.md",
        user: config.files?.user ?? "USER.md",
        agents: config.files?.agents ?? "AGENTS.md",
        tools: config.files?.tools ?? "TOOLS.md",
      },
    };
  }

  /** 加载所有工作区文件，组装配置 */
  load(): WorkspaceSoulConfig {
    const soul = this.parseSoulFile();
    const identity = this.parseIdentityFile();
    const user = this.parseUserFile();
    const agents = this.parseAgentsFile();
    const tools = this.parseToolsFile();

    const systemPrompt = this.assembleSystemPrompt(soul, identity, user, agents, tools);

    this.cache = {
      soul,
      identity,
      user,
      agents,
      tools,
      systemPrompt,
      loadedAt: Date.now(),
    };

    return this.cache;
  }

  /** 获取缓存的配置（未加载则先加载） */
  get(): WorkspaceSoulConfig {
    if (!this.cache) return this.load();
    return this.cache;
  }

  /** 启动文件监听，变更时自动重载 */
  watch(callback?: (config: WorkspaceSoulConfig) => void): void {
    this.reloadCallback = callback;
    const filenames = Object.values(this.config.files);
    for (const filename of filenames) {
      const filepath = join(this.config.rootDir, filename);
      if (existsSync(filepath)) {
        const watcher = watchFile(filepath, { interval: 1000 }, () => {
          this.load();
          if (this.reloadCallback) this.reloadCallback(this.cache!);
        });
        this.watchers.push(watcher as unknown as FSWatcher);
      }
    }
  }

  /** 停止监听 */
  unwatch(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
  }

  /** 组装系统提示词 */
  private assembleSystemPrompt(
    soul: SoulSpec | null,
    identity: ParsedIdentity | null,
    user: ParsedUser | null,
    agents: ParsedAgents | null,
    tools: ParsedTools | null,
  ): string {
    const parts: string[] = [];

    // 1. Soul（人格核心）
    if (soul) {
      parts.push(renderSoul(soul));
    } else {
      parts.push("你是一个有用的 AI 助手。");
    }

    // 2. Identity（轻量身份补充）
    if (identity) {
      parts.push(`\n## 身份\n名字: ${identity.name}${identity.emoji ? ` ${identity.emoji}` : ""}${identity.role ? `\n角色: ${identity.role}` : ""}${identity.vibe ? `\n风格: ${identity.vibe}` : ""}`);
    }

    // 3. User（用户画像）
    if (user) {
      const userParts: string[] = ["\n## 用户"];
      if (user.callName) userParts.push(`称呼: ${user.callName}`);
      if (user.timezone) userParts.push(`时区: ${user.timezone}`);
      if (user.preferences) {
        for (const [k, v] of Object.entries(user.preferences)) {
          userParts.push(`${k}: ${v}`);
        }
      }
      if (user.notes) userParts.push(`备注: ${user.notes}`);
      parts.push(userParts.join("\n"));
    }

    // 4. Agents（行为规范）
    if (agents && agents.rules.length > 0) {
      parts.push(`\n## 行为规范\n${agents.rules.map((r) => `- ${r}`).join("\n")}`);
    }

    // 5. Tools（工具配置摘要）
    if (tools && Object.keys(tools.notes).length > 0) {
      parts.push(`\n## 工具配置\n${Object.entries(tools.notes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
    }

    return parts.join("\n");
  }

  // ========================================================================
  // 文件解析器
  // ========================================================================

  private parseSoulFile(): SoulSpec | null {
    const content = this.readFile(this.config.files.soul!);
    if (!content) return null;

    const idMatch = content.match(/^#\s*(.+)$/m);
    const nameMatch = content.match(/名字[：:]\s*(.+)/i) ?? idMatch;

    // persona: 优先匹配 "人格：" / "角色：" 前缀；否则取标题后、第一个 ## 之前的段落
    const personaMatch = content.match(/(?:persona|人格|角色)[：:]\s*([^\n]+)/i);
    let persona: string;
    if (personaMatch) {
      persona = personaMatch[1].trim();
    } else {
      // 取 # 标题行之后、第一个 ## section 之前的文本作为 persona
      const titleEnd = content.indexOf("\n");
      const afterTitle = titleEnd >= 0 ? content.slice(titleEnd + 1) : content;
      const firstSection = afterTitle.indexOf("## ");
      const descText = firstSection >= 0 ? afterTitle.slice(0, firstSection) : afterTitle;
      persona = descText.trim() || content.slice(0, 200);
    }

    const traitsSection = this.extractSection(content, ["性格特征", "Traits", "特质"]);
    const principlesSection = this.extractSection(content, ["原则", "Principles", "行为准则"]);
    const styleSection = this.extractSection(content, ["说话风格", "SpeakingStyle", "风格", "Style"]);

    const name = nameMatch?.[1]?.trim() ?? "Agent";

    return {
      id: `soul-${Date.now().toString(36)}`,
      name,
      persona,
      traits: traitsSection ? this.parseListItems(traitsSection) : [],
      principles: principlesSection ? this.parseListItems(principlesSection) : [],
      speakingStyle: styleSection?.trim() || undefined,
    };
  }

  private parseIdentityFile(): ParsedIdentity | null {
    const content = this.readFile(this.config.files.identity!);
    if (!content) return null;

    // 支持 "Name: value" / "**Name**: value" / "- **Name**: value" 等格式
    const nameMatch = content.match(/\*{0,2}(?:Name|名字)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const emojiMatch = content.match(/\*{0,2}(?:Emoji|表情)\*{0,2}\s*[：:]\s*(\S+)/i);
    const roleMatch = content.match(/\*{0,2}(?:Role|角色)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const vibeMatch = content.match(/\*{0,2}(?:Vibe|风格|调性)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const avatarMatch = content.match(/\*{0,2}(?:Avatar|头像)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const versionMatch = content.match(/\*{0,2}(?:Version|版本)\*{0,2}\s*[：:]\s*([^\n]+)/i);

    if (!nameMatch && !roleMatch) return null;

    return {
      name: nameMatch?.[1]?.trim() ?? "Agent",
      emoji: emojiMatch?.[1]?.trim(),
      role: roleMatch?.[1]?.trim(),
      vibe: vibeMatch?.[1]?.trim(),
      avatar: avatarMatch?.[1]?.trim(),
      version: versionMatch?.[1]?.trim(),
    };
  }

  private parseUserFile(): ParsedUser | null {
    const content = this.readFile(this.config.files.user!);
    if (!content) return null;

    // 支持 "Name: value" / "**Name**: value" / "- **Name**: value" 等格式
    const nameMatch = content.match(/\*{0,2}(?:Name|名字)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const callMatch = content.match(/\*{0,2}(?:Call|称呼|怎么称呼)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const tzMatch = content.match(/\*{0,2}(?:Timezone|时区)\*{0,2}\s*[：:]\s*([^\n]+)/i);
    const notesMatch = content.match(/\*{0,2}(?:Notes|备注)\*{0,2}\s*[：:]\s*([^\n]+)/i);

    // 解析 preferences section
    const prefSection = this.extractSection(content, ["Preferences", "偏好", "沟通偏好"]);
    const preferences: Record<string, string> = {};
    if (prefSection) {
      for (const line of prefSection.split("\n")) {
        const m = line.match(/[-*]?\s*\*{0,2}(.+?)\*{0,2}[:：]\s*(.+)/);
        if (m) preferences[m[1].trim()] = m[2].trim();
      }
    }

    if (!nameMatch && !callMatch && !tzMatch) return null;

    return {
      name: nameMatch?.[1]?.trim(),
      callName: callMatch?.[1]?.trim(),
      timezone: tzMatch?.[1]?.trim(),
      notes: notesMatch?.[1]?.trim(),
      preferences,
    };
  }

  private parseAgentsFile(): ParsedAgents | null {
    const content = this.readFile(this.config.files.agents!);
    if (!content) return null;

    const rulesSection = this.extractSection(content, ["Rules", "规则", "约束", "Constraints"]);
    const safetySection = this.extractSection(content, ["Safety", "安全", "红线"]);
    const workflowSection = this.extractSection(content, ["Workflow", "工作流", "流程"]);

    const rules = rulesSection ? this.parseListItems(rulesSection) : [];
    if (rules.length === 0 && !safetySection && !workflowSection) return null;

    return {
      rules,
      safetyGuidelines: safetySection ? this.parseListItems(safetySection) : undefined,
      workflowConstraints: workflowSection ? this.parseListItems(workflowSection) : undefined,
    };
  }

  private parseToolsFile(): ParsedTools | null {
    const content = this.readFile(this.config.files.tools!);
    if (!content) return null;

    const sections = this.extractAllSections(content);
    const notes: Record<string, string> = {};
    const configs: Record<string, Record<string, unknown>> = {};

    for (const [sectionName, sectionContent] of Object.entries(sections)) {
      // 尝试解析为 key: value 对
      const items = this.parseKeyValueItems(sectionContent);
      if (Object.keys(items).length > 0) {
        notes[sectionName] = sectionContent.trim();
        configs[sectionName] = items;
      } else {
        notes[sectionName] = sectionContent.trim();
      }
    }

    if (Object.keys(notes).length === 0) return null;
    return { notes, configs };
  }

  // ========================================================================
  // Markdown 解析工具
  // ========================================================================

  private readFile(filename: string): string | null {
    const filepath = join(this.config.rootDir, filename);
    if (!existsSync(filepath)) return null;
    try {
      return readFileSync(filepath, "utf-8");
    } catch {
      return null;
    }
  }

  /** 提取 Markdown section（## 标题下的内容） */
  private extractSection(content: string, headers: string[]): string | null {
    const lines = content.split("\n");
    let inSection = false;
    let headerLevel = 0;
    const result: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^(#+)\s+(.+)/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const title = headerMatch[2].trim().toLowerCase();

        if (inSection) {
          // 遇到同级或更高级标题，结束当前 section
          if (level <= headerLevel) {
            break;
          }
        } else {
          // 检查是否匹配目标 header
          if (headers.some((h) => title.includes(h.toLowerCase()))) {
            inSection = true;
            headerLevel = level;
            continue;
          }
        }
      } else if (inSection) {
        result.push(line);
      }
    }

    const text = result.join("\n").trim();
    return text || null;
  }

  /** 提取所有 section */
  private extractAllSections(content: string): Record<string, string> {
    const lines = content.split("\n");
    const sections: Record<string, string> = {};
    let currentHeader: string | null = null;
    let currentContent: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^(#+)\s+(.+)/);
      if (headerMatch) {
        // 保存前一个 section
        if (currentHeader) {
          sections[currentHeader] = currentContent.join("\n").trim();
        }
        currentHeader = headerMatch[2].trim();
        currentContent = [];
      } else if (currentHeader) {
        currentContent.push(line);
      }
    }

    // 保存最后一个 section
    if (currentHeader) {
      sections[currentHeader] = currentContent.join("\n").trim();
    }

    return sections;
  }

  /** 解析列表项 */
  private parseListItems(content: string): string[] {
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- ") || l.startsWith("* ") || l.match(/^\d+\./))
      .map((l) => l.replace(/^[-*]\s+/, "").replace(/^\d+\.\s*/, "").trim())
      .filter((l) => l.length > 0);
  }

  /** 解析 key: value 对 */
  private parseKeyValueItems(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*[-*]?\s*(.+?)[:：]\s*(.+)$/);
      if (m && !m[1].startsWith("#")) {
        result[m[1].trim()] = m[2].trim();
      }
    }
    return result;
  }
}

// ============================================================================
// FileBasedSoulProvider —— 从文件加载 Soul 并适配 SoulStore 接口
// ============================================================================

export class FileBasedSoulProvider {
  private loader: WorkspaceFilesLoader;
  private cache: Soul | null = null;

  constructor(rootDir: string) {
    this.loader = new WorkspaceFilesLoader({ rootDir });
  }

  /** 加载 Soul（从 SOUL.md + IDENTITY.md 组装） */
  load(): Soul {
    if (this.cache) return this.cache;

    return this.reload();
  }

  /** 强制重新加载（清除缓存，重新读文件） */
  reload(): Soul {
    const config = this.loader.load();
    if (config.soul) {
      this.cache = createSoul(config.soul);
    } else {
      // fallback：从 identity 构建
      const id = config.identity;
      this.cache = createSoul({
        id: `soul-file-${Date.now().toString(36)}`,
        name: id?.name ?? "Agent",
        persona: id?.role ?? "AI 助手",
        traits: [],
        principles: [],
        speakingStyle: id?.vibe,
      });
    }
    return this.cache;
  }

  /** 获取完整的工作区配置 */
  getWorkspaceSoulConfig(): WorkspaceSoulConfig {
    return this.loader.get();
  }

  /** 获取系统提示词 */
  getSystemPrompt(): string {
    return this.loader.get().systemPrompt;
  }

  /** 启动热重载 */
  watch(callback?: (soul: Soul) => void): void {
    this.loader.watch(() => {
      this.cache = null; // 清缓存，下次 load 时重新加载
      const newSoul = this.load();
      if (callback) callback(newSoul);
    });
  }

  /** 停止热重载 */
  unwatch(): void {
    this.loader.unwatch();
  }
}
