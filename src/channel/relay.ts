/**
 * Relay 路由器 —— 跨 channel 消息转发
 *
 * 设计（对标多平台 Bot 框架的消息路由）：
 * - 支持 channel 间多对多转发（Discord → Slack, Telegram → Email, 任意 → 任意）
 * - 支持过滤规则（关键词/正则/发送者白名单）
 * - 支持转换规则（添加前缀/格式化）
 * - 规则可动态增删、启用/禁用
 * - 配置可持久化到 JSON 文件
 *
 * 使用：
 *   const relay = new RelayRouter(config, channels);
 *   relay.route({ channel: "discord", sessionId: "s1", userId: "u1", text: "hello" });
 */

import { readFileSync, writeFileSync } from "node:fs";

/** 单条转发规则 */
export interface RelayRule {
  /** 规则 ID */
  id: string;
  /** 源 channel 名 */
  from: string;
  /** 目标 channel 名列表 */
  to: string[];
  /** 关键词过滤（任一匹配即转发） */
  keywords?: string[];
  /** 正则过滤 */
  pattern?: string;
  /** 发送者白名单 */
  fromUsers?: string[];
  /** 添加前缀 */
  prefix?: string;
  /** 是否启用 */
  enabled: boolean;
}

/** Relay 配置 */
export interface RelayConfig {
  rules: RelayRule[];
  /** 是否记录转发日志 */
  log?: boolean;
}

/** route() 返回结果 */
export interface RelayRouteResult {
  /** 成功转发的目标 channel 名 */
  forwarded: string[];
  /** 是否跳过（无匹配规则或被过滤） */
  skipped: boolean;
  /** 跳过原因 */
  reason?: string;
}

/** channel 最小接口：只要有 reply 方法即可 */
export interface RelayableChannel {
  reply: (sessionId: string, msg: { text: string }) => Promise<void>;
}

export class RelayRouter {
  private config: RelayConfig;
  private channels: Map<string, RelayableChannel>;

  constructor(config: RelayConfig, channels: Map<string, RelayableChannel>) {
    this.config = config;
    this.channels = channels;
  }

  /**
   * 处理来自某 channel 的事件，按规则转发
   *
   * 遍历所有匹配 from 的规则，对每条规则检查关键词/正则/发送者过滤，
   * 通过后对每个 to channel 调用 channel.reply()。
   * 失败的转发记录到日志，不影响其他转发。
   */
  async route(event: { channel: string; sessionId: string; userId: string; text: string }): Promise<RelayRouteResult> {
    const { channel, sessionId, userId, text } = event;

    // 找到所有匹配源 channel 的规则
    const matched = this.config.rules.filter(
      (r) => r.from === channel && r.enabled,
    );

    if (matched.length === 0) {
      return { forwarded: [], skipped: true, reason: `无匹配规则: from=${channel}` };
    }

    const forwarded: string[] = [];

    for (const rule of matched) {
      // 检查发送者白名单
      if (rule.fromUsers && rule.fromUsers.length > 0) {
        if (!rule.fromUsers.includes(userId)) {
          if (this.config.log) {
            console.log(`[relay] 规则 ${rule.id}: 用户 ${userId} 不在白名单，跳过`);
          }
          continue;
        }
      }

      // 检查关键词过滤（任一匹配即转发）
      if (rule.keywords && rule.keywords.length > 0) {
        const matchedKeyword = rule.keywords.some((kw) => text.includes(kw));
        if (!matchedKeyword) {
          if (this.config.log) {
            console.log(`[relay] 规则 ${rule.id}: 无关键词匹配，跳过`);
          }
          continue;
        }
      }

      // 检查正则过滤
      if (rule.pattern) {
        try {
          const re = new RegExp(rule.pattern);
          if (!re.test(text)) {
            if (this.config.log) {
              console.log(`[relay] 规则 ${rule.id}: 正则 ${rule.pattern} 不匹配，跳过`);
            }
            continue;
          }
        } catch (err) {
          if (this.config.log) {
            console.log(`[relay] 规则 ${rule.id}: 正则语法错误 ${rule.pattern}`, err);
          }
          continue;
        }
      }

      // 通过所有过滤，执行转发
      const outText = rule.prefix ? `${rule.prefix}${text}` : text;

      for (const targetName of rule.to) {
        const targetChannel = this.channels.get(targetName);
        if (!targetChannel) {
          if (this.config.log) {
            console.log(`[relay] 目标 channel "${targetName}" 不存在，跳过`);
          }
          continue;
        }
        try {
          await targetChannel.reply(sessionId, { text: outText });
          forwarded.push(targetName);
          if (this.config.log) {
            console.log(`[relay] 转发成功: ${channel} → ${targetName} (规则 ${rule.id})`);
          }
        } catch (err) {
          // 失败的转发记录日志，不影响其他
          if (this.config.log) {
            console.log(`[relay] 转发失败: ${channel} → ${targetName} (规则 ${rule.id}):`, err);
          }
        }
      }
    }

    return {
      forwarded,
      skipped: forwarded.length === 0,
      reason: forwarded.length === 0 ? "所有规则被过滤或目标不可达" : undefined,
    };
  }

  /** 添加规则 */
  addRule(rule: RelayRule): void {
    this.config.rules.push(rule);
  }

  /** 删除规则 */
  removeRule(id: string): boolean {
    const idx = this.config.rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.config.rules.splice(idx, 1);
    return true;
  }

  /** 列出规则 */
  listRules(): RelayRule[] {
    return [...this.config.rules];
  }

  /** 启用/禁用规则 */
  toggleRule(id: string, enabled: boolean): void {
    const rule = this.config.rules.find((r) => r.id === id);
    if (rule) rule.enabled = enabled;
  }

  /** 从文件加载配置 */
  static loadFromFile(path: string): RelayConfig {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as RelayConfig;
  }

  /** 保存配置到文件 */
  static saveToFile(path: string, config: RelayConfig): void {
    writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  }
}
