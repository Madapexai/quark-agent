/**
 * 环境变量管理器：读写 .env + 合并 process.env
 *
 * 设计目标：
 * - 对 .env 文件做读/写/删（保留注释与原始格式）
 * - 合并 .env 与 process.env，标注每条变量的来源（.env / process / system）
 * - 自动探测敏感变量（KEY/TOKEN/SECRET/PASSWORD/AUTH/credentials），显示掩码
 * - 提供 recommended() 列出推荐配置的环境变量（基于 PROVIDER_CATALOG）
 *
 * 零 npm 依赖，仅用 Node 内建模块。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_CATALOG } from "../provider/catalog.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface EnvVar {
  key: string;
  value: string;
  /** 来源 */
  source: "dotenv" | "process" | "system";
  /** 是否敏感（自动检测） */
  sensitive: boolean;
  /** 掩码后的值 */
  masked: string;
  /** 是否已设置（用于 dashboard 显示） */
  configured: boolean;
}

export interface EnvManagerOptions {
  /** .env 文件路径，默认 process.cwd()/.env */
  dotenvPath?: string;
  /** 自动加载到 process.env */
  autoLoad?: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/** 敏感关键词（不区分大小写，key 含任一即判定为敏感） */
const SENSITIVE_KEYWORDS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH", "CREDENTIALS"];

/** 常见系统级环境变量名（来源标记为 system） */
const SYSTEM_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "PWD", "OLDPWD", "TMPDIR", "TEMP", "TMP", "HOSTNAME", "HOSTTYPE", "OSTYPE",
  "MACHTYPE", "SHLVL", "_", "DISPLAY", "COLORTERM", "EDITOR", "VISUAL",
  "LSCOLORS", "LS_COLORS", "PS1", "PS2", "MANPATH", "INFOPATH",
  "USERPROFILE", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "SYSTEMROOT",
  "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "COLORFGBG", "ITERM_PROFILE", "ITERM_SESSION_ID", "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION", "XPC_FLAGS", "XPC_SERVICE_NAME",
  "SECURITYSESSIONID", "__CF_USER_TEXT_ENCODING", "INIT_CWD",
]);

/** 系统级环境变量前缀（以这些开头的也视为 system） */
const SYSTEM_ENV_PREFIXES = ["NODE_", "npm_", "NPM_", "YARN_", "npm_config_"];

/** 常见技能/频道所需环境变量（recommended 返回的非 provider 部分） */
const COMMON_SKILL_ENV: Array<{ key: string; description: string; required: boolean }> = [
  { key: "GITHUB_TOKEN", description: "GitHub personal access token（GitHub 频道/技能用）", required: false },
  { key: "SLACK_BOT_TOKEN", description: "Slack Bot OAuth token（Slack 频道用）", required: false },
  { key: "SLACK_SIGNING_SECRET", description: "Slack 签名密钥（验证请求来源）", required: false },
  { key: "DISCORD_BOT_TOKEN", description: "Discord Bot token（Discord 频道用）", required: false },
  { key: "TELEGRAM_BOT_TOKEN", description: "Telegram Bot token（Telegram 频道用）", required: false },
  { key: "FEISHU_APP_ID", description: "飞书应用 App ID（飞书频道用）", required: false },
  { key: "FEISHU_APP_SECRET", description: "飞书应用 App Secret", required: false },
  { key: "SENDGRID_API_KEY", description: "SendGrid API key（邮件频道用）", required: false },
  { key: "TWILIO_ACCOUNT_SID", description: "Twilio 账户 SID（SMS 频道用）", required: false },
  { key: "TWILIO_AUTH_TOKEN", description: "Twilio 认证 token", required: false },
];

// ============================================================================
// EnvManager
// ============================================================================

export class EnvManager {
  private readonly dotenvPath: string;

  constructor(opts: EnvManagerOptions = {}) {
    this.dotenvPath = opts.dotenvPath ?? join(process.cwd(), ".env");
    if (opts.autoLoad) this.load();
  }

  // --------------------------------------------------------------------------
  // 公开 API
  // --------------------------------------------------------------------------

  /** 列出所有环境变量（合并 .env 和 process.env） */
  list(): EnvVar[] {
    const dotenvEntries = this.readDotenv();
    const result: EnvVar[] = [];
    const seen = new Set<string>();

    // 1. .env 中的变量（优先展示，来源标记为 dotenv）
    for (const [key, dotenvValue] of dotenvEntries) {
      // 运行时值优先（process.env 可能已被 load 注入或由父进程设置）
      const value = process.env[key] ?? dotenvValue;
      result.push(this.makeEnvVar(key, value, "dotenv"));
      seen.add(key);
    }

    // 2. process.env 中的变量（排除 .env 已覆盖的）
    for (const [key, value] of Object.entries(process.env)) {
      if (seen.has(key) || value === undefined) continue;
      const source = this.isSystemKey(key) ? "system" : "process";
      result.push(this.makeEnvVar(key, value, source));
      seen.add(key);
    }

    return result;
  }

  /** 获取单个值（优先 process.env，回退 .env） */
  get(key: string): string | undefined {
    return process.env[key] ?? this.readDotenv().get(key);
  }

  /** 设置环境变量（写入 .env + 同步到 process.env） */
  set(key: string, value: string): void {
    // 写 .env（保留原有注释与格式，仅修改/追加对应行）
    const lines = this.readDotenvLines();
    const updated = this.setEnvLine(lines, key, value);
    writeFileSync(this.dotenvPath, updated.join("\n") + "\n", "utf8");
    // 同步到 process.env
    process.env[key] = value;
  }

  /** 删除环境变量（从 .env 移除，不删 process.env） */
  unset(key: string): boolean {
    const lines = this.readDotenvLines();
    const filtered = this.unsetEnvLine(lines, key);
    if (filtered.length === lines.length) return false; // 未找到该 key
    writeFileSync(this.dotenvPath, filtered.join("\n") + "\n", "utf8");
    return true;
  }

  /** 探测变量是否敏感（key 含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIALS） */
  isSensitive(key: string): boolean {
    const upper = key.toUpperCase();
    return SENSITIVE_KEYWORDS.some((kw) => upper.includes(kw));
  }

  /** 掩码值：保留前 4 后 2 字符，中间用 **** 替换；少于 8 字符则全 **** */
  mask(value: string): string {
    if (value.length < 8) return "****";
    return value.slice(0, 4) + "****" + value.slice(-2);
  }

  /** 加载 .env 到 process.env（不覆盖已存在的值，与 dotenv 行为一致） */
  load(): void {
    const entries = this.readDotenv();
    for (const [key, value] of entries) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  /** 导出为 JSON（仅 .env 中管理的变量，便于跨机器迁移） */
  exportJSON(): Record<string, string> {
    const entries = this.readDotenv();
    const result: Record<string, string> = {};
    for (const [key, value] of entries) {
      result[key] = value;
    }
    return result;
  }

  /** 从 JSON 批量导入（写入 .env + process.env） */
  importJSON(data: Record<string, string>): void {
    for (const [key, value] of Object.entries(data)) {
      this.set(key, value);
    }
  }

  /** 推荐的环境变量列表（基于 PROVIDER_CATALOG + 常见 skill env） */
  recommended(): Array<{ key: string; description: string; required: boolean; provider?: string }> {
    const results: Array<{ key: string; description: string; required: boolean; provider?: string }> = [];

    // 1. 从 PROVIDER_CATALOG 提取所有 envKey
    for (const p of PROVIDER_CATALOG) {
      results.push({
        key: p.envKey,
        description: `${p.name} API key${p.description ? ` — ${p.description}` : ""}`,
        required: !p.local,
        provider: p.id,
      });
    }

    // 2. 追加常见技能/频道环境变量（跳过与 provider 重复的 key）
    for (const e of COMMON_SKILL_ENV) {
      if (results.some((r) => r.key === e.key)) continue;
      results.push(e);
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /** 读取 .env 文件内容，返回有序键值对 */
  private readDotenv(): Map<string, string> {
    if (!existsSync(this.dotenvPath)) return new Map();
    let content: string;
    try {
      content = readFileSync(this.dotenvPath, "utf8");
    } catch {
      return new Map();
    }
    return this.parseDotenv(content);
  }

  /** 读取 .env 原始行（保留注释与空行，用于增量修改） */
  private readDotenvLines(): string[] {
    if (!existsSync(this.dotenvPath)) return [];
    try {
      return readFileSync(this.dotenvPath, "utf8").split("\n");
    } catch {
      return [];
    }
  }

  /** 解析 .env 内容为有序 Map（支持引号、# 注释、export 前缀） */
  private parseDotenv(content: string): Map<string, string> {
    const map = new Map<string, string>();
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // 支持 export 前缀
      const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
      const eqIdx = withoutExport.indexOf("=");
      if (eqIdx < 0) continue;
      const key = withoutExport.slice(0, eqIdx).trim();
      if (!key) continue;
      let value = withoutExport.slice(eqIdx + 1).trim();
      // 去引号（单引号或双引号）
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      map.set(key, value);
    }
    return map;
  }

  /** 在行列表中设置/更新一个 key（保留其他行不变） */
  private setEnvLine(lines: string[], key: string, value: string): string[] {
    const prefix = `${key}=`;
    const exportPrefix = `export ${key}=`;
    const formatted = `${key}=${this.formatValue(value)}`;
    const idx = lines.findIndex((l) => {
      const t = l.trim();
      return t.startsWith(prefix) || t.startsWith(exportPrefix);
    });
    if (idx >= 0) {
      const copy = [...lines];
      copy[idx] = formatted;
      return copy;
    }
    // 追加新行（确保前面有空行分隔）
    const result = [...lines];
    if (result.length > 0 && result[result.length - 1] !== "") {
      result.push("");
    }
    result.push(formatted);
    return result;
  }

  /** 从行列表中移除一个 key */
  private unsetEnvLine(lines: string[], key: string): string[] {
    const prefix = `${key}=`;
    const exportPrefix = `export ${key}=`;
    return lines.filter((l) => {
      const t = l.trim();
      return !t.startsWith(prefix) && !t.startsWith(exportPrefix);
    });
  }

  /** 格式化 .env 值（含空格或特殊字符时加双引号） */
  private formatValue(value: string): string {
    if (value === "") return "";
    if (/[\s#"']/.test(value)) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  /** 判断 key 是否为系统级环境变量 */
  private isSystemKey(key: string): boolean {
    if (SYSTEM_ENV_KEYS.has(key)) return true;
    return SYSTEM_ENV_PREFIXES.some((p) => key.startsWith(p));
  }

  /** 构建 EnvVar 对象 */
  private makeEnvVar(
    key: string,
    value: string,
    source: "dotenv" | "process" | "system",
  ): EnvVar {
    const sensitive = this.isSensitive(key);
    return {
      key,
      value,
      source,
      sensitive,
      masked: sensitive ? this.mask(value) : value,
      configured: value !== "",
    };
  }
}
